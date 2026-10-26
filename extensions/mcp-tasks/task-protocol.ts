import type { CallToolResult } from "@earendil-works/pi-mcp";

export const TASK_PROTOCOL_VERSION = "2026-07-28";
export const PI_PROTOCOL_VERSION = "2025-11-25";
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

export const TASK_STATUSES = ["working", "input_required", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskFields {
  taskId: string;
  status: TaskStatus;
  createdAt?: string;
  lastUpdatedAt?: string;
  ttlMs?: number | null;
  statusMessage?: string;
  pollIntervalMs?: number;
  [key: string]: unknown;
}

export interface CreateTaskResult extends TaskFields {
  resultType: "task";
}

export interface GetTaskResult extends TaskFields {
  resultType?: "complete";
  result?: unknown;
  error?: unknown;
  inputRequests?: Record<string, unknown>;
}

export class TaskProtocolError extends Error {}
export class TaskFailedError extends Error {}
export class TaskCancelledError extends Error {}
export class TaskInputRequiredError extends Error {}
export class TaskDeadlineError extends Error {}
export class TaskTransportClosedError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function hasTaskResultDiscriminator(value: unknown): boolean {
  return isRecord(value) && value.resultType === "task";
}

function validateTaskFields(value: unknown, context: string): asserts value is TaskFields {
  if (!isRecord(value)) throw new TaskProtocolError(`${context} must be an object`);
  if (typeof value.taskId !== "string" || value.taskId.length === 0) {
    throw new TaskProtocolError(`${context} is missing a non-empty taskId`);
  }
  if (!isTaskStatus(value.status)) throw new TaskProtocolError(`${context} has an invalid status`);
  for (const field of ["createdAt", "lastUpdatedAt", "statusMessage"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new TaskProtocolError(`${context}.${field} must be a string`);
    }
  }
  if (
    value.ttlMs !== undefined &&
    value.ttlMs !== null &&
    (typeof value.ttlMs !== "number" || !Number.isFinite(value.ttlMs) || value.ttlMs < 0)
  ) {
    throw new TaskProtocolError(`${context}.ttlMs must be a non-negative number or null`);
  }
  if (
    value.pollIntervalMs !== undefined &&
    (typeof value.pollIntervalMs !== "number" || !Number.isFinite(value.pollIntervalMs) || value.pollIntervalMs < 0)
  ) {
    throw new TaskProtocolError(`${context}.pollIntervalMs must be a non-negative number`);
  }
}

export function parseCreateTaskResult(value: unknown): CreateTaskResult {
  validateTaskFields(value, "task creation result");
  if (value.resultType !== "task") throw new TaskProtocolError("task creation result has an invalid resultType");
  return value as CreateTaskResult;
}

export function parseGetTaskResult(value: unknown, expectedTaskId: string): GetTaskResult {
  validateTaskFields(value, "tasks/get result");
  if (value.taskId !== expectedTaskId) {
    throw new TaskProtocolError(`tasks/get returned task ${value.taskId} while polling ${expectedTaskId}`);
  }
  if (value.resultType !== undefined && value.resultType !== "complete") {
    throw new TaskProtocolError("tasks/get result has an invalid resultType");
  }
  return value as GetTaskResult;
}

export function parseTerminalToolResult(value: unknown): CallToolResult {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new TaskProtocolError("completed task is missing an embedded CallToolResult");
  }
  if (value.isError !== undefined && typeof value.isError !== "boolean") {
    throw new TaskProtocolError("completed task result has an invalid isError value");
  }
  return value as unknown as CallToolResult;
}

export function taskErrorMessage(task: GetTaskResult): string {
  if (isRecord(task.error) && typeof task.error.message === "string" && task.error.message.length > 0) {
    return task.error.message;
  }
  if (task.statusMessage) return task.statusMessage;
  return `Task ${task.taskId} failed`;
}

export function withTaskCapabilityMeta(params: unknown): Record<string, unknown> {
  const source = isRecord(params) ? params : {};
  const meta = isRecord(source._meta) ? source._meta : {};
  const clientCapabilities = isRecord(meta[CLIENT_CAPABILITIES_META_KEY]) ? meta[CLIENT_CAPABILITIES_META_KEY] : {};
  const extensions = isRecord(clientCapabilities.extensions) ? clientCapabilities.extensions : {};
  return {
    ...source,
    _meta: {
      ...meta,
      [PROTOCOL_VERSION_META_KEY]: TASK_PROTOCOL_VERSION,
      [CLIENT_CAPABILITIES_META_KEY]: {
        ...clientCapabilities,
        extensions: { ...extensions, [TASKS_EXTENSION_ID]: {} },
      },
    },
  };
}
