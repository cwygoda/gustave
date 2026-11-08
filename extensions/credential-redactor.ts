// Credential Redactor Extension
// Redacts accidental secret output and blocks explicit credential-export commands
// that CC Safety Net intentionally allows.

import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

type TextPart = { type: "text"; text: string; [key: string]: unknown };

const blockedCommandPatterns = [
  /\bgh\b[^\n;|&]*\bauth\s+token\b/i,
  /\baws\b[^\n;|&]*\bconfigure\s+export-credentials\b/i,
  /\baws\b[^\n;|&]*\bconfigure\s+get\s+(?:profile\.[\w-]+\.)?(aws_access_key_id|aws_secret_access_key|aws_session_token)\b/i,
  /\bsecurity\b[^\n;|&]*\bfind-(generic|internet)-password\b[^\n;|&]*(?:^|\s)-w(?:\s|$)/i,
];

const credentialKey = `["']?(?:(?:aws_)?(?:secret_access_key|session_token|access_key_id)|SecretAccessKey|SessionToken|AccessKeyId|token|access_token|refresh_token|id_token|password|passwd|secret|api[_-]?key)["']?`;

const secretRedactions: Array<[RegExp, string]> = [
  [/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY_ID]"],
  [/\b(?:xox[baprs]-)[A-Za-z0-9-]{20,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]"],
  [new RegExp(`(${credentialKey}\\s*[=:]\\s*)(["'])([^\\r\\n]*?)\\2`, "gi"), "$1$2[REDACTED]$2"],
  [new RegExp(`(${credentialKey}\\s*[=:]\\s*)([^\\s"',}\\]]+)`, "gi"), "$1[REDACTED]"],
  [new RegExp(`^(\\s*${credentialKey}\\s+).+$`, "gim"), "$1[REDACTED]"],
  [/((?:authorization)\s*:\s*bearer\s+)(["'])([^\r\n]*?)\2/gi, "$1$2[REDACTED]$2"],
  [/((?:authorization)\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
];

export function redactCredentialText(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of secretRedactions) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function shellWords(command: string): string[] {
  return (command.match(/[^\s"']+|"[^"]*"|'[^']*'/g) ?? []).map((word) =>
    word.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2").replace(/\\(.)/g, "$1")
  );
}

function isEnvironmentDump(segment: string): boolean {
  const words = shellWords(segment);
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
  if (words[0] === "command") words.shift();
  if (words[0] === "sudo") {
    words.shift();
    while (words[0]?.startsWith("-")) words.shift();
  }

  const executable = words.shift()?.replaceAll("\\", "/").split("/").pop()?.toLowerCase();
  if (executable === "printenv") return true;
  if (executable === "set") return words.length === 0;
  if (executable === "export") return words.length === 0 || words.includes("-p");
  if (executable === "declare") return words.length === 1 && words[0] === "-x";
  if (
    ["get-childitem", "gci", "dir", "ls"].includes(executable ?? "") &&
    words[0]?.replaceAll("\\", "").toLowerCase().startsWith("env:")
  ) {
    return true;
  }
  if (executable !== "env") return false;

  const optionsWithValues = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
  while (words.length > 0) {
    const word = words.shift() ?? "";
    if (optionsWithValues.has(word)) {
      words.shift();
      continue;
    }
    if (word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return isEnvironmentDump([word, ...words].join(" "));
  }
  return true;
}

export function credentialExtractionReason(command: string): string | undefined {
  const segments = command.split(/(?:^|[;&|]{1,2}|\n)\s*/).map((segment) => segment.trim());
  if (
    segments.some((segment) => {
      const normalized = shellWords(segment).join(" ");
      return blockedCommandPatterns.some((pattern) => pattern.test(normalized));
    })
  ) {
    return "command may expose CLI credentials";
  }
  return segments.some(isEnvironmentDump) ? "environment dump may expose credentials" : undefined;
}

export function redactCredentialContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;

  return content.map((part) => {
    const maybeText = part as Partial<TextPart>;
    if (maybeText?.type === "text" && typeof maybeText.text === "string") {
      return { ...maybeText, text: redactCredentialText(maybeText.text) };
    }
    return part;
  });
}

const maxPendingOutput = 64 * 1024;
const safeOutputTail = 1024;
const credentialAssignment = new RegExp(`${credentialKey}\\s*[=:]`, "i");

export function createCredentialRedactingSink(onData: (data: Buffer) => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let suppressThroughNewline = false;

  const emit = (text: string) => {
    if (text) onData(Buffer.from(text));
  };

  const drain = () => {
    if (suppressThroughNewline) {
      const newline = pending.indexOf("\n");
      if (newline === -1) {
        pending = "";
        return;
      }
      emit("\n");
      pending = pending.slice(newline + 1);
      suppressThroughNewline = false;
    }

    const completeThrough = pending.lastIndexOf("\n") + 1;
    if (completeThrough > 0) {
      emit(redactCredentialText(pending.slice(0, completeThrough)));
      pending = pending.slice(completeThrough);
    }

    if (pending.length <= maxPendingOutput) return;
    const redacted = redactCredentialText(pending);
    if (redacted !== pending || credentialAssignment.test(pending)) {
      emit("[REDACTED_OVERSIZED_CREDENTIAL]");
      pending = "";
      suppressThroughNewline = true;
      return;
    }

    emit(pending.slice(0, -safeOutputTail));
    pending = pending.slice(-safeOutputTail);
  };

  return {
    write(data: Buffer) {
      pending += decoder.write(data);
      drain();
    },
    end() {
      pending += decoder.end();
      if (suppressThroughNewline) emit("[REDACTED]");
      else emit(redactCredentialText(pending));
      pending = "";
      suppressThroughNewline = false;
    },
  };
}

export default function credentialRedactor(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("credential-redactor", "creds: redaction on");
  });

  pi.on("tool_call", async (event) => {
    if (!["bash", "powershell"].includes(event.toolName)) return undefined;
    const command = String((event.input as { command?: unknown }).command ?? "");
    const reason = credentialExtractionReason(command);
    return reason ? { block: true, reason: `Credential Redactor blocked: ${reason}` } : undefined;
  });

  pi.on("tool_result", async (event) => {
    if (!["bash", "powershell", "read"].includes(event.toolName)) return undefined;
    return { content: redactCredentialContent(event.content) as typeof event.content };
  });

  // CC Safety Net guards agent tool calls but does not intercept interactive user_bash.
  pi.on("user_bash", (event) => {
    const reason = credentialExtractionReason(event.command);
    if (reason) {
      return {
        result: {
          output: `Credential Redactor blocked: ${reason}`,
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }

    const local = createLocalBashOperations();
    return {
      operations: {
        async exec(
          command: Parameters<typeof local.exec>[0],
          cwd: Parameters<typeof local.exec>[1],
          options: Parameters<typeof local.exec>[2]
        ) {
          const sink = createCredentialRedactingSink(options.onData);
          try {
            return await local.exec(command, cwd, { ...options, onData: sink.write });
          } finally {
            sink.end();
          }
        },
      },
    };
  });

  pi.registerCommand("credential-redactor", {
    description: "Show credential redaction status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Credential Redactor is active: CC Safety Net handles file and destructive-command blocking; known secret output and explicit credential exports are redacted or blocked.",
        "info"
      );
    },
  });
}
