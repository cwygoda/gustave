import { spawn } from "node:child_process";
import { accessSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

const CATEGORIES = ["session-start", "task-acknowledge", "task-complete", "error", "permission"] as const;
type SoundCategory = (typeof CATEGORIES)[number];

type Player = { command: string; args: (sound: string, volume: number) => string[]; label: string };

interface GameSoundsConfig {
  volume: number;
  active_pack: string;
  pack_rotation: string[];
  enabled_events: Record<SoundCategory, boolean>;
}

const DEFAULT_CONFIG: GameSoundsConfig = {
  volume: 0.5,
  active_pack: "warcraft",
  pack_rotation: [],
  enabled_events: {
    "session-start": true,
    "task-acknowledge": true,
    "task-complete": true,
    error: true,
    permission: true,
  },
};

let playerCache: Player | null | undefined;
let sessionPack: string | undefined;
const lastPlayed = new Map<SoundCategory, string>();

function packageRoot() {
  return dirname(require.resolve("@citedy/game-sounds/package.json"));
}

function soundsDir() {
  return join(packageRoot(), "sounds");
}

function gustaveHome() {
  return process.env.GUSTAVE_HOME ?? join(homedir(), ".gustave");
}

function configPath() {
  return join(gustaveHome(), "game-sounds", "config.json");
}

function ensureConfig(): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    const packagedConfig = join(packageRoot(), "config.json");
    if (existsSync(packagedConfig)) {
      copyFileSync(packagedConfig, path);
    } else {
      writeConfig(DEFAULT_CONFIG);
    }
  }
  return path;
}

function normalizeConfig(raw: Partial<GameSoundsConfig>): GameSoundsConfig {
  const enabled = { ...DEFAULT_CONFIG.enabled_events, ...(raw.enabled_events ?? {}) };
  return {
    volume: clampVolume(Number(raw.volume ?? DEFAULT_CONFIG.volume)),
    active_pack: typeof raw.active_pack === "string" ? raw.active_pack : DEFAULT_CONFIG.active_pack,
    pack_rotation: Array.isArray(raw.pack_rotation) ? raw.pack_rotation.map(String) : [],
    enabled_events: enabled,
  };
}

function readConfig(): GameSoundsConfig {
  const path = ensureConfig();
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")) as Partial<GameSoundsConfig>);
  } catch {
    return { ...DEFAULT_CONFIG, enabled_events: { ...DEFAULT_CONFIG.enabled_events } };
  }
}

function writeConfig(config: GameSoundsConfig) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
}

function clampVolume(volume: number) {
  if (!Number.isFinite(volume)) return DEFAULT_CONFIG.volume;
  return Math.min(1, Math.max(0, volume));
}

function packIcon(pack: string) {
  switch (pack) {
    case "warcraft":
      return "⚔️";
    case "starcraft":
      return "🚀";
    case "diablo":
      return "🔥";
    case "command-conquer":
      return "🏗️";
    case "mario":
      return "🍄";
    case "zelda":
      return "🗡️";
    default:
      return "🎮";
  }
}

function isCategory(value: string): value is SoundCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

function listPacks() {
  const root = soundsDir();
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function packExists(pack: string) {
  return pack === "*" || existsSync(join(soundsDir(), pack));
}

function walkSoundFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSoundFiles(path));
    } else if (/\.(mp3|wav|ogg)$/i.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function countSounds(pack: string, category?: SoundCategory) {
  const dir = category ? join(soundsDir(), pack, category) : join(soundsDir(), pack);
  return walkSoundFiles(dir).length;
}

function randomItem<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function choosePack(config: GameSoundsConfig, category: SoundCategory) {
  let pack = config.active_pack;
  if (category === "session-start") {
    pack = config.pack_rotation.length > 0 ? randomItem(config.pack_rotation) : config.active_pack;
    sessionPack = pack;
  } else if (sessionPack) {
    pack = sessionPack;
  }

  if (pack === "*") {
    const candidates = listPacks().filter((candidate) => countSounds(candidate, category) > 0);
    return candidates.length > 0 ? randomItem(candidates) : undefined;
  }

  return packExists(pack) ? pack : undefined;
}

function executableExists(command: string) {
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of pathDirs) {
    try {
      accessSync(join(dir, command));
      return true;
    } catch {}
  }
  return false;
}

