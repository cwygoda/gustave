import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  StdioTransport,
  StreamableHttpTransport,
  type AuthProvider,
  type McpFetch,
  type McpTransport,
} from "@earendil-works/pi-mcp";

import { PROTOCOL_VERSION_META_KEY, isRecord } from "./task-protocol.ts";
import { TaskAwareTransport, type TaskTransportOptions } from "./task-transport.ts";

interface BaseConfig {
  enabled?: boolean;
  exposure?: string;
  timeout?: number;
  description?: string;
}

interface HttpConfig extends BaseConfig {
  url: string;
  headers?: Record<string, string>;
}

interface StdioConfig extends BaseConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpServerEntryLike {
  name: string;
  config: HttpConfig | StdioConfig;
  source?: string;
  scope?: string;
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENVIRONMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;
const MCP_NAME_FIELDS: Readonly<Record<string, string>> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
  "tasks/get": "taskId",
  "tasks/update": "taskId",
  "tasks/cancel": "taskId",
};

function encodeMcpName(value: string): string {
  const plainAscii =
    value.length > 0 &&
    value === value.trim() &&
    !(value.startsWith("=?base64?") && value.endsWith("?=")) &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || (code >= 32 && code <= 126);
    });
  return plainAscii ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function createModernProtocolFetch(baseFetch: McpFetch = (input, init) => fetch(input, init)): McpFetch {
  return async (input, init) => {
    if (typeof init?.body !== "string") return baseFetch(input, init);

    let message: unknown;
    try {
      message = JSON.parse(init.body);
    } catch {
      return baseFetch(input, init);
    }
    if (!isRecord(message) || typeof message.method !== "string" || !("id" in message)) {
      return baseFetch(input, init);
    }
    const params = isRecord(message.params) ? message.params : {};
    const meta = isRecord(params._meta) ? params._meta : {};
    const protocolVersion = meta[PROTOCOL_VERSION_META_KEY];
    if (typeof protocolVersion !== "string") return baseFetch(input, init);

    const headers = new Headers(init.headers);
    headers.set("MCP-Protocol-Version", protocolVersion);
    headers.set("MCP-Method", message.method);
    const nameField = MCP_NAME_FIELDS[message.method];
    const name = nameField ? params[nameField] : undefined;
    if (typeof name === "string") headers.set("MCP-Name", encodeMcpName(name));
    return baseFetch(input, { ...init, headers });
  };
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function resolveConfigValue(value: string, description: string, env: NodeJS.ProcessEnv = process.env): string {
  if (value.startsWith("!")) {
    try {
      const output = execSync(value.slice(1), {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (output) return output;
    } catch {
      // The error below names the configuration field without exposing command output.
    }
    throw new Error(`Failed to resolve ${description} from shell command: ${value.slice(1)}`);
  }

  let output = "";
  const missing = new Set<string>();
  for (let index = 0; index < value.length; ) {
    const dollar = value.indexOf("$", index);
    if (dollar < 0) {
      output += value.slice(index);
      break;
    }
    output += value.slice(index, dollar);
    const next = value[dollar + 1];
    if (next === "$" || next === "!") {
      output += next;
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = value.indexOf("}", dollar + 2);
      if (end >= 0) {
        const name = value.slice(dollar + 2, end);
        if (ENVIRONMENT_NAME.test(name)) {
          const resolved = env[name];
          if (resolved === undefined || resolved === "") missing.add(name);
          else output += resolved;
          index = end + 1;
          continue;
        }
      }
    } else {
      const match = value.slice(dollar + 1).match(ENVIRONMENT_PREFIX)?.[0];
      if (match) {
        const resolved = env[match];
        if (resolved === undefined || resolved === "") missing.add(match);
        else output += resolved;
        index = dollar + 1 + match.length;
        continue;
      }
    }
    output += "$";
    index = dollar + 1;
  }

  if (missing.size === 1) {
    throw new Error(`Failed to resolve ${description} from environment variable: ${[...missing][0]}`);
  }
  if (missing.size > 1) {
    throw new Error(`Failed to resolve ${description} from environment variables: ${[...missing].join(", ")}`);
  }
  return output;
}

export function createConfiguredTransport(
  entry: McpServerEntryLike,
  cwd: string,
  authProvider: AuthProvider | undefined
): McpTransport {
  const { config, name } = entry;
  if ("url" in config) {
    const headers = config.headers
      ? Object.fromEntries(
          Object.entries(config.headers).map(([key, value]) => [
            key,
            resolveConfigValue(value, `MCP server "${name}" header "${key}"`),
          ])
        )
      : undefined;
    return new StreamableHttpTransport({
      url: config.url,
      headers,
      authProvider,
      fetch: createModernProtocolFetch(),
    });
  }

  const env = Object.fromEntries(
    Object.entries(config.env ?? {}).map(([key, value]) => [
      key,
      resolveConfigValue(value, `MCP server "${name}" env "${key}"`),
    ])
  );
  return new StdioTransport({
    command: expandHome(config.command),
    args: config.args?.map(expandHome),
    cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
    env,
    inheritEnv: true,
    stderr: "pipe",
  });
}

export function decorateTaskTransport(transport: McpTransport, options: TaskTransportOptions = {}): McpTransport {
  const taskAware = new TaskAwareTransport(transport, options);
  const delegated = new Set(["start", "send", "close", "onMessage", "onError", "onClose", "setProtocolVersion"]);
  return new Proxy(transport, {
    get(target, property) {
      if (typeof property === "string" && delegated.has(property)) {
        const value = taskAware[property as keyof TaskAwareTransport];
        return typeof value === "function" ? value.bind(taskAware) : value;
      }
      return Reflect.get(target, property, target);
    },
  });
}

export function createTaskCapableTransport(options: TaskTransportOptions = {}) {
  return (entry: McpServerEntryLike, cwd: string, authProvider: AuthProvider | undefined): McpTransport =>
    decorateTaskTransport(createConfiguredTransport(entry, cwd, authProvider), options);
}
