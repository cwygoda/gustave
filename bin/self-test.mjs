#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const online = process.argv.includes("--online");

function run(label, command, args, opts = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...opts.env } });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed with exit ${result.status}`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`✓ ${label}\n`);
}

run("Installer shell syntax", "sh", ["-n", "install.sh"]);
run("TypeScript extensions", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
run("Powerline footer dependency", process.execPath, [
  "-e",
  "require('fs').accessSync('node_modules/pi-powerline-footer/index.ts')",
]);
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
run("MCPorter help", process.execPath, ["node_modules/mcporter/dist/cli.js", "--help"]);
run("Bundled local Svelte MCP", process.execPath, ["bin/gustave.mjs", "mcporter", "list", "svelte-local", "--brief"]);
run("Paseo CLI help", process.execPath, ["node_modules/@getpaseo/cli/bin/paseo", "--help"]);
run("agent-browser version", process.execPath, ["node_modules/agent-browser/bin/agent-browser.js", "--version"]);

if (online) {
  run("Svelte MCP over MCPorter", process.execPath, [
    "node_modules/mcporter/dist/cli.js",
    "list",
    "--http-url",
    "https://mcp.svelte.dev/mcp",
    "--name",
    "svelte",
    "--brief",
    "--timeout",
    "15000",
  ]);
} else {
  console.log("\nSkipping online Svelte MCP smoke. Run `gustave self-test --online` to include it.");
}

console.log("\nAll Gustave self-tests passed.");
