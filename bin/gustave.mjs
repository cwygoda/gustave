#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const gustaveSystemPolicy = `Gustave operating policy:
- Architecture: bring architectural judgment to implementation work. Prefer hexagonal architecture / ports-and-adapters and clean architecture boundaries when they fit the project. Keep domain logic independent of frameworks, IO, databases, CLIs, and HTTP. Avoid over-engineering for small scripts or one-off changes.
- Testing: prefer a nice, fast test pyramid. Put most coverage in fast unit/domain tests, add focused integration/contract tests around adapters and boundaries, and keep end-to-end tests minimal, high-value, and stable. Prefer deterministic tests with clear fixtures over slow brittle suites.
- CLI/tools: prefer modern, fast CLI tools when available: rg over grep, fd over find, jq/yq for structured data, bat for readable file previews, eza/tree for directory inspection, delta for diffs, hyperfine for benchmarks. Fall back to POSIX tools when needed and do not assume tools are installed without checking.
- Commits: when creating git commits, always use Conventional Commits: <type>(optional-scope)!: summary. Allowed types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test.
- Commits: never add agent/AI attribution lines to commit messages. Do not add lines like "Generated with Claude Code", "Co-Authored-By: Claude ...", or any Generated-by/Signed-off-by line naming Claude, Codex, ChatGPT, OpenAI, Anthropic, Gustave, or pi.
- Commits: keep commit messages concise and human-authored.`;
function expandHome(value) {
  return typeof value === "string" && value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [key, value] of Object.entries(b ?? {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      a[key] &&
      typeof a[key] === "object" &&
      !Array.isArray(a[key])
    ) {
      out[key] = deepMerge(a[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error.message}`);
  }
}

function readEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadConfig() {
  const explicit = process.env.GUSTAVE_CONFIG ? [process.env.GUSTAVE_CONFIG] : [];
  const candidates = [
    ...explicit,
    join(homedir(), ".config", "gustave", "config.json"),
    join(homedir(), ".gustave", "config.json"),
    resolve(process.cwd(), ".gustave", "config.json"),
  ];

  let config = {};
  const loaded = [];
  for (const candidate of candidates.map(expandHome)) {
    if (!existsSync(candidate)) continue;
    config = deepMerge(config, readJson(candidate));
    loaded.push(candidate);
  }
  return { config, loaded };
}

function ensureDefaultPiSettings(agentDir, packageRoot, config) {
  mkdirSync(agentDir, { recursive: true });
  const settingsFile = join(agentDir, "settings.json");
  let settings = {};
  if (existsSync(settingsFile)) {
    try {
      settings = readJson(settingsFile);
    } catch {
      settings = {};
    }
  }

  const appendUnique = (key, value) => {
    const list = Array.isArray(settings[key]) ? settings[key] : [];
    settings[key] = [...list.filter((item) => item !== value), value];
  };

  const gustavePowerlineItem = {
    id: "gustave",
    statusKey: "gustave",
    position: "right",
    prefix: "Gustave",
    color: "accent",
    hideWhenMissing: false,
  };
  const configuredPowerline =
    config.powerline && typeof config.powerline === "object" && !Array.isArray(config.powerline) ? config.powerline : {};
  const defaultPowerline = deepMerge(
    {
      preset: "default",
      fixedEditor: true,
      mouseScroll: true,
      welcome: true,
      path: { mode: "basename" },
      model: { display: "name" },
      cost: { subscriptionDisplay: "subscription" },
      customItems: [gustavePowerlineItem],
    },
    configuredPowerline
  );

  if (!settings.theme) settings.theme = config.theme ?? "gustave";
  if (!settings.defaultProjectTrust) settings.defaultProjectTrust = config.defaultProjectTrust ?? "ask";
  if (settings.enableSkillCommands === undefined) settings.enableSkillCommands = true;
  if (settings.powerline === undefined) {
    settings.powerline = defaultPowerline;
  } else if (settings.powerline && typeof settings.powerline === "object" && !Array.isArray(settings.powerline)) {
    const existingCustomItems = Array.isArray(settings.powerline.customItems) ? settings.powerline.customItems : [];
    settings.powerline = deepMerge(defaultPowerline, settings.powerline);
    if (!existingCustomItems.some((item) => item && typeof item === "object" && item.id === "gustave")) {
      settings.powerline.customItems = [...existingCustomItems, gustavePowerlineItem];
    }
  }
  appendUnique("extensions", join(packageRoot, "extensions"));
  appendUnique("extensions", join(packageRoot, "node_modules", "pi-powerline-footer", "index.ts"));
  appendUnique("skills", join(packageRoot, "skills"));
  appendUnique("prompts", join(packageRoot, "prompts"));
  appendUnique("themes", join(packageRoot, "themes"));

  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}

