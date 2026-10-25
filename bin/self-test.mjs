#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const online = process.argv.includes("--online");
const runtimeHome = mkdtempSync(join(tmpdir(), "gustave-self-test-"));

function run(label, command, args, opts = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...opts.env } });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed with exit ${result.status}`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`✓ ${label}\n`);
}

// Like run(), but a non-zero exit only warns. Use for third-party checks that can
// break on new pi releases without affecting Gustave's runtime.
function runNonFatal(label, command, args, note, opts = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...opts.env } });
  if (result.status !== 0) {
    console.warn(`⚠ ${label} failed with exit ${result.status} (non-fatal)${note ? `: ${note}` : ""}`);
    return;
  }
  process.stdout.write(`✓ ${label}\n`);
}

function packageJsonPath(packageName) {
  return resolve(root, "node_modules", ...packageName.split("/"), "package.json");
}

function installedPackageVersion(packageName) {
  return JSON.parse(readFileSync(packageJsonPath(packageName), "utf8")).version;
}

function npmLatestVersion(packageName) {
  for (const command of ["pnpm", "npm"]) {
    const result = spawnSync(command, ["view", packageName, "version"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error(`Could not fetch latest version for ${packageName}`);
}

function checkLatestPackage(label, packageName) {
  process.stdout.write(`\n▶ ${label}\n`);
  const current = installedPackageVersion(packageName);
  const latest = npmLatestVersion(packageName);
  if (current !== latest) {
    console.error(`✗ ${label} failed: installed ${packageName}@${current}, latest is ${latest}`);
    process.exit(1);
  }
  process.stdout.write(`✓ ${label} (${packageName}@${current})\n`);
}

const piCli = resolve(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

// Smoke-test an MCP server through pi's native `pi mcp list` using a throwaway agent
// dir, so the bundled servers connect exactly as they do in a Gustave session.
function checkMcpServer(label, name, config, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gustave-mcp-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: { [name]: config } }, null, 2)}\n`);
  try {
    run(label, process.execPath, [piCli, "mcp", "list"], {
      env: { PI_CODING_AGENT_DIR: agentDir, ...extraEnv },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

run("Installer shell syntax", "sh", ["-n", "install.sh"]);
run("TypeScript extensions", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
run("Powerline footer dependency", process.execPath, [
  "-e",
  "require('fs').accessSync('node_modules/pi-powerline-footer/index.ts')",
]);
runNonFatal(
  "Powerline footer typecheck",
  process.execPath,
  ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "node_modules/pi-powerline-footer/tsconfig.json"],
  "third-party footer type errors do not affect Gustave's runtime"
);
run("llama.cpp extension dependency", process.execPath, [
  "-e",
  "require('fs').accessSync('node_modules/pi-llama-cpp/src/index.ts')",
]);
run(
  "Gustave resource startup",
  process.execPath,
  ["bin/gustave.mjs", "--no-session", "--list-models", "__gustave_self_test_no_model__"],
  { env: { GUSTAVE_HOME: runtimeHome, PI_OFFLINE: "1" } }
);
run("Commit hook accepts Conventional Commit", process.execPath, [
  "-e",
  "const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'); const f=path.join(os.tmpdir(),'gustave-good-commit-msg'); fs.writeFileSync(f,'fix(cli): validate commit hook\\n'); process.exit(cp.spawnSync(process.execPath,['bin/commit-msg-hook.mjs',f],{cwd:process.cwd(),stdio:'inherit'}).status ?? 1);",
]);
run("Commit hook rejects agent attribution", process.execPath, [
  "-e",
  "const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'); const f=path.join(os.tmpdir(),'gustave-bad-commit-msg'); fs.writeFileSync(f,'fix(cli): validate commit hook\\n\\nGenerated with Claude Code\\n'); const r=cp.spawnSync(process.execPath,['bin/commit-msg-hook.mjs',f],{cwd:process.cwd(),stdio:'ignore'}); process.exit(r.status === 1 ? 0 : 1);",
]);
run("Gustave help", process.execPath, ["bin/gustave.mjs", "--help"]);
run("Pi help passthrough", process.execPath, ["bin/gustave.mjs", "pi-help"]);
run("Pi MCP command passthrough", process.execPath, ["bin/gustave.mjs", "mcp", "list"]);
checkMcpServer("Bundled Svelte MCP (stdio)", "svelte", {
  command: process.execPath,
  args: [resolve(root, "node_modules", "@sveltejs", "mcp", "dist", "index.mjs")],
});
run("Paseo CLI help", process.execPath, ["node_modules/@getpaseo/cli/bin/paseo", "--help"]);
run("agent-browser version", process.execPath, ["node_modules/agent-browser/bin/agent-browser.js", "--version"]);

if (online) {
  checkLatestPackage("Bundled pi is latest", "@earendil-works/pi-coding-agent");
  checkMcpServer("Svelte MCP over HTTP", "svelte", { url: "https://mcp.svelte.dev/mcp" });
} else {
  console.log("\nSkipping online Svelte MCP smoke. Run `gustave self-test --online` to include it.");
}

console.log("\nAll Gustave self-tests passed.");
