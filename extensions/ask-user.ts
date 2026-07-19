import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface AskOption {
  title: string;
  description?: string;
}

export default function askUserExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the human exactly one focused question. Use before high-stakes decisions, irreversible changes, or ambiguous requirements.",
    parameters: Type.Object({
      question: Type.String({ description: "One focused question to ask the user." }),
      context: Type.Optional(Type.String({ description: "Short context summary shown before the question." })),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String(),
            description: Type.Optional(Type.String()),
          })
        )
      ),
      allowFreeform: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return {
          content: [
            {
              type: "text",
              text: "Cannot ask the user: this pi run has no interactive UI. Make a conservative assumption or stop and explain what input is needed.",
            },
          ],
          details: { available: false },
        };
      }

      const question = String(params.question ?? "");
      const context = params.context ? `${params.context}\n\n` : "";
      const options = (params.options ?? []) as AskOption[];

      let answer: string | undefined;
      if (options.length > 0) {
        const labels = options.map((option) =>
          option.description ? `${option.title} — ${option.description}` : option.title
        );
        const choice = await ctx.ui.select(`${context}${question}`, labels);
        if (choice !== undefined) {
          answer = String(choice);
        }
      }

      if (!answer && params.allowFreeform !== false) {
        answer = await ctx.ui.input("Gustave needs input", `${context}${question}`);
      }

      if (!answer) {
        return {
          content: [{ type: "text", text: "The user did not provide an answer." }],
          details: { cancelled: true },
        };
      }

      return {
        content: [{ type: "text", text: answer }],
        details: { answer },
      };
    },
  });
}
