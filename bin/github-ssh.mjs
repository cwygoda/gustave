#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

function expandHome(value) {
  return value.replace(/^~(?=$|\/)/, homedir());
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function run(command, args, env = {}) {
  return spawnSync(command, args, {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15000,
  });
}

function sshIdentifiesAs(command, owner) {
  const result = spawnSync("sh", ["-lc", `${command} -T git@github.com`], {
    encoding: "utf8",
    timeout: 15000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  return output.includes(`Hi ${owner}!`);
}

function candidateKeys() {
  const sshDir = join(homedir(), ".ssh");
  const keys = new Set();

  const config = join(sshDir, "config");
  if (existsSync(config)) {
    for (const line of readFileSync(config, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      const match = trimmed.match(/^IdentityFile\s+(.+)$/i);
      if (match) keys.add(expandHome(match[1].replace(/^['"]|['"]$/g, "")));
    }
  }

  if (existsSync(sshDir)) {
    for (const name of readdirSync(sshDir)) {
      if (/^id_[A-Za-z0-9_-]+$/.test(name) && !name.endsWith(".pub")) keys.add(join(sshDir, name));
    }
  }

  return [...keys].filter((key) => existsSync(key));
}

function findCommand(owner) {
  const existing = process.env.GUSTAVE_GITHUB_SSH_COMMAND || process.env.GIT_SSH_COMMAND;
  if (existing && sshIdentifiesAs(existing, owner)) return existing;

  const defaultCommand = "ssh -o BatchMode=yes -o IdentitiesOnly=no";
  if (sshIdentifiesAs(defaultCommand, owner)) return defaultCommand;

  for (const key of candidateKeys()) {
    const command = `ssh -i ${shellQuote(key)} -o IdentitiesOnly=yes -o BatchMode=yes`;
    if (sshIdentifiesAs(command, owner)) return command;
  }

  return null;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const owner = process.argv.includes("--owner") ? process.argv[process.argv.indexOf("--owner") + 1] : (process.env.GUSTAVE_GITHUB_OWNER || "cwygoda");
const persist = !process.argv.includes("--no-persist");
const command = findCommand(owner);

if (!command) {
  console.error(`Could not find an SSH identity that GitHub reports as ${owner}.`);
  console.error("Try: GUSTAVE_GITHUB_SSH_COMMAND='ssh -i ~/.ssh/key -o IdentitiesOnly=yes' gustave github-ssh");
  process.exit(1);
}

console.log(command);

if (persist) {
  const gustaveHome = process.env.GUSTAVE_HOME ? resolve(expandHome(process.env.GUSTAVE_HOME)) : join(homedir(), ".gustave");
  mkdirSync(gustaveHome, { recursive: true });
  const configFile = join(gustaveHome, "config.json");
  const config = deepMerge(readJson(configFile), { env: { GIT_SSH_COMMAND: command, GUSTAVE_GITHUB_OWNER: owner } });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  console.error(`Persisted GIT_SSH_COMMAND for ${owner} to ${configFile}`);
}
