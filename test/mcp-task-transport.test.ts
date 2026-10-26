import assert from "node:assert/strict";
import { test } from "node:test";

import { McpClient, type JsonRpcMessage, type JsonRpcRequest, type McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

import {
  CLIENT_CAPABILITIES_META_KEY,
  PI_PROTOCOL_VERSION,
  TASK_PROTOCOL_VERSION,
  TASKS_EXTENSION_ID,
} from "../extensions/mcp-tasks/task-protocol.ts";
import { TaskAwareTransport } from "../extensions/mcp-tasks/task-transport.ts";

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

interface Harness {
  client: McpClient;
  transport: TaskAwareTransport;
  requests: JsonRpcRequest[];
  close(): Promise<void>;
}

function taskTestSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds < 1_000) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal?.reason ?? new Error("aborted"));
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    void resolve;
  });
}

async function createHarness(
  respond: (request: JsonRpcRequest, server: McpTransport) => void | Promise<void>,
  options: ConstructorParameters<typeof TaskAwareTransport>[1] = { sleep: taskTestSleep },
  hangPollSend = false
): Promise<Harness> {
  const pair = createInMemoryTransportPair();
  const requests: JsonRpcRequest[] = [];
  pair.server.onMessage((message) => {
    if (!isRequest(message)) return;
    requests.push(message);
    void (async () => {
      if (message.method === "server/discover") {
        await pair.server.send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            _meta: { "io.modelcontextprotocol/serverInfo": { name: "task-test", version: "1" } },
            supportedVersions: [TASK_PROTOCOL_VERSION],
            capabilities: { tools: {}, extensions: { [TASKS_EXTENSION_ID]: {} } },
            resultType: "complete",
          },
        });
        return;
      }
      if (message.method === "tools/list") {
        await pair.server.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "query", inputSchema: { type: "object", properties: {} } }] },
        });
        return;
      }
      await respond(message, pair.server);
    })();
  });
  await pair.server.start();
  const clientTransport: McpTransport = hangPollSend
    ? {
        start: () => pair.client.start(),
        send: async (message, sendOptions) => {
          await pair.client.send(message, sendOptions);
          if (isRequest(message) && message.method === "tasks/get") {
            await new Promise<void>(() => {});
          }
        },
        close: () => pair.client.close(),
        onMessage: (listener) => pair.client.onMessage(listener),
        onError: (listener) => pair.client.onError(listener),
        onClose: (listener) => pair.client.onClose(listener),
      }
    : pair.client;
  const transport = new TaskAwareTransport(clientTransport, options);
  const client = new McpClient({ name: "test", version: "1", requestTimeoutMs: 1_000 });
  const initialized = await client.connect(transport);
  assert.equal(initialized.protocolVersion, PI_PROTOCOL_VERSION);
  return { client, transport, requests, close: () => client.close() };
}

function assertTaskCapability(request: JsonRpcRequest): void {
  const params = request.params as Record<string, unknown>;
  const meta = params._meta as Record<string, unknown>;
  const capabilities = meta[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown>;
  const extensions = capabilities.extensions as Record<string, unknown>;
  assert.deepEqual(extensions[TASKS_EXTENSION_ID], {});
}

test("initialization advertises tasks and immediate tool results pass through", async () => {
  const harness = await createHarness(async (request, server) => {
    if (request.method === "tools/call") {
      await server.send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "now" }] } });
    }
  });
  try {
    const discover = harness.requests[0];
    assert.equal(discover.method, "server/discover");
    const meta = (discover.params as Record<string, unknown>)._meta as Record<string, unknown>;
    assert.equal(meta["io.modelcontextprotocol/protocolVersion"], TASK_PROTOCOL_VERSION);
    const capabilities = meta[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown>;
    assert.deepEqual((capabilities.extensions as Record<string, unknown>)[TASKS_EXTENSION_ID], {});

    const result = await harness.client.callTool("query");
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "now");
  } finally {
    await harness.close();
  }
});

test("task calls poll to an embedded CallToolResult and emit progress", async () => {
  let polls = 0;
  let originalProgressToken: unknown;
  const progress: unknown[] = [];
  const harness = await createHarness(async (request, server) => {
    if (request.method === "tools/call") {
      assertTaskCapability(request);
      originalProgressToken = ((request.params as Record<string, unknown>)._meta as Record<string, unknown>)
        .progressToken;
      await server.send({
        jsonrpc: "2.0",
        id: request.id,
        result: { resultType: "task", taskId: "task-1", status: "working", pollIntervalMs: 1 },
      });
    } else if (request.method === "tasks/get") {
      assertTaskCapability(request);
      assert.equal(
        ((request.params as Record<string, unknown>)._meta as Record<string, unknown>).progressToken,
        originalProgressToken
      );
      polls++;
      await server.send({
        jsonrpc: "2.0",
        id: request.id,
        result:
          polls === 1
            ? { resultType: "complete", taskId: "task-1", status: "working", pollIntervalMs: 1 }
            : {
                resultType: "complete",
                taskId: "task-1",
                status: "completed",
                result: {
                  content: [{ type: "text", text: "done" }],
                  structuredContent: { artifact: "report.parquet" },
                },
              },
      });
    }
  });
  try {
    const result = await harness.client.callTool("query", {}, { onProgress: (event) => progress.push(event) });
    assert.equal(polls, 2);
    assert.deepEqual(result.structuredContent, { artifact: "report.parquet" });
    assert.ok(progress.length >= 2);
  } finally {
    await harness.close();
  }
});