function packageFile(packageName, filePath) {
  const path = join(root, "node_modules", ...packageName.split("/"), filePath);
  if (existsSync(path)) return path;
  throw new Error(`Could not find ${packageName}. Run \`npm install\` or \`gustave self-update\` first.`);
}

function packageBin(packageName, binPath) {
  return packageFile(packageName, binPath);
}

function piCliPath() {
  return packageBin("@earendil-works/pi-coding-agent", "dist/cli.js");
}

function ensureMcporterConfig(home) {
  mkdirSync(home, { recursive: true });
  const configFile = join(home, "mcporter.json");
  const agentBrowserBin = join(root, "node_modules", "agent-browser", "bin", "agent-browser.js");
  const svelteLocalBin = join(root, "node_modules", "@sveltejs", "mcp", "dist", "index.mjs");
  const mcpServers = {
    svelte: {
      description: "Official Svelte MCP over Streamable HTTP",
      baseUrl: "https://mcp.svelte.dev/mcp",
    },
  };
  if (existsSync(svelteLocalBin)) {
    mcpServers["svelte-local"] = {
      description: "Official Svelte MCP via bundled stdio package",
      command: process.execPath,
      args: [svelteLocalBin],
    };
  }
  if (existsSync(agentBrowserBin)) {
    mcpServers["agent-browser"] = {
      description: "agent-browser MCP stdio server",
      command: process.execPath,
      args: [agentBrowserBin, "mcp"],
    };
  }
  const next = {
    imports: ["cursor", "claude-code", "claude-desktop", "codex", "windsurf", "opencode", "vscode"],
    mcpServers,
  };

  let existing = {};
  if (existsSync(configFile)) {
    try {
      existing = readJson(configFile);
    } catch {
      existing = {};
    }
  }
  const merged = deepMerge(next, existing);
  merged.mcpServers = { ...next.mcpServers, ...(existing.mcpServers ?? {}) };
  writeFileSync(configFile, `${JSON.stringify(merged, null, 2)}\n`);
  return configFile;
}

function withGitCommitPolicyEnv(env) {
  if (env.GUSTAVE_DISABLE_GIT_COMMIT_POLICY === "1") return env;
  const next = { ...env, GUSTAVE_NODE: process.execPath };
  const count = Number.parseInt(String(next.GIT_CONFIG_COUNT ?? "0"), 10);
  const index = Number.isFinite(count) ? count : 0;
  next[`GIT_CONFIG_KEY_${index}`] = "core.hooksPath";
  next[`GIT_CONFIG_VALUE_${index}`] = join(root, "git-hooks");
  next.GIT_CONFIG_COUNT = String(index + 1);
  return next;
}

function spawnNodeScript(script, args, env) {
  const result = spawnSync(process.execPath, [join(root, "bin", script), ...args], {
    stdio: "inherit",
    env,
  });
  if (result.error) console.error(`Failed to start ${script}: ${result.error.message}`);
  process.exit(result.status ?? (result.error ? 1 : 0));
}

function printGustaveHelp() {
  console.log(
    `gustave - a custom coding agent based on pi\n\nUsage:\n  gustave [pi options] [@files...] [messages...]\n  gustave update [pi update options]\n  gustave install-bin [--dir ~/.local/bin]\n  gustave self-test [--online]\n  gustave self-update [--online] [--upgrade]\n  gustave github-ssh [--owner cwygoda]\n  gustave mcporter [...args]\n  gustave svelte-mcp [list|tool ...args]\n  gustave paseo [...args]\n  gustave agent-browser [...args]\n  gustave config-path\n  gustave pi-help\n\nConfig files, merged in order:\n  ~/.config/gustave/config.json\n  ~/.gustave/config.json\n  ./.gustave/config.json\n\nSet GUSTAVE_CONFIG=/path/to/config.json to load an explicit file first.\n\nExample config:\n{\n  "env": { "AWS_PROFILE": "dev" },\n  "envFiles": ["~/.gustave/env"],\n  "piArgs": ["--provider", "amazon-bedrock"],\n  "theme": "gustave"\n}\n\nAll other arguments are passed through to pi. Use \`gustave pi-help\` for pi's full help.`
  );
}

const argv = process.argv.slice(2);
if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "--gustave-help") {
  printGustaveHelp();
  process.exit(0);
}

