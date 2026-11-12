#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { allowedTypes, checkCommitMessage } from "./commit-policy.mjs";

const file = process.argv[2];
if (!file) process.exit(0);

const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const result = checkCommitMessage(raw);

if (!result.ok && result.kind === "subject") {
  console.error("\nGustave commit policy rejected this commit message.");
  console.error("\nFirst non-comment line must be a Conventional Commit:");
  console.error("  <type>(optional-scope)!: summary");
  console.error("\nAllowed types:");
  console.error(`  ${allowedTypes}`);
  console.error("\nExamples:");
  console.error("  feat(cli): add MCP command passthrough");
  console.error("  fix(git): enforce commit message policy");
  console.error(`\nActual subject:\n  ${result.subject || "<empty>"}\n`);
  process.exit(1);
}

if (!result.ok && result.kind === "attribution") {
  console.error("\nGustave commit policy rejected this commit message.");
  console.error("Agent/AI attribution lines are not allowed in commits.");
  console.error("Remove lines such as 'Generated with Claude Code' or 'Co-Authored-By: Claude ...'.");
  console.error(`\nRejected line:\n  ${result.line}\n`);
  process.exit(1);
}

// Best-effort chaining for a repo-local .git/hooks/commit-msg hook, because this
// hook is installed in the Gustave repo via `pnpm hooks:install` (core.hooksPath).
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
