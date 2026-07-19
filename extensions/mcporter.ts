import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function packageRoot() {
  return process.env.GUSTAVE_PACKAGE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function gustaveHome() {
  return process.env.GUSTAVE_HOME ?? join(homedir(), ".gustave");
}

function mcporterBin() {
  return join(packageRoot(), "node_modules", "mcporter", "dist", "cli.js");
}

function mcporterConfig() {
  return process.env.GUSTAVE_MCPORTER_CONFIG ?? join(gustaveHome(), "mcporter.json");
}

function runMcporter(args: string[], cwd: string, signal?: AbortSignal) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const bin = mcporterBin();
    if (!existsSync(bin)) {
      reject(new Error(`mcporter is not installed at ${bin}. Run gustave self-update or npm install.`));
      return;
    }
    const child = spawn(process.execPath, [bin, "--config", mcporterConfig(), "--root", cwd, ...args], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr });
    });
  });
}

function argValue(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export default function mcporterExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "mcp_list",
    label: "MCP List",
    description: "List MCP servers/tools via MCPorter. Gustave preconfigures the official Svelte MCP and agent-browser MCP.",
    parameters: Type.Object({
      server: Type.Optional(Type.String({ description: "Optional server name, e.g. svelte or agent-browser." })),
      brief: Type.Optional(Type.Boolean({ default: true })),
      schema: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["list"];
      if (params.server) args.push(String(params.server));
      if (params.brief !== false) args.push("--brief");
      if (params.schema) args.push("--schema");
      const result = await runMcporter(args, ctx.cwd, signal);
      const text = result.code === 0 ? result.stdout : `mcporter failed (${result.code})\n\n${result.stdout}\n${result.stderr}`;
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerTool({
    name: "mcp_call",
    label: "MCP Call",
    description: "Call an MCP tool through MCPorter. Target format: server.tool, e.g. svelte.list-sections or agent-browser.agent_browser_snapshot.",
    parameters: Type.Object({
      target: Type.String({ description: "server.tool target." }),
      args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Named tool arguments." })),
      rawArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra raw mcporter CLI arguments." })),
      output: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("json"), Type.Literal("raw")], { default: "auto" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["call", String(params.target)];
      for (const [key, value] of Object.entries((params.args ?? {}) as Record<string, unknown>)) {
        args.push(`${key}=${argValue(value)}`);
      }
      args.push(...((params.rawArgs ?? []) as string[]).map(String));
      if (params.output && params.output !== "auto") args.push("--output", String(params.output));
      const result = await runMcporter(args, ctx.cwd, signal);
      const text = result.code === 0 ? result.stdout : `mcporter failed (${result.code})\n\n${result.stdout}\n${result.stderr}`;
      return { content: [{ type: "text", text: text.slice(0, 100000) }], details: result };
    },
  });

  pi.registerTool({
    name: "svelte_mcp",
    label: "Svelte MCP",
    description: "Convenience wrapper around the official Svelte MCP via MCPorter.",
    parameters: Type.Object({
      tool: Type.Union([Type.Literal("list-sections"), Type.Literal("get-documentation"), Type.Literal("svelte-autofixer"), Type.Literal("playground-link")]),
      args: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["call", `svelte.${params.tool}`];
      for (const [key, value] of Object.entries((params.args ?? {}) as Record<string, unknown>)) {
        args.push(`${key}=${argValue(value)}`);
      }
      const result = await runMcporter(args, ctx.cwd, signal);
      const text = result.code === 0 ? result.stdout : `Svelte MCP failed (${result.code})\n\n${result.stdout}\n${result.stderr}`;
      return { content: [{ type: "text", text: text.slice(0, 100000) }], details: result };
    },
  });
}
