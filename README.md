# pi-executor-mcp

Unofficial [Pi](https://pi.dev) extension that connects Pi to [Executor](https://executor.sh) through Executor's MCP server.

Pi does not ship a built-in MCP client. This package adds a small bridge so Pi can use Executor's shared tool catalog from normal Pi conversations.

## What it adds

Tools available to the Pi agent:

- `executor_sources` — list configured Executor sources and tool counts.
- `executor_search` — search Executor's configured tools by natural-language query.
- `executor_describe` — inspect an Executor tool's TypeScript/JSON schema by path.
- `executor_execute` — run TypeScript in Executor's MCP runtime with access to your configured Executor tools.
- `executor_resume` — resume a paused Executor execution after auth/approval.

Slash commands:

- `/executor-status` — verify the bridge and list configured Executor sources.
- `/executor-search <query>` — search Executor tools without spending a model turn.
- `/executor-describe <tool.path>` — inspect a tool schema without spending a model turn.
- `/executor-restart` — restart the child `executor mcp` process used by Pi.

## Requirements

- Pi installed and working.
- Executor installed and on your `PATH`:

```bash
npm install -g executor
```

- At least one Executor source configured if you want to call real external tools.

Open Executor's UI to add sources:

```bash
executor web
```

## Install

From GitHub:

```bash
pi install git:github.com/gvkhosla/pi-executor-mcp
```

Or try without installing:

```bash
pi -e git:github.com/gvkhosla/pi-executor-mcp
```

If Pi is already running after installation, reload resources:

```text
/reload
```

## Test

In Pi:

```text
/executor-status
```

You should see the Executor MCP connection and your configured Executor sources.

Search tools directly from Pi:

```text
/executor-search github issues
```

Inspect a matching tool path:

```text
/executor-describe github.issues.create
```

## Example prompts

```text
Use Executor to list my configured sources.
```

```text
Use Executor to search for tools related to GitHub issues.
```

```text
Use Executor to inspect the schema for the best matching calendar event creation tool.
```

## How the bridge works

Executor's MCP server exposes a generic `execute` tool. This extension wraps it with convenience tools for common discovery steps (`executor_sources`, `executor_search`, `executor_describe`) plus the lower-level `executor_execute` escape hatch.

Inside `executor_execute`, the model runs TypeScript like:

```ts
const matches = await tools.search({ query: "github issues", limit: 5 });
const detail = await tools.describe.tool({ path: matches[0].path });
return await tools.github.issues.list({ owner: "octocat", repo: "Hello-World" });
```

The exact available namespaces depend on what you configured in Executor.

## Security

This extension spawns `executor mcp` and lets the Pi agent run Executor TypeScript snippets that can call your configured Executor tools.

Only install this if you trust:

1. this extension,
2. your Pi model/session,
3. the Executor sources and auth you configure.

Executor tools may be able to read, create, update, or delete data in connected services depending on your source configuration.

## Known limitations

- This is an experimental bridge, not official Pi MCP support.
- Executor tools are still ultimately called through Executor's generic MCP `execute` tool, not one Pi tool per Executor integration.
- Paused executions require explicit resume through `executor_resume`.
- Rich auth/elicitation UI is minimal right now.
- Custom Executor binary path/scope settings are not exposed yet.

## Development

```bash
npm install
npm run typecheck
pi -e .
```

## License

MIT
