import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Register the servers Gustave bundles for the current session (see pi docs/mcp.md).
// These are session-scoped registrations, not written to mcp.json, so a user entry
// of the same name in mcp.json takes precedence. Users add their own servers with
// `pi mcp add ...` or `gustave mcp add ...` and manage everything from `/mcp`.
export default function mcpServersExtension(pi: ExtensionAPI) {
  const registered = new Set(pi.getMcpServers().map((server) => server.name));

  const register = (name: string, config: Parameters<ExtensionAPI["registerMcpServer"]>[1]) => {
    if (registered.has(name)) return;
    pi.registerMcpServer(name, config);
    registered.add(name);
  };

  register("svelte", { url: "https://mcp.svelte.dev/mcp", exposure: "codemode" });
}