function findPlayer(): Player | null {
  if (playerCache !== undefined) return playerCache;
  const candidates: Player[] = [
    { command: "afplay", label: "afplay", args: (sound, volume) => ["-v", String(volume), sound] },
    { command: "pw-play", label: "pw-play", args: (sound, volume) => ["--volume", String(volume), sound] },
    { command: "paplay", label: "paplay", args: (sound) => [sound] },
    {
      command: "ffplay",
      label: "ffplay",
      args: (sound, volume) => ["-nodisp", "-autoexit", "-volume", String(Math.round(volume * 100)), sound],
    },
  ];
  playerCache = candidates.find((candidate) => executableExists(candidate.command)) ?? null;
  return playerCache;
}

function playSound(category: SoundCategory): {
  played: boolean;
  reason?: string;
  pack?: string;
  sound?: string;
  player?: string;
} {
  const config = readConfig();
  if (!config.enabled_events[category]) return { played: false, reason: `${category} disabled` };

  const pack = choosePack(config, category);
  if (!pack) return { played: false, reason: "no pack available" };

  const soundFiles = walkSoundFiles(join(soundsDir(), pack, category));
  if (soundFiles.length === 0) return { played: false, reason: `no ${category} sounds in ${pack}`, pack };

  const previous = lastPlayed.get(category);
  const candidates = soundFiles.length > 1 ? soundFiles.filter((sound) => sound !== previous) : soundFiles;
  const sound = randomItem(candidates.length > 0 ? candidates : soundFiles);
  lastPlayed.set(category, sound);

  const player = findPlayer();
  if (!player) return { played: false, reason: "no audio player found", pack, sound };

  const child = spawn(player.command, player.args(sound, config.volume), {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();

  return { played: true, pack, sound, player: player.label };
}

function shellSplit(input: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  for (const match of input.matchAll(pattern)) {
    args.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["\\])/g, "$1"));
  }
  return args;
}

function statusText() {
  const config = readConfig();
  const pack = config.active_pack;
  const count =
    pack === "*" ? listPacks().reduce((sum, candidate) => sum + countSounds(candidate), 0) : countSounds(pack);
  const rotation = config.pack_rotation.length > 0 ? `\nRotation: 🎲 ${config.pack_rotation.join(", ")}` : "";
  const player = findPlayer()?.label ?? "none found";
  const events = CATEGORIES.map((category) => `${category}:${config.enabled_events[category] ? "on" : "off"}`).join(
    ", "
  );
  const packLabel = pack === "*" ? "random" : `${packIcon(pack)} ${pack}`;
  return `🎮 Game Sounds\nPack: ${packLabel} (${count} sounds)\nVolume: 🔊 ${config.volume}\nPlayer: ${player}\nEvents: ${events}${rotation}\nConfig: ${configPath()}`;
}

function helpText() {
  return [
    "🎮 /game-sounds commands:",
    "  /game-sounds status",
    "  /game-sounds list",
    "  /game-sounds pack <name|random>",
    "  /game-sounds volume <0.0-1.0>",
    "  /game-sounds rotation add <pack>",
    "  /game-sounds rotation remove <pack>",
    "  /game-sounds rotation clear",
    "  /game-sounds toggle <session-start|task-acknowledge|task-complete|error|permission>",
    "  /game-sounds test [category]",
  ].join("\n");
}

function setPack(packArg: string) {
  const pack = packArg === "random" ? "*" : packArg;
  if (!packExists(pack)) throw new Error(`Pack '${packArg}' not found.`);
  const config = readConfig();
  config.active_pack = pack;
  config.pack_rotation = [];
  writeConfig(config);
  sessionPack = undefined;
  playSound("session-start");
  return `Switched to ${pack === "*" ? "🎲 random pack" : `${packIcon(pack)} ${pack}`} (rotation cleared).`;
}

function setVolume(value: string) {
  const volume = Number(value);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error("Volume must be a number from 0.0 to 1.0.");
  const config = readConfig();
  config.volume = volume;
  writeConfig(config);
  return `🔊 Volume set to ${volume}.`;
}

function rotationCommand(args: string[]) {
  const config = readConfig();
  const subcommand = args[0] ?? "list";
  const pack = args[1];

  if (["add", "a"].includes(subcommand)) {
    if (!pack) throw new Error("Usage: /game-sounds rotation add <pack>");
    if (!packExists(pack) || pack === "*") throw new Error(`Pack '${pack}' not found.`);
    if (!config.pack_rotation.includes(pack)) config.pack_rotation.push(pack);
    writeConfig(config);
    return `🎲 Added ${packIcon(pack)} ${pack} to rotation: ${config.pack_rotation.join(", ")}.`;
  }

  if (["remove", "rm", "r"].includes(subcommand)) {
    if (!pack) throw new Error("Usage: /game-sounds rotation remove <pack>");
    config.pack_rotation = config.pack_rotation.filter((candidate) => candidate !== pack);
    writeConfig(config);
    return `🎲 Removed ${pack} from rotation: ${config.pack_rotation.join(", ") || "(empty)"}.`;
  }

  if (["clear", "c"].includes(subcommand)) {
    config.pack_rotation = [];
    writeConfig(config);
    sessionPack = undefined;
    return "🎲 Rotation cleared.";
  }

  return config.pack_rotation.length > 0
    ? `🎲 Rotation: ${config.pack_rotation.join(", ")}`
    : "🎲 Rotation is empty; using active pack.";
}

function toggleEvent(categoryArg: string | undefined) {
  if (!categoryArg || !isCategory(categoryArg)) {
    throw new Error(`Usage: /game-sounds toggle <${CATEGORIES.join("|")}>`);
  }
  const config = readConfig();
  config.enabled_events[categoryArg] = !config.enabled_events[categoryArg];
  writeConfig(config);
  return `${categoryArg} is now ${config.enabled_events[categoryArg] ? "enabled" : "disabled"}.`;
}

function listText() {
  const config = readConfig();
  return [
    "🎮 Sound Packs",
    "",
    ...listPacks().map((pack) => {
      const active = pack === config.active_pack ? " ← active" : "";
      return `  ${packIcon(pack)} ${pack} (${countSounds(pack)} sounds)${active}`;
    }),
  ].join("\n");
}

export default function gameSoundsExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ensureConfig();
    sessionPack = undefined;
    if (ctx.mode === "tui") playSound("session-start");
  });

  pi.on("input", async (event, ctx) => {
    if (ctx.mode !== "tui" || event.source === "extension" || event.text.trim().length === 0) return;
    playSound("task-acknowledge");
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (ctx.mode === "tui" && event.toolName === "ask_user") playSound("permission");
  });

  pi.on("tool_result", async (event, ctx) => {
    if (ctx.mode !== "tui" || !event.isError) return;
    if (!["bash", "edit", "write"].includes(event.toolName)) return;
    playSound("error");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode === "tui") playSound("task-complete");
  });

  pi.registerCommand("game-sounds", {
    description: "Manage retro game sound effects",
    handler: async (rawArgs, ctx) => {
      const args = shellSplit(rawArgs);
      const command = args[0] ?? "status";

      try {
        if (["help", "--help", "-h"].includes(command)) {
          ctx.ui.notify(helpText(), "info");
          return;
        }

        if (["status", "s"].includes(command)) {
          ctx.ui.notify(statusText(), "info");
          return;
        }

        if (["list", "ls", "l"].includes(command)) {
          ctx.ui.notify(listText(), "info");
          return;
        }

        if (["pack", "switch", "p"].includes(command)) {
          let pack: string | undefined = args[1];
          if (!pack && ctx.hasUI) {
            pack = await ctx.ui.select("Select a sound pack", ["random", ...listPacks()]);
          }
          if (!pack) throw new Error("Usage: /game-sounds pack <name|random>");
          ctx.ui.notify(setPack(pack), "info");
          return;
        }

        if (["volume", "vol", "v"].includes(command)) {
          if (!args[1]) {
            ctx.ui.notify(`🔊 Volume: ${readConfig().volume}`, "info");
            return;
          }
          ctx.ui.notify(setVolume(args[1]), "info");
          return;
        }

        if (["rotation", "rot", "r"].includes(command)) {
          ctx.ui.notify(rotationCommand(args.slice(1)), "info");
          return;
        }

        if (command === "toggle") {
          ctx.ui.notify(toggleEvent(args[1]), "info");
          return;
        }

        if (["test", "t"].includes(command)) {
          const category = args[1] ?? "session-start";
          if (!isCategory(category)) throw new Error(`Unknown category '${category}'.`);
          const result = playSound(category);
          ctx.ui.notify(
            result.played
              ? `🔊 Playing ${category} from ${packIcon(result.pack ?? "")} ${result.pack}.`
              : `Could not play ${category}: ${result.reason ?? "unknown reason"}.`,
            result.played ? "info" : "warning"
          );
          return;
        }

        throw new Error(`Unknown game-sounds command '${command}'. Try /game-sounds help.`);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
