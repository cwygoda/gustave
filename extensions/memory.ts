import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface MemoryRecord {
  key: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function memoryDir() {
  const home = process.env.GUSTAVE_HOME ?? join(homedir(), ".gustave");
  const dir = join(home, "memory");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeKey(key: string) {
  return (
    key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "memory"
  );
}

function fileFor(key: string) {
  return join(memoryDir(), `${safeKey(key)}.json`);
}

function readAll(): MemoryRecord[] {
  const dir = memoryDir();
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), "utf8")) as MemoryRecord;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as MemoryRecord[];
}

export default function memoryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "memory_save",
    label: "Save Memory",
    description: "Persist a durable fact, preference, decision, or project note for future Gustave sessions.",
    parameters: Type.Object({
      key: Type.String({ description: "Stable lookup key, e.g. project-deploy-profile." }),
      content: Type.String({ description: "The memory content." }),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      const key = safeKey(String(params.key ?? "memory"));
      const path = fileFor(key);
      const now = new Date().toISOString();
      let createdAt = now;
      if (existsSync(path)) {
        try {
          createdAt = (JSON.parse(readFileSync(path, "utf8")) as MemoryRecord).createdAt ?? now;
        } catch {}
      }
      const record: MemoryRecord = {
        key,
        content: String(params.content ?? ""),
        tags: (params.tags ?? []).map(String),
        createdAt,
        updatedAt: now,
      };
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
      return { content: [{ type: "text", text: `Saved memory '${key}'.` }], details: record };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Search Memory",
    description: "Search Gustave's durable memory by text and optional tags.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      tag: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ default: 10, minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, params) {
      const q = String(params.query ?? "").toLowerCase();
      const tag = params.tag ? String(params.tag).toLowerCase() : "";
      const limit = Math.min(Number(params.limit ?? 10), 50);
      const records = readAll()
        .filter((r) => !q || `${r.key}\n${r.content}\n${r.tags.join(" ")}`.toLowerCase().includes(q))
        .filter((r) => !tag || r.tags.some((t) => t.toLowerCase() === tag))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
      const text = records.length
        ? records
            .map((r) => `## ${r.key}\nupdated: ${r.updatedAt}\ntags: ${r.tags.join(", ") || "-"}\n\n${r.content}`)
            .join("\n\n")
        : "No matching memories.";
      return { content: [{ type: "text", text }], details: { records } };
    },
  });

  pi.registerTool({
    name: "memory_delete",
    label: "Delete Memory",
    description: "Delete a Gustave memory by key.",
    parameters: Type.Object({ key: Type.String() }),
    async execute(_toolCallId, params) {
      const key = safeKey(String(params.key ?? ""));
      const path = fileFor(key);
      if (existsSync(path)) {
        unlinkSync(path);
        return { content: [{ type: "text", text: `Deleted memory '${key}'.` }], details: { key, deleted: true } };
      }
      return { content: [{ type: "text", text: `No memory found for '${key}'.` }], details: { key, deleted: false } };
    },
  });

  pi.registerCommand("memories", {
    description: "List Gustave memories",
    handler: async (_args, ctx) => {
      const records = readAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      ctx.ui.notify(
        records.length
          ? records.map((r) => `${r.key} (${r.tags.join(", ") || "no tags"})`).join("\n")
          : "No memories yet.",
        "info"
      );
    },
  });
}
