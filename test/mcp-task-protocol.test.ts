import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  TASK_PROTOCOL_VERSION,
  TASKS_EXTENSION_ID,
  TaskProtocolError,
  parseCreateTaskResult,
  parseGetTaskResult,
  parseTerminalToolResult,
  withTaskCapabilityMeta,
} from "../extensions/mcp-tasks/task-protocol.ts";

const task = {
  resultType: "task" as const,
  taskId: "task-1",
  status: "working" as const,
  createdAt: "2026-01-01T00:00:00Z",
  lastUpdatedAt: "2026-01-01T00:00:00Z",
  ttlMs: 60_000,
  pollIntervalMs: 25,
  futureField: { preserved: true },
};

test("task protocol accepts task envelopes and preserves unknown fields", () => {
  assert.strictEqual(parseCreateTaskResult(task), task);
  assert.deepEqual(parseCreateTaskResult(task).futureField, { preserved: true });
});

test("task protocol rejects malformed and cross-task responses", () => {
  assert.throws(() => parseCreateTaskResult({ resultType: "task", status: "working" }), TaskProtocolError);
  assert.throws(
    () => parseGetTaskResult({ ...task, resultType: "complete", taskId: "other" }, "task-1"),
    /while polling/
  );
  assert.throws(() => parseTerminalToolResult({ structuredContent: {} }), /CallToolResult/);
});

test("task capability metadata merges without dropping caller metadata", () => {
  const params = withTaskCapabilityMeta({
    name: "query",
    _meta: {
      progressToken: "progress-1",
      [CLIENT_CAPABILITIES_META_KEY]: { roots: {}, extensions: { "vendor/example": { enabled: true } } },
      vendor: 42,
    },
  });
  assert.deepEqual(params, {
    name: "query",
    _meta: {
      progressToken: "progress-1",
      [PROTOCOL_VERSION_META_KEY]: TASK_PROTOCOL_VERSION,
      [CLIENT_CAPABILITIES_META_KEY]: {
        roots: {},
        extensions: { "vendor/example": { enabled: true }, [TASKS_EXTENSION_ID]: {} },
      },
      vendor: 42,
    },
  });
});
