---
name: agentbrowser
description: Browser automation with the bundled agent-browser CLI or MCP server. Use for opening pages, snapshots, clicking/filling, screenshots, rendered DOM reads, or browser-based testing.
---

# agent-browser

Gustave bundles `agent-browser` and exposes it two ways:

1. Direct CLI through the absolute Gustave wrapper:

```bash
gustave agent-browser --version
gustave agent-browser install
gustave agent-browser open https://example.com
gustave agent-browser snapshot
gustave agent-browser click @e2
gustave agent-browser screenshot page.png
gustave agent-browser close
```

2. MCP through MCPorter:

- Use `mcp_list({ "server": "agent-browser" })`.
- Then call tools with `mcp_call`, e.g. `agent-browser.agent_browser_snapshot`.

Guidelines:

- Prefer snapshots and element refs for token-efficient automation.
- Ask before logging into accounts or handling sensitive sessions.
- Run `gustave agent-browser install` once if Chrome for Testing is missing.
