import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function gustaveUiExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("gustave", "ready");
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("gustave", "thinking");
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("gustave", "ready");
  });

  pi.registerCommand("gustave", {
    description: "Show Gustave distribution info",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Gustave is loaded. Config files: ${process.env.GUSTAVE_CONFIG_FILES || "none"}`, "info");
    },
  });

  pi.registerCommand("builtin-ui", {
    description: "Show how to toggle Gustave's bundled powerline UI",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Gustave now uses pi-powerline-footer. Use /powerline toggle to switch it on or off.", "info");
    },
  });
}