const { config, loaded } = loadConfig();
const gustaveHome = expandHome(config.home ?? process.env.GUSTAVE_HOME ?? join(homedir(), ".gustave"));
const agentDir = expandHome(config.piAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(gustaveHome, "agent"));

const envFromFiles = Object.assign(
  {},
  ...(config.envFiles ?? []).map((p) => readEnvFile(resolve(process.cwd(), expandHome(p))))
);
const mcporterConfig = ensureMcporterConfig(gustaveHome);
const childEnv = withGitCommitPolicyEnv({
  ...process.env,
  GUSTAVE_HOME: gustaveHome,
  GUSTAVE_PACKAGE_ROOT: root,
  GUSTAVE_CONFIG_FILES: loaded.join(":"),
  GUSTAVE_MCPORTER_CONFIG: mcporterConfig,
  PI_CODING_AGENT_DIR: agentDir,
  ...envFromFiles,
  ...(config.env ?? {}),
});

ensureDefaultPiSettings(agentDir, root, config);

if (argv[0] === "config-path") {
  console.log(join(gustaveHome, "config.json"));
  process.exit(0);
}

if (argv[0] === "install-bin") spawnNodeScript("install-user-bin.mjs", argv.slice(1), childEnv);
if (argv[0] === "self-test") spawnNodeScript("self-test.mjs", argv.slice(1), childEnv);
if (argv[0] === "self-update" || argv[0] === "update-gustave")
  spawnNodeScript("self-update.mjs", argv.slice(1), childEnv);
if (argv[0] === "github-ssh") spawnNodeScript("github-ssh.mjs", argv.slice(1), childEnv);

function spawnTool(bin, args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    stdio: "inherit",
    env: childEnv,
  });
  if (result.error) console.error(`Failed to start tool: ${result.error.message}`);
  process.exit(result.status ?? (result.error ? 1 : 0));
}

function withMcporterDefaults(args) {
  const hasConfig = args.includes("--config");
  const hasRoot = args.includes("--root");
  return [...(hasConfig ? [] : ["--config", mcporterConfig]), ...(hasRoot ? [] : ["--root", process.cwd()]), ...args];
}

if (argv[0] === "mcporter") spawnTool(packageBin("mcporter", "dist/cli.js"), withMcporterDefaults(argv.slice(1)));
if (argv[0] === "paseo") spawnTool(packageBin("@getpaseo/cli", "bin/paseo"), argv.slice(1));
if (argv[0] === "agent-browser" || argv[0] === "agentbrowser")
  spawnTool(packageBin("agent-browser", "bin/agent-browser.js"), argv.slice(1));
if (argv[0] === "svelte-mcp") {
  const rest = argv.slice(1);
  const mcporterBin = packageBin("mcporter", "dist/cli.js");
  if (rest.length === 0 || rest[0] === "list") {
    spawnTool(
      mcporterBin,
      withMcporterDefaults(["list", "svelte", "--brief", ...rest.slice(rest[0] === "list" ? 1 : 0)])
    );
  } else {
    const tool = rest[0] === "call" ? rest[1] : rest[0];
    const toolArgs = rest[0] === "call" ? rest.slice(2) : rest.slice(1);
    spawnTool(mcporterBin, withMcporterDefaults(["call", `svelte.${tool}`, ...toolArgs]));
  }
}

if (argv[0] === "pi-help") {
  argv.splice(0, 1, "--help");
}

const piArgs = Array.isArray(config.piArgs) ? config.piArgs : [];
const bundledExtensions = [
  ["--extension", packageFile("pi-powerline-footer", "index.ts")],
  ["--extension", packageFile("@plannotator/pi-extension", "index.ts")],
  ...[
    "ask-user.ts",
    "bedrock-auth.ts",
    "game-sounds.ts",
    "gustave-ui.ts",
    "mcporter.ts",
    "memory.ts",
    "research.ts",
    "subagents.ts",
  ].map((file) => ["--extension", join(root, "extensions", file)]),
].flat();

const resourceArgs = [
  ...bundledExtensions,
  "--skill",
  join(root, "skills"),
  "--theme",
  join(root, "themes", "gustave.json"),
  "--append-system-prompt",
  gustaveSystemPolicy,
];

const packageCommands = new Set(["install", "remove", "uninstall", "update", "list", "config"]);
const commandMode = packageCommands.has(argv[0]);
const args = commandMode ? [piCliPath(), ...argv] : [piCliPath(), ...resourceArgs, ...piArgs, ...argv];

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start pi: ${error.message}`);
  process.exit(1);
});
