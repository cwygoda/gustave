#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const file = process.argv[2];
if (!file) process.exit(0);

const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const lines = raw.split("\n");
const subject = lines.find((line) => line.trim() && !line.trim().startsWith("#"))?.trim() ?? "";

const conventional = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._/-]+\))?!?: .{1,200}$/;
const forbidden = [
  /🤖/u,
  /generated\s+with\s+.*(claude|codex|chatgpt|openai|anthropic|gustave|pi)/i,
  /generated\s+by\s+.*(claude|codex|chatgpt|openai|anthropic|gustave|pi)/i,
  /co-authored-by:\s*(claude|codex|chatgpt|openai|anthropic|gustave|pi)\b/i,
  /signed-off-by:\s*(claude|codex|chatgpt|openai|anthropic|gustave|pi)\b/i,
  /claude\s+code/i,
  /openai\s+codex/i,
  /anthropic/i,
];

const badLine = lines.find((line) => forbidden.some((pattern) => pattern.test(line)));

if (!conventional.test(subject)) {
  console.error("\nGustave commit policy rejected this commit message.");
  console.error("\nFirst non-comment line must be a Conventional Commit:");
  console.error("  <type>(optional-scope)!: summary");
  console.error("\nAllowed types:");
  console.error("  build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test");
  console.error("\nExamples:");
  console.error("  feat(cli): add MCPorter passthrough");
  console.error("  fix(git): enforce commit message policy");
  console.error(`\nActual subject:\n  ${subject || "<empty>"}\n`);
  process.exit(1);
}

if (badLine) {
  console.error("\nGustave commit policy rejected this commit message.");
  console.error("Agent/AI attribution lines are not allowed in commits.");
  console.error("Remove lines such as 'Generated with Claude Code' or 'Co-Authored-By: Claude ...'.");
  console.error(`\nRejected line:\n  ${badLine.trim()}\n`);
  process.exit(1);
}

// Best-effort chaining for a repo-local .git/hooks/commit-msg hook, because Gustave
// enforces this policy via an environment-only core.hooksPath override.
const gitDirResult = spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" });
const gitDirText = gitDirResult.status === 0 ? gitDirResult.stdout.trim() : "";
if (gitDirText) {
  const gitDir = isAbsolute(gitDirText) ? gitDirText : resolve(process.cwd(), gitDirText);
  const repoHook = join(gitDir, "hooks", "commit-msg");
  if (existsSync(repoHook) && statSync(repoHook).mode & 0o111) {
    const result = spawnSync(repoHook, [file], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
}
