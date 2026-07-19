#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const online = process.argv.includes("--online");

function run(label, command, args, env = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed with exit ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

let gitEnv = {};
const remote = spawnSync("git", ["remote", "-v"], { cwd: root, encoding: "utf8" });
if (/github\.com[:/]cwygoda\//.test(`${remote.stdout}\n${remote.stderr}`)) {
  const detect = spawnSync(process.execPath, ["bin/github-ssh.mjs", "--owner", process.env.GUSTAVE_GITHUB_OWNER || "cwygoda", "--no-persist"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
  });
  if (detect.status === 0 && detect.stdout.trim()) {
    gitEnv.GIT_SSH_COMMAND = detect.stdout.trim().split(/\r?\n/)[0];
    console.log(`Using detected GitHub SSH command for ${process.env.GUSTAVE_GITHUB_OWNER || "cwygoda"}.`);
  } else if (process.env.GIT_SSH_COMMAND) {
    gitEnv.GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND;
  }
}

if (existsSync(resolve(root, ".git"))) run("git pull --ff-only", "git", ["pull", "--ff-only"], gitEnv);
const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
const packageManager = pnpm.status === 0 ? "pnpm" : "npm";
run(`${packageManager} install`, packageManager, ["install", "--ignore-scripts"]);
run("self-test", process.execPath, ["bin/self-test.mjs", ...(online ? ["--online"] : [])]);
run("install absolute user-bin launcher", process.execPath, ["bin/install-user-bin.mjs"]);
console.log("\nGustave update complete.");