test("failed, cancelled, and input-required tasks become ordinary tool errors", async () => {
  for (const [status, expected] of [
    ["failed", "warehouse unavailable"],
    ["cancelled", "was cancelled"],
    ["input_required", "requires input"],
  ] as const) {
    const harness = await createHarness(async (request, server) => {
      if (request.method === "tools/call") {
        await server.send({
          jsonrpc: "2.0",
          id: request.id,
          result: { resultType: "task", taskId: `task-${status}`, status: "working" },
        });
      } else if (request.method === "tasks/get") {
        await server.send({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            resultType: "complete",
            taskId: `task-${status}`,
            status,
            ...(status === "failed" ? { error: { code: -1, message: "warehouse unavailable" } } : {}),
          },
        });
      }
    });
    try {
      const result = await harness.client.callTool("query");
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", new RegExp(expected));
    } finally {
      await harness.close();
    }
  }
});

test("concurrent task calls keep out-of-order responses correlated", async () => {
  const harness = await createHarness(async (request, server) => {
    if (request.method === "tools/call") {
      const name = ((request.params as Record<string, unknown>).arguments as Record<string, string>).name;
      await server.send({
        jsonrpc: "2.0",
        id: request.id,
        result: { resultType: "task", taskId: `task-${name}`, status: "working" },
      });
    } else if (request.method === "tasks/get") {
      const taskId = (request.params as Record<string, string>).taskId;
      if (taskId === "task-first") await new Promise((resolve) => setTimeout(resolve, 5));
      await server.send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          resultType: "complete",
          taskId,
          status: "completed",
          result: { content: [{ type: "text", text: taskId }] },
        },
      });
    }
  });
  try {
    const [first, second] = await Promise.all([
      harness.client.callTool("query", { name: "first" }),
      harness.client.callTool("query", { name: "second" }),
    ]);
    assert.equal(first.content[0]?.type === "text" ? first.content[0].text : "", "task-first");
    assert.equal(second.content[0]?.type === "text" ? second.content[0].text : "", "task-second");
  } finally {
    await harness.close();
  }
});

test("aborting an accepted task sends exactly one best-effort cancellation", async () => {
  let resolveAccepted: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => {
    resolveAccepted = resolve;
  });
  let cancellations = 0;
  const harness = await createHarness(async (request, server) => {
    if (request.method === "tools/call") {
      await server.send({
        jsonrpc: "2.0",
        id: request.id,
        result: { resultType: "task", taskId: "task-abort", status: "working", pollIntervalMs: 10_000 },
      });
      resolveAccepted?.();
    } else if (request.method === "tasks/cancel") {
      cancellations++;
      await server.send({ jsonrpc: "2.0", id: request.id, result: { resultType: "complete" } });
    }
  }, {});
  try {
    const controller = new AbortController();
    const call = harness.client.callTool("query", {}, { signal: controller.signal });
    await accepted;
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(call);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancellations, 1);
  } finally {
    await harness.close();
  }
});

test("older servers keep their negotiated protocol and ordinary tool behavior", async () => {
  const pair = createInMemoryTransportPair();
  let callRequest: JsonRpcRequest | undefined;
  pair.server.onMessage((message) => {
    if (!isRequest(message)) return;
    void (async () => {
      if (message.method === "server/discover") {
        await pair.server.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
      } else if (message.method === "initialize") {
        await pair.server.send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: PI_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "legacy", version: "1" },
          },
        });
      } else if (message.method === "tools/call") {
        callRequest = message;
        await pair.server.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "legacy" }] },
        });
      }
    })();
  });
  await pair.server.start();
  const transport = new TaskAwareTransport(pair.client);
  const client = new McpClient({ name: "test", version: "1" });
  try {
    const initialized = await client.connect(transport);
    assert.equal(initialized.protocolVersion, PI_PROTOCOL_VERSION);
    const result = await client.callTool("query");
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "legacy");
    const meta = (callRequest?.params as Record<string, unknown> | undefined)?._meta;
    assert.equal(meta, undefined);
  } finally {
    await client.close();
  }
});

test("the overall deadline expires while a tasks/get transport send is still pending", async () => {
  let polls = 0;
  const harness = await createHarness(
    async (request, server) => {
      if (request.method === "tools/call") {
        await server.send({
          jsonrpc: "2.0",
          id: request.id,
          result: { resultType: "task", taskId: "task-stalled", status: "working", pollIntervalMs: 1 },
        });
      } else if (request.method === "tasks/get") {
        polls++;
      }
    },
    {
      overallTimeoutMs: 10,
      minimumPollIntervalMs: 1,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    },
    true
  );
  try {
    const result = await harness.client.callTool("query");
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /deadline/);
    assert.equal(polls, 1);
  } finally {
    await harness.close();
  }
});

test("malformed task envelopes and overall deadline expiry become tool errors", async () => {
  for (const malformed of [true, false]) {
    const harness = await createHarness(
      async (request, server) => {
        if (request.method !== "tools/call") return;
        await server.send({
          jsonrpc: "2.0",
          id: request.id,
          result: malformed
            ? { resultType: "task", status: "working" }
            : { resultType: "task", taskId: "task-deadline", status: "working" },
        });
      },
      malformed ? { sleep: taskTestSleep } : { overallTimeoutMs: 0, sleep: taskTestSleep }
    );
    try {
      const result = await harness.client.callTool("query");
      assert.equal(result.isError, true);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      assert.match(text, malformed ? /taskId/ : /deadline/);
    } finally {
      await harness.close();
    }
  }
});
