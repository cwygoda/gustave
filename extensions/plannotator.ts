import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function checkbox(done: boolean, text: string) {
  return `- [${done ? "x" : " "}] ${text}`;
}

export default function plannotatorExtension(pi: ExtensionAPI) {
  let defaultPlanFile = "PLAN.md";

  pi.registerCommand("planfile", {
    description: "Show or set the default plan annotation file",
    handler: async (args, ctx) => {
      const next = args.trim();
      if (next) defaultPlanFile = next;
      ctx.ui.notify(`Plan annotations will use ${defaultPlanFile}`, "info");
    },
  });

  pi.registerTool({
    name: "plan_annotate",
    label: "Annotate Plan",
    description: "Append or replace a markdown plan section with checklist items and status notes.",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Plan file path. Defaults to PLAN.md or /planfile value." })),
      title: Type.String({ description: "Plan section title." }),
      summary: Type.Optional(Type.String({ description: "Short plan summary or current status." })),
      items: Type.Optional(
        Type.Array(
          Type.Object({
            text: Type.String(),
            done: Type.Optional(Type.Boolean({ default: false })),
          })
        )
      ),
      mode: Type.Optional(Type.Union([Type.Literal("append"), Type.Literal("replace")], { default: "append" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const file = resolve(ctx.cwd, String(params.file ?? defaultPlanFile));
      const title = String(params.title ?? "Plan");
      const markerStart = `<!-- gustave-plan:${title} -->`;
      const markerEnd = `<!-- /gustave-plan:${title} -->`;
      const now = new Date().toISOString();
      const lines = [markerStart, `## ${title}`, "", `Updated: ${now}`];
      if (params.summary) lines.push("", String(params.summary));
      const items = (params.items ?? []) as Array<{ text: string; done?: boolean }>;
      if (items.length) {
        lines.push("", ...items.map((item) => checkbox(Boolean(item.done), item.text)));
      }
      lines.push(markerEnd, "");
      const block = lines.join("\n");

      const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
      let next = existing;
      if (params.mode === "replace" && existing.includes(markerStart) && existing.includes(markerEnd)) {
        const before = existing.slice(0, existing.indexOf(markerStart));
        const after = existing.slice(existing.indexOf(markerEnd) + markerEnd.length).replace(/^\s*\n?/, "\n");
        next = `${before}${block}${after}`;
      } else {
        next = `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${block}`;
      }
      writeFileSync(file, next);
      return {
        content: [{ type: "text", text: `Annotated ${file}` }],
        details: { file, title, itemCount: items.length },
      };
    },
  });

  pi.registerTool({
    name: "plan_read",
    label: "Read Plan",
    description: "Read the current markdown plan file.",
    parameters: Type.Object({ file: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const file = resolve(ctx.cwd, String(params.file ?? defaultPlanFile));
      if (!existsSync(file))
        return { content: [{ type: "text", text: `${file} does not exist.` }], details: { file, exists: false } };
      return { content: [{ type: "text", text: readFileSync(file, "utf8") }], details: { file, exists: true } };
    },
  });
}
