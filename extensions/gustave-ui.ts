import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function logo(theme: Theme): string[] {
  const a = (s: string) => theme.fg("accent", s);
  const m = (s: string) => theme.fg("muted", s);
  const d = (s: string) => theme.fg("dim", s);
  return [
    "",
    a("   ______           __                  "),
    a("  / ____/_  _______/ /_____ __   _____ "),
    a(" / / __/ / / / ___/ __/ __ `/ | / / _ \\"),
    a("/ /_/ / /_/ (__  ) /_/ /_/ /| |/ /  __/"),
    a("\\____/\\__,_/____/\\__/\\__,_/ |___/\\___/ ") + d("  based on pi"),
    m(`  curated coding agent • pi ${VERSION}`),
  ];
}

function segment(theme: Theme, text: string, fg: string, bg: string) {
  return theme.bg(bg as any, theme.fg(fg as any, ` ${text} `));
}

function sep(theme: Theme) {
  return theme.fg("accent", "");
}

function fmt(n: number) {
  if (!Number.isFinite(n)) return "0";
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

export default function gustaveUiExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        return logo(theme).map((line) => truncateToWidth(line, width));
      },
      invalidate() {},
    }));

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          let input = 0;
          let output = 0;
          let cost = 0;
          for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const message = entry.message as AssistantMessage;
              input += message.usage?.input ?? 0;
              output += message.usage?.output ?? 0;
              cost += message.usage?.cost?.total ?? 0;
            }
          }

          const branch = footerData.getGitBranch();
          const left = [
            segment(theme, `Gustave`, "text", "toolPendingBg"),
            sep(theme),
            segment(theme, ctx.cwd.replace(process.env.HOME ?? "", "~"), "text", "customMessageBg"),
            sep(theme),
            branch ? segment(theme, ` ${branch}`, "text", "toolSuccessBg") + sep(theme) : "",
          ].join("");
          const rightText = `${ctx.model?.id ?? "no-model"}  ↑${fmt(input)} ↓${fmt(output)}  $${cost.toFixed(3)}`;
          const right = theme.fg("dim", rightText);
          const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
          return [truncateToWidth(left + pad + right, width)];
        },
      };
    });

    ctx.ui.setStatus("gustave", ctx.ui.theme.fg("accent", "◆") + ctx.ui.theme.fg("dim", " ready"));
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (ctx.mode === "tui")
      ctx.ui.setStatus("gustave", ctx.ui.theme.fg("accent", "◆") + ctx.ui.theme.fg("muted", " thinking"));
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.mode === "tui")
      ctx.ui.setStatus("gustave", ctx.ui.theme.fg("success", "◆") + ctx.ui.theme.fg("dim", " ready"));
  });

  pi.registerCommand("gustave", {
    description: "Show Gustave distribution info",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Gustave is loaded. Config files: ${process.env.GUSTAVE_CONFIG_FILES || "none"}`, "info");
    },
  });

  pi.registerCommand("builtin-ui", {
    description: "Restore pi's built-in header and footer for this session",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("Restored built-in pi UI", "info");
    },
  });
}
