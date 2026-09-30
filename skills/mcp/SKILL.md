---
name: mcp
description: Access Model Context Protocol servers through pi's built-in MCP support, including the bundled official Svelte MCP and agent-browser MCP. Use when the user asks for MCP tools, Svelte docs/autofixes, or browser automation via MCP.
---

# MCP (built into pi)

Pi connects to MCP servers over stdio or streamable HTTP and exposes their tools
directly as `mcp__<server>__<tool>`. Gustave preconfigures two servers per session
(via an extension, so they are not written to `mcp.json`):

- `svelte` — official Svelte MCP. Exposure `direct`, so its 4 tools are declared to
  the model: `mcp__svelte__list-sections`, `mcp__svelte__get-documentation`,
  `mcp__svelte__svelte-autofixer`, `mcp__svelte__playground-link`.
- `agent-browser` — local `agent-browser mcp` stdio server (29 tools). Exposure
  `deferred`: the tools are not declared up front. Use the `tool_search` tool to
  load the ones you need, then call them directly (e.g. `mcp__agent-browser__snapshot`).

## Using the servers

- Svelte docs: call `mcp__svelte__list-sections`, then `mcp__svelte__get-documentation`.
- Browser: run `tool_search` for the browser action you want (e.g. "snapshot",
  "click"), then call the returned `mcp__agent-browser__*` tool. The `agent-browser`
  CLI is usually simpler for interactive automation — see the `agentbrowser` skill.

## Managing servers

Inside a session:

- `/mcp` — server manager: state, tools, exposure, reconnect, sign in/out, enable/disable.

From a shell (these manage the user's own `~/.pi/agent/mcp.json`; Gustave's bundled
servers are session-only and appear in `/mcp`, not here):

```bash
gustave mcp list                 # connect to configured servers and print status
gustave mcp add <name> -- <cmd> [args...]   # add a stdio server
gustave mcp add <name> --url <url>          # add a streamable HTTP server
gustave mcp remove <name>
gustave mcp login <name>         # OAuth sign-in
```

Add servers written for other agents (Cursor, Claude, Codex, VS Code, opencode) by
copying/converting their entries into `~/.pi/agent/mcp.json` (see pi's `docs/mcp.md`).
After changing servers, run `/reload` or start a new session.
