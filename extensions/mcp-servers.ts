import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function packageRoot() {
  return process.env.GUSTAVE_PACKAGE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

// Register the servers Gustave bundles for the current session (see pi docs/mcp.md).
// These are session-scoped registrations, not written to mcp.json, so a user entry
// of the same name in mcp.json takes precedence. Users add their own servers with
// `gustave mcp add ...` / `~/.pi/agent/mcp.json` and manage everything from `/mcp`.
export default function mcpServersExtension(pi: ExtensionAPI) {
  const root = packageRoot();
  const nodeBin = process.execPath;
  const registered = new Set(pi.getMcpServers().map((server) => server.name));

  const register = (name: string, config: Parameters<ExtensionAPI["registerMcpServer"]>[1]) => {
    if (registered.has(name)) return;
    pi.registerMcpServer(name, config);
    registered.add(name);
  };

  // Official Svelte MCP (4 tools). Prefer the bundled stdio server so it works
  // offline and deterministically; fall back to the hosted HTTP endpoint.
  const svelteStdio = join(root, "node_modules", "@sveltejs", "mcp", "dist", "index.mjs");
  if (existsSync(svelteStdio)) {
    register("svelte", { command: nodeBin, args: [svelteStdio], exposure: "direct" });
  } else {
    register("svelte", { url: "https://mcp.svelte.dev/mcp", exposure: "direct" });
  }

  // agent-browser MCP (29 tools). Keep them out of the default tool declarations
  // and let the model load what it needs on demand via tool_search.
  const agentBrowser = join(root, "node_modules", "agent-browser", "bin", "agent-browser.js");
  if (existsSync(agentBrowser)) {
    register("agent-browser", { command: nodeBin, args: [agentBrowser, "mcp"], exposure: "deferred" });
  }
}
