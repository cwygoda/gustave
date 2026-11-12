// Single source of truth for Gustave's commit-message policy.
// Consumed by the agent-side guard (extensions/commit-policy.ts) and by the
// Gustave repo's local commit-msg hook (bin/commit-msg-hook.mjs).

export const conventionalSubject =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._/-]+\))?!?: .{1,200}$/;

export const forbiddenLinePatterns = [
  /🤖/u,
  /generated\s+with\s+.*(claude|codex|chatgpt|openai|anthropic|gustave|pi)/i,
  /generated\s+by\s+.*(claude|codex|chatgpt|openai|anthropic|gustave|pi)/i,
  /co-authored-by:\s*(claude|codex|chatgpt|openai|anthropic|gustave|pi)\b/i,
  /signed-off-by:\s*(claude|codex|chatgpt|openai|anthropic|gustave|pi)\b/i,
  /claude\s+code/i,
  /openai\s+codex/i,
  /anthropic/i,
];

export const allowedTypes = "build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test";

// Returns { ok: true } or { ok: false, kind: "subject" | "attribution", subject?, line? }.
export function checkCommitMessage(raw) {
  const lines = String(raw).replace(/\r\n/g, "\n").split("\n");
  const subject = lines.find((line) => line.trim() && !line.trim().startsWith("#"))?.trim() ?? "";
  if (!conventionalSubject.test(subject)) {
    return { ok: false, kind: "subject", subject };
  }
  const line = lines.find((l) => forbiddenLinePatterns.some((pattern) => pattern.test(l)));
  if (line) {
    return { ok: false, kind: "attribution", line: line.trim() };
  }
  return { ok: true };
}
