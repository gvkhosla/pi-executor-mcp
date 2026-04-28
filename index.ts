import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type McpCallResult = {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

const EXECUTOR_EXECUTE_DESCRIPTION = `Execute TypeScript in Executor's MCP runtime with access to configured API tools.

Typical workflow inside code:
1. const matches = await tools.search({ query: "<intent>", limit: 12 });
2. const detail = await tools.describe.tool({ path: matches[0].path });
3. const result = await tools.<namespace>.<path>(input);

Useful calls:
- await tools.search({ query: "github issues", limit: 5 })
- await tools.executor.sources.list()
- await tools.describe.tool({ path: "namespace.resource.method" })

Rules:
- Do not use fetch; call APIs through tools.*.
- Always include the namespace when calling configured tools.
- Return the final value from the TypeScript code.`;

function renderMcpResult(result: McpCallResult): string {
  const parts: string[] = [];

  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else {
      parts.push(JSON.stringify(block, null, 2));
    }
  }

  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }

  if (parts.length === 0) {
    parts.push(JSON.stringify(result, null, 2));
  }

  return parts.join("\n");
}

export default function executorMcpExtension(pi: ExtensionAPI) {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let connecting: Promise<Client> | undefined;
  let lastStderr = "";

  async function disconnect() {
    const current = client;
    client = undefined;
    transport = undefined;
    connecting = undefined;
    if (current) {
      try {
        await current.close();
      } catch {
        // Ignore shutdown errors.
      }
    }
  }

  async function connect(): Promise<Client> {
    if (client) return client;
    if (connecting) return connecting;

    connecting = (async () => {
      const nextClient = new Client({ name: "pi-executor-mcp", version: "1.0.0" });
      const nextTransport = new StdioClientTransport({
        command: "executor",
        args: ["mcp"],
        stderr: "pipe",
      });

      nextTransport.stderr?.on("data", (chunk) => {
        lastStderr = `${lastStderr}${chunk.toString()}`.slice(-4000);
      });
      nextTransport.onerror = (error) => {
        lastStderr = `${lastStderr}\n${error.message}`.slice(-4000);
      };
      nextTransport.onclose = () => {
        client = undefined;
        transport = undefined;
        connecting = undefined;
      };

      await nextClient.connect(nextTransport);
      client = nextClient;
      transport = nextTransport;
      return nextClient;
    })();

    try {
      return await connecting;
    } catch (error) {
      connecting = undefined;
      throw error;
    }
  }

  async function callExecutorTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const c = await connect();
    const result = (await c.callTool(
      { name, arguments: args },
      undefined,
      { signal } as never,
    )) as McpCallResult;

    const text = renderMcpResult(result);
    if (result.isError) {
      throw new Error(text);
    }

    return {
      content: [{ type: "text" as const, text }],
      details: result,
    };
  }

  function executeCode(code: string, signal?: AbortSignal) {
    return callExecutorTool("execute", { code }, signal);
  }

  function asJson(value: unknown) {
    return JSON.stringify(value).replaceAll("</", "<\\/");
  }

  pi.registerTool({
    name: "executor_sources",
    label: "Executor Sources",
    description: "List configured Executor sources and tool counts.",
    promptSnippet: "List configured Executor sources and tool counts.",
    promptGuidelines: [
      "Use executor_sources before executor_search when you need to understand what integrations are configured in Executor.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return executeCode("return await tools.executor.sources.list();", signal);
    },
  });

  pi.registerTool({
    name: "executor_search",
    label: "Executor Search",
    description: "Search Executor's configured tools by natural-language query.",
    promptSnippet: "Search Executor's configured tools by intent or namespace.",
    promptGuidelines: [
      "Use executor_search to find an Executor tool before writing executor_execute TypeScript for unfamiliar APIs.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Natural-language search query, e.g. 'github issues'." }),
      namespace: Type.Optional(Type.String({ description: "Optional Executor namespace to narrow search." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Maximum number of matches. Defaults to 10." })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = {
        query: params.query,
        ...(params.namespace ? { namespace: params.namespace } : {}),
        limit: params.limit ?? 10,
      };
      return executeCode(`return await tools.search(${asJson(args)});`, signal);
    },
  });

  pi.registerTool({
    name: "executor_describe",
    label: "Executor Describe",
    description: "Describe an Executor tool's TypeScript and JSON schema by path.",
    promptSnippet: "Inspect an Executor tool schema before calling it.",
    promptGuidelines: [
      "Use executor_describe after executor_search and before executor_execute when you need a tool's exact input shape.",
    ],
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "Executor tool path, e.g. 'github.issues.create'." }),
    }),
    async execute(_toolCallId, params, signal) {
      return executeCode(`return await tools.describe.tool({ path: ${asJson(params.path)} });`, signal);
    },
  });

  pi.registerTool({
    name: "executor_execute",
    label: "Executor Execute",
    description: EXECUTOR_EXECUTE_DESCRIPTION,
    promptSnippet: "Run Executor MCP TypeScript to discover and call configured API tools.",
    promptGuidelines: [
      "Use executor_execute when the user asks to use an external integration/tool configured in Executor.",
      "In executor_execute code, discover tools with tools.search(...) or tools.executor.sources.list() before calling an unfamiliar API tool.",
    ],
    parameters: Type.Object({
      code: Type.String({
        minLength: 1,
        description: "TypeScript code to run in Executor's sandbox. Return the final value.",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      return executeCode(params.code, signal);
    },
  });

  pi.registerTool({
    name: "executor_resume",
    label: "Executor Resume",
    description:
      "Resume a paused Executor MCP execution. Never call this without user approval unless they explicitly state otherwise.",
    promptSnippet: "Resume a paused Executor MCP execution after auth or approval.",
    promptGuidelines: [
      "Use executor_resume only for paused Executor executions and only after the user approves the resume action.",
    ],
    parameters: Type.Object({
      executionId: Type.String({ description: "Execution ID from the paused Executor result." }),
      action: Type.Unsafe<"accept" | "decline" | "cancel">({
        type: "string",
        enum: ["accept", "decline", "cancel"],
        description: "How to respond to the paused Executor interaction.",
      }),
      content: Type.Optional(
        Type.String({
          default: "{}",
          description: "Optional JSON-encoded response content for form elicitations.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      return callExecutorTool(
        "resume",
        {
          executionId: params.executionId,
          action: params.action,
          content: params.content ?? "{}",
        },
        signal,
      );
    },
  });

  pi.registerCommand("executor-search", {
    description: "Search Executor tools by natural-language query",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify('Usage: /executor-search <query>  e.g. /executor-search github issues', "warning");
        return;
      }

      try {
        const result = await executeCode(
          `return await tools.search({ query: ${asJson(query)}, limit: 10 });`,
        );
        ctx.ui.notify(`Executor search results for "${query}":\n${result.content[0].text}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Executor search failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("executor-describe", {
    description: "Describe an Executor tool by path",
    handler: async (args, ctx) => {
      const path = args.trim();
      if (!path) {
        ctx.ui.notify('Usage: /executor-describe <tool.path>  e.g. /executor-describe github.issues.create', "warning");
        return;
      }

      try {
        const result = await executeCode(
          `return await tools.describe.tool({ path: ${asJson(path)} });`,
        );
        ctx.ui.notify(`Executor tool ${path}:\n${result.content[0].text}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Executor describe failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("executor-status", {
    description: "Check the Executor MCP connection and configured source list",
    handler: async (_args, ctx) => {
      try {
        const result = await executeCode("return await tools.executor.sources.list();");
        ctx.ui.notify(`Executor MCP connected:\n${result.content[0].text}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `Executor MCP failed: ${message}${lastStderr ? `\n\nRecent stderr:\n${lastStderr}` : ""}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("executor-restart", {
    description: "Restart the Executor MCP child process used by pi",
    handler: async (_args, ctx) => {
      await disconnect();
      lastStderr = "";
      try {
        await connect();
        ctx.ui.notify("Executor MCP restarted.", "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Executor MCP restart failed: ${message}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Connect lazily in non-interactive modes; in the TUI, give immediate feedback if it is broken.
    if (!ctx.hasUI) return;
    try {
      await connect();
      ctx.ui.setStatus("executor-mcp", "executor:mcp");
    } catch {
      ctx.ui.setStatus("executor-mcp", "executor:mcp offline");
    }
  });

  pi.on("session_shutdown", async () => {
    await disconnect();
  });
}
