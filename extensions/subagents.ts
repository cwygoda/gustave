import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface AgentDef {
  name: string;
  description: string;
  system: string;
  model?: string;
  tools?: string;
  source: string;
  projectLocal: boolean;
}

function parseAgent(file: string, projectLocal: boolean): AgentDef | null {
  const raw = readFileSync(file, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let system = raw;
  if (match) {
    system = match[2];
    for (const line of match[1].split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > -1)
        meta[line.slice(0, idx).trim()] = line
          .slice(idx + 1)
          .trim()
          .replace(/^['"]|['"]$/g, "");
    }
  }
  const name = meta.name ?? file.split(/[\\/]/).pop()?.replace(/\.md$/, "");
  if (!name) return null;
  return {
    name,
    description: meta.description ?? "Subagent",
    system,
    model: meta.model,
    tools: meta.tools,
    source: file,
    projectLocal,
  };
}

function listMd(dir: string) {
  if (!existsSync(dir)) return [] as string[];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(dir, name));
}

function discoverAgents(cwd: string) {
  const root = process.env.GUSTAVE_PACKAGE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const home = process.env.GUSTAVE_HOME ?? join(homedir(), ".gustave");
  mkdirSync(join(home, "agents"), { recursive: true });
  const files = [
    ...listMd(join(root, "agents")).map((file) => [file, false] as const),
    ...listMd(join(home, "agents")).map((file) => [file, false] as const),
    ...listMd(join(cwd, ".gustave", "agents")).map((file) => [file, true] as const),
  ];
  const agents = new Map<string, AgentDef>();
  for (const [file, projectLocal] of files) {
    const agent = parseAgent(file, projectLocal);
    if (agent) agents.set(agent.name, agent);
  }
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function runPi(args: string[], input: string, cwd: string, signal: AbortSignal) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [process.argv[1], ...args, input], {
      cwd,
      env: { ...process.env, GUSTAVE_SUBAGENT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      signal.removeEventListener("abort", abort);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

export default function subagentsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagents_list",
    label: "List Subagents",
    description: "List available specialized Gustave subagents.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const agents = discoverAgents(ctx.cwd);
      const text =
        agents.map((a) => `- ${a.name}${a.projectLocal ? " (project)" : ""}: ${a.description}`).join("\n") ||
        "No subagents found.";
      return { content: [{ type: "text", text }], details: { agents } };
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task to a specialized subagent running in an isolated pi process.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name from subagents_list." }),
      task: Type.String({ description: "Task to delegate." }),
      model: Type.Optional(Type.String({ description: "Optional model override." })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist override." })),
      allowProjectAgent: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const agents = discoverAgents(ctx.cwd);
      const agent = agents.find((a) => a.name === params.agent);
      if (!agent) {
        return {
          content: [{ type: "text", text: `Unknown subagent '${params.agent}'. Use subagents_list first.` }],
          details: { found: false },
        };
      }

      if (agent.projectLocal && params.allowProjectAgent !== true) {
        if (ctx.mode !== "tui") {
          return {
            content: [
              {
                type: "text",
                text: `Project-local subagent '${agent.name}' requires explicit allowProjectAgent=true in an interactive session.`,
              },
            ],
            details: { allowed: false },
          };
        }
        const choice = await ctx.ui.select(`Run project-local subagent '${agent.name}' from ${agent.source}?`, [
          "Allow once",
          "Block",
        ]);
        if (choice !== "Allow once") {
          return { content: [{ type: "text", text: "Blocked project-local subagent." }], details: { allowed: false } };
        }
      }

      const childArgs = ["-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates"];
      const model = params.model ?? agent.model;
      if (model) childArgs.push("--model", String(model));
      const toolList = params.tools?.length ? params.tools.join(",") : agent.tools;
      if (toolList) childArgs.push("--tools", String(toolList));
      childArgs.push(
        "--system-prompt",
        `${agent.system}\n\nYou are a Gustave subagent. Return concise, evidence-backed findings to the parent agent.`
      );

      const result = await runPi(childArgs, String(params.task), ctx.cwd, signal ?? new AbortController().signal);
      const ok = result.code === 0;
      const text = ok
        ? result.stdout.trim()
        : `Subagent exited with code ${result.code}.\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`;
      return {
        content: [{ type: "text", text: text.slice(0, 50000) }],
        details: { ok, code: result.code, agent, stdout: result.stdout, stderr: result.stderr },
      };
    },
  });
}
