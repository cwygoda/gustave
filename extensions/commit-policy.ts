// Commit Policy Extension
// Agent-side guard: validates `git commit -m ...` messages before the bash tool
// runs them, so Gustave never has to force core.hooksPath onto a target repo.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { allowedTypes, checkCommitMessage } from "../bin/commit-policy.mjs";

// Split a shell command into command segments of words, honoring quotes/escapes so
// a `git commit` inside a quoted string is not mistaken for a real invocation.
export function splitCommands(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let cur = "";
  let inWord = false;
  const n = command.length;
  let i = 0;

  const endWord = () => {
    if (inWord) {
      words.push(cur);
      cur = "";
      inWord = false;
    }
  };
  const endSegment = () => {
    endWord();
    if (words.length) {
      segments.push(words);
      words = [];
    }
  };

  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      inWord = true;
      i++;
      while (i < n && command[i] !== "'") cur += command[i++];
      i++;
    } else if (ch === '"') {
      inWord = true;
      i++;
      while (i < n && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(command[i + 1])) {
          cur += command[i + 1];
          i += 2;
        } else {
          cur += command[i++];
        }
      }
      i++;
    } else if (ch === "\\") {
      if (i + 1 < n && command[i + 1] === "\n") {
        i += 2; // line continuation
      } else if (i + 1 < n) {
        inWord = true;
        cur += command[i + 1];
        i += 2;
      } else {
        i++;
      }
    } else if (ch === ";" || ch === "\n" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      endSegment();
      i++;
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      i++;
    } else {
      inWord = true;
      cur += ch;
      i++;
    }
  }
  endSegment();
  return segments;
}

function basename(word: string): string {
  return word.split(/[\\/]/).pop() ?? word;
}

// Messages passed to `git commit` in this segment, or null when it is not a commit.
// shortcut: only inline -m/--message are parsed; -F/heredoc/editor commits are not
// validated here (still covered by the system-prompt rule). Add file reading if the
// agent starts committing via -F.
function commitMessages(words: string[]): string[] | null {
  const gitIndex = words.findIndex((word) => basename(word) === "git");
  if (gitIndex === -1) return null;
  const rest = words.slice(gitIndex + 1);
  if (!rest.includes("commit")) return null;

  const messages: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const word = rest[k];
    if (word === "--message" || /^-[a-zA-Z]*m$/.test(word)) {
      if (k + 1 < rest.length) messages.push(rest[++k]);
    } else if (word.startsWith("--message=")) {
      messages.push(word.slice("--message=".length));
    } else if (!word.startsWith("--") && /^-[a-zA-Z]*m./.test(word)) {
      messages.push(word.slice(word.indexOf("m") + 1));
    }
  }
  return messages;
}

const header = "Gustave commit policy blocked this git commit.";

export function commitPolicyViolation(command: string): string | undefined {
  for (const words of splitCommands(command)) {
    const messages = commitMessages(words);
    if (!messages || messages.length === 0) continue;
    const result = checkCommitMessage(messages.join("\n\n"));
    if (result.ok) continue;
    if (result.kind === "subject") {
      return `${header} The subject must be a Conventional Commit: <type>(optional-scope)!: summary (allowed types: ${allowedTypes}). Got: "${result.subject || "<empty>"}".`;
    }
    return `${header} Agent/AI attribution lines are not allowed. Remove: "${result.line}".`;
  }
  return undefined;
}

export default function commitPolicy(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = String((event.input as { command?: unknown }).command ?? "");
    const reason = commitPolicyViolation(command);
    return reason ? { block: true, reason } : undefined;
  });
}
