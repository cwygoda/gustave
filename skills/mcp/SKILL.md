---
name: mcp
description: Access Model Context Protocol servers through pi's built-in MCP support, including the preconfigured official Svelte MCP. Use when the user asks for MCP tools or Svelte docs/autofixes.
---

# MCP (built into pi)

Pi connects to MCP servers over stdio or streamable HTTP and exposes their tools
directly as `mcp__<server>__<tool>`. Gustave preconfigures the official hosted
Svelte MCP server in its agent `mcp.json` with `codemode` exposure.

For Svelte documentation, call the server from codemode: discover the needed
`mcp__svelte__*` tools, then invoke them directly.

## Managing servers

Inside a session:

- `/mcp` — server manager: state, tools, exposure, reconnect, sign in/out, enable/disable.

From a shell (these manage Gustave's agent `mcp.json`):

```bash
gustave mcp list                 # connect to configured servers and print status
gustave mcp add <name> -- <cmd> [args...]   # add a stdio server
gustave mcp add <name> --url <url>          # add a streamable HTTP server
gustave mcp remove <name>
gustave mcp login <name>         # OAuth sign-in
```

Add servers written for other agents (Cursor, Claude, Codex, VS Code, opencode) by
copying/converting their entries into `~/.gustave/agent/mcp.json` (see pi's `docs/mcp.md`).
After changing servers, run `/reload` or start a new session.
