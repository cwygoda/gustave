import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { StdioTransport, StreamableHttpTransport, type AuthProvider } from "@earendil-works/pi-mcp";

import {
  createConfiguredTransport,
  createModernProtocolFetch,
  createTaskCapableTransport,
  expandHome,
  resolveConfigValue,
} from "../extensions/mcp-tasks/default-transport.ts";
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  TASK_PROTOCOL_VERSION,
  TASKS_EXTENSION_ID,
} from "../extensions/mcp-tasks/task-protocol.ts";

test("default HTTP transport resolves headers and preserves the auth provider by identity", () => {
  const previous = process.env.TOKEN;
  process.env.TOKEN = "secret";
  try {
    const authProvider = {} as AuthProvider;
    const transport = createConfiguredTransport(
      {
        name: "remote",
        config: {
          url: "https://example.test/mcp",
          headers: { Authorization: `Bearer $\{TOKEN}`, Literal: "value" },
        },
      },
      "/workspace",
      authProvider
    );
    assert.ok(transport instanceof StreamableHttpTransport);
    assert.equal(transport.options.authProvider, authProvider);
    assert.deepEqual(transport.options.headers, { Authorization: "Bearer secret", Literal: "value" });
  } finally {
    if (previous === undefined) delete process.env.TOKEN;
    else process.env.TOKEN = previous;
  }
});

test("modern HTTP requests derive routing headers from their metadata envelope", async () => {
  let captured: RequestInit | undefined;
  const modernFetch = createModernProtocolFetch(async (_input, init) => {
    captured = init;
    return new Response(null, { status: 202 });
  });

  await modernFetch("https://example.test/mcp", {
    method: "POST",
    headers: { Existing: "value" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "query",
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: TASK_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXTENSION_ID]: {} } },
        },
      },
    }),
  });

  const headers = new Headers(captured?.headers);
  assert.equal(headers.get("existing"), "value");
  assert.equal(headers.get("mcp-protocol-version"), TASK_PROTOCOL_VERSION);
  assert.equal(headers.get("mcp-method"), "tools/call");
  assert.equal(headers.get("mcp-name"), "query");
});

test("default stdio transport expands paths, resolves cwd, and inherits the environment", () => {
  const previous = process.env.MCP_TEST_VALUE;
  process.env.MCP_TEST_VALUE = "resolved";
  try {
    const transport = createConfiguredTransport(
      {
        name: "local",
        config: {
          command: "~/bin/server",
          args: ["~/data", "literal"],
          cwd: "services/mcp",
          env: { VALUE: `$\{MCP_TEST_VALUE}` },
        },
      },
      "/workspace",
      undefined
    );
    assert.ok(transport instanceof StdioTransport);
    assert.equal(transport.options.command, join(homedir(), "bin/server"));
    assert.deepEqual(transport.options.args, [join(homedir(), "data"), "literal"]);
    assert.equal(transport.options.cwd, resolve("/workspace", "services/mcp"));
    assert.deepEqual(transport.options.env, { VALUE: "resolved" });
    assert.equal(transport.options.inheritEnv, true);
    assert.equal(transport.options.stderr, "pipe");
  } finally {
    if (previous === undefined) delete process.env.MCP_TEST_VALUE;
    else process.env.MCP_TEST_VALUE = previous;
  }
});

test("task decoration preserves concrete transport identity and diagnostics", () => {
  const factory = createTaskCapableTransport();
  const stdio = factory({ name: "local", config: { command: "server" } }, "/workspace", undefined);
  assert.ok(stdio instanceof StdioTransport);
  assert.equal(typeof stdio.stderr, "string");

  const authProvider = {} as AuthProvider;
  const http = factory({ name: "remote", config: { url: "https://example.test/mcp" } }, "/workspace", authProvider);
  assert.ok(http instanceof StreamableHttpTransport);
  assert.equal(http.options.authProvider, authProvider);
});

test("configuration values support literals, interpolation, escaping, and whole-value commands", () => {
  const env = { HOME_NAME: "gustave" } as NodeJS.ProcessEnv;
  assert.equal(resolveConfigValue(`hello $\{HOME_NAME}`, "test", env), "hello gustave");
  assert.equal(resolveConfigValue("$HOME_NAME/$$/$!", "test", env), "gustave/$/!");
  assert.equal(resolveConfigValue("!printf command-value", "test", env), "command-value");
  assert.throws(() => resolveConfigValue(`$\{MISSING}`, "test", env), /MISSING/);
  assert.equal(expandHome("~"), homedir());
});
