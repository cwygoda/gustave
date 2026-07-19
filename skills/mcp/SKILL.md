---
name: mcp
description: Access Model Context Protocol servers through MCPorter, including the bundled official Svelte MCP and agent-browser MCP. Use when the user asks for MCP tools, Svelte docs/autofixes, or browser automation via MCP.
---

# MCP via MCPorter

Gustave bundles MCPorter and exposes these tools:

- `mcp_list` — list configured MCP servers/tools.
- `mcp_call` — call any MCP tool with target `server.tool`.
- `svelte_mcp` — convenience wrapper for the official Svelte MCP.

Preconfigured servers:

- `svelte` — `https://mcp.svelte.dev/mcp`
- `agent-browser` — local `agent-browser mcp` stdio server, when the dependency is installed

Examples:

- List Svelte tools: `mcp_list({ "server": "svelte" })`
- List Svelte sections: `svelte_mcp({ "tool": "list-sections" })`
- Fetch Svelte docs: `svelte_mcp({ "tool": "get-documentation", "args": { "section": "..." } })`
- Browser snapshot: call `mcp_list({ "server": "agent-browser" })` first, then use `mcp_call` with the relevant `agent-browser.*` tool.

Use `gustave mcporter ...` in bash for direct CLI access.
