import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
  McpTransportCloseListener,
  McpTransportErrorListener,
  McpTransportMessageListener,
  McpTransportSendOptions,
} from "@earendil-works/pi-mcp";

import {
  CLIENT_INFO_META_KEY,
  PI_PROTOCOL_VERSION,
  SERVER_INFO_META_KEY,
  TASK_PROTOCOL_VERSION,
  TASKS_EXTENSION_ID,
  TaskCancelledError,
  TaskDeadlineError,
  TaskFailedError,
  TaskInputRequiredError,
  TaskProtocolError,
  TaskTransportClosedError,
  hasTaskResultDiscriminator,
  isRecord,
  parseCreateTaskResult,
  parseGetTaskResult,
  parseTerminalToolResult,
  taskErrorMessage,
  withTaskCapabilityMeta,
  type CreateTaskResult,
  type GetTaskResult,
} from "./task-protocol.ts";

export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("The operation was aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(signal?.reason ?? new Error("The operation was aborted"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export interface TaskTransportOptions {
  overallTimeoutMs?: number;
  minimumPollIntervalMs?: number;
  maximumPollIntervalMs?: number;
  sleep?: Sleep;
  now?: () => number;
}

interface PollWaiter {
  state: CallState;
  resolve: (response: JsonRpcResponse) => void;
}

interface CallState {
  originalId: JsonRpcId;
  progressToken?: JsonRpcId;
  requestMeta?: Record<string, unknown>;
  deadline: number;
  signal: AbortController;
  sourceSignal?: AbortSignal;
  onSourceAbort?: () => void;
  task?: CreateTaskResult;
  pollIds: Set<JsonRpcId>;
  terminal: boolean;
  cancelSent: boolean;
}

const DEFAULT_OVERALL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MINIMUM_POLL_INTERVAL_MS = 20;
const DEFAULT_MAXIMUM_POLL_INTERVAL_MS = 5_000;

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && !("method" in message);
}

function progressToken(params: unknown): JsonRpcId | undefined {
  if (!isRecord(params) || !isRecord(params._meta)) return undefined;
  const token = params._meta.progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TaskAwareTransport implements McpTransport {
  private readonly messageListeners = new Set<McpTransportMessageListener>();
  private readonly errorListeners = new Set<McpTransportErrorListener>();
  private readonly closeListeners = new Set<McpTransportCloseListener>();
  private readonly calls = new Map<JsonRpcId, CallState>();
  private readonly polls = new Map<JsonRpcId, PollWaiter>();
  private readonly tasks = new Map<string, CallState>();
  private readonly ignoredResponses = new Map<JsonRpcId, number>();
  private readonly transport: McpTransport;
  private readonly options: Required<TaskTransportOptions>;
  private readonly disposers: (() => void)[];
  private initializeId: JsonRpcId | undefined;
  private initializeRequest: JsonRpcRequest | undefined;
  private initializeOptions: McpTransportSendOptions | undefined;
  private probingModernProtocol = false;
  private negotiatedProtocol: string | undefined;
  private tasksEnabled = false;
  private cancellationSupported = false;
  private internalId = 0;
  private closed = false;
  private closeEmitted = false;

  constructor(transport: McpTransport, options: TaskTransportOptions = {}) {
    this.transport = transport;
    const minimumPollIntervalMs = options.minimumPollIntervalMs ?? DEFAULT_MINIMUM_POLL_INTERVAL_MS;
    const maximumPollIntervalMs = options.maximumPollIntervalMs ?? DEFAULT_MAXIMUM_POLL_INTERVAL_MS;
    if (minimumPollIntervalMs < 0 || maximumPollIntervalMs < minimumPollIntervalMs) {
      throw new Error("Invalid MCP task poll interval bounds");
    }
    this.options = {
      overallTimeoutMs: options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS,
      minimumPollIntervalMs,
      maximumPollIntervalMs,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? Date.now,
    };
    this.disposers = [
      transport.onMessage((message) => this.handleMessage(message)),
      transport.onError((error) => this.emitError(error)),
      transport.onClose(() => this.handleClose()),
    ];
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  async send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void> {
    if (this.closed) throw new TaskTransportClosedError("MCP task transport is closed");

    if (isRequest(message) && message.method === "initialize") {
      this.initializeId = message.id;
      this.initializeRequest = message;
      this.initializeOptions = options;
      this.probingModernProtocol = true;
      const params = isRecord(message.params) ? message.params : {};
      const clientInfo = isRecord(params.clientInfo) ? params.clientInfo : {};
      try {
        await this.transport.send(
          {
            jsonrpc: "2.0",
            id: message.id,
            method: "server/discover",
            params: withTaskCapabilityMeta({ _meta: { [CLIENT_INFO_META_KEY]: clientInfo } }),
          },
          options
        );
      } catch {
        await this.fallbackToLegacyInitialize();
      }
      return;
    }

    if (isNotification(message) && message.method === "notifications/initialized" && this.tasksEnabled) {
      return;
    }

    if (isRequest(message) && message.method === "tools/call" && this.tasksEnabled) {
      const state = this.createCallState(message, options?.signal);
      this.calls.set(message.id, state);
      this.watchSourceAbort(state);
      try {
        await this.transport.send({ ...message, params: withTaskCapabilityMeta(message.params) }, options);
      } catch (error) {
        this.cleanup(state);
        throw error;
      }
      return;
    }

    if (isNotification(message) && message.method === "notifications/cancelled") {
      const requestId = isRecord(message.params) ? message.params.requestId : undefined;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const state = this.calls.get(requestId);
        if (state) this.abortCall(state, new TaskCancelledError(`Task call ${requestId} was cancelled`));
      }
    }

    await this.transport.send(
      isRequest(message) && this.tasksEnabled
        ? { ...message, params: withTaskCapabilityMeta(message.params) }
        : message,
      options
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = [...this.calls.values()];
    for (const state of active) {
      state.signal.abort(new TaskTransportClosedError("MCP task transport closed"));
      this.cleanup(state);
    }
    const cancelling = Promise.allSettled(active.map((state) => this.cancelTask(state)));
    const cancelWait = new AbortController();
    try {
      await Promise.race([cancelling, defaultSleep(250, cancelWait.signal)]);
    } finally {
      cancelWait.abort();
    }
    this.polls.clear();
    this.tasks.clear();
    this.ignoredResponses.clear();
    for (const dispose of this.disposers.splice(0)) dispose();
    await this.transport.close();
    this.emitClose();
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: McpTransportErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: McpTransportCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(
      version === PI_PROTOCOL_VERSION && this.negotiatedProtocol === TASK_PROTOCOL_VERSION
        ? TASK_PROTOCOL_VERSION
        : version
    );
  }

  private createCallState(message: JsonRpcRequest, sourceSignal?: AbortSignal): CallState {
    const signal = new AbortController();
    const state: CallState = {
      originalId: message.id,
      progressToken: progressToken(message.params),
      requestMeta: isRecord(message.params) && isRecord(message.params._meta) ? { ...message.params._meta } : undefined,
      deadline: this.options.now() + this.options.overallTimeoutMs,
      signal,
      sourceSignal,
      pollIds: new Set(),
      terminal: false,
      cancelSent: false,
    };
    return state;
  }

  private watchSourceAbort(state: CallState): void {
    if (!state.sourceSignal) return;
    const sourceSignal = state.sourceSignal;
    state.onSourceAbort = () =>
      this.abortCall(state, sourceSignal.reason ?? new TaskCancelledError("Task call aborted"));
    sourceSignal.addEventListener("abort", state.onSourceAbort, { once: true });
    if (sourceSignal.aborted) state.onSourceAbort();
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (!isResponse(message)) {
      this.emitMessage(message);
      return;
    }

    if (message.id === this.initializeId) {
      this.handleInitializeResponse(message);
      return;
    }

    const waiter = this.polls.get(message.id);
    if (waiter) {
      this.polls.delete(message.id);
      waiter.state.pollIds.delete(message.id);
      waiter.resolve(message);
      return;
    }

    if (typeof message.id === "string" && message.id.startsWith("gustave-task:")) return;
    this.pruneIgnoredResponses();
    if (this.ignoredResponses.delete(message.id)) return;

    const state = this.calls.get(message.id);
    if (!state) {
      this.emitMessage(message);
      return;
    }

    if ("error" in message) {
      this.cleanup(state);
      this.emitMessage(message);
      return;
    }

    if (!hasTaskResultDiscriminator(message.result)) {
      this.cleanup(state);
      this.emitMessage(message);
      return;
    }

    try {
      const task = parseCreateTaskResult(message.result);
      state.task = task;
      this.tasks.set(task.taskId, state);
      this.emitProgress(state, task, 0);
      void this.driveTask(state).catch((error) => this.completeWithError(state, error));
    } catch (error) {
      this.completeWithError(state, error);
    }
  }

  private handleInitializeResponse(message: JsonRpcResponse): void {
    if (!this.probingModernProtocol) {
      this.initializeId = undefined;
      this.initializeRequest = undefined;
      this.initializeOptions = undefined;
      this.emitMessage(message);
      return;
    }
    if ("error" in message || !isRecord(message.result)) {
      void this.fallbackToLegacyInitialize().catch((error) => this.emitError(error as Error));
      return;
    }

    const supportedVersions = Array.isArray(message.result.supportedVersions) ? message.result.supportedVersions : [];
    const capabilities = isRecord(message.result.capabilities) ? message.result.capabilities : {};
    const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : {};
    const serverMeta = isRecord(message.result._meta) ? message.result._meta : {};
    const serverInfo = isRecord(serverMeta[SERVER_INFO_META_KEY])
      ? serverMeta[SERVER_INFO_META_KEY]
      : { name: "mcp-server", version: "unknown" };
    this.tasksEnabled = supportedVersions.includes(TASK_PROTOCOL_VERSION);
    if (!this.tasksEnabled) {
      void this.fallbackToLegacyInitialize().catch((error) => this.emitError(error as Error));
      return;
    }

    this.initializeId = undefined;
    this.initializeRequest = undefined;
    this.initializeOptions = undefined;
    this.probingModernProtocol = false;
    this.negotiatedProtocol = TASK_PROTOCOL_VERSION;
    const taskSettings = extensions[TASKS_EXTENSION_ID];
    this.cancellationSupported = isRecord(taskSettings) && taskSettings.cancel !== false;
    this.emitMessage({
      ...message,
      result: {
        protocolVersion: PI_PROTOCOL_VERSION,
        capabilities,
        serverInfo,
        ...(typeof message.result.instructions === "string" ? { instructions: message.result.instructions } : {}),
      },
    });
  }

  private async fallbackToLegacyInitialize(): Promise<void> {
    const request = this.initializeRequest;
    if (!request) throw new TaskProtocolError("modern MCP discovery failed without an initialize request");
    const options = this.initializeOptions;
    this.probingModernProtocol = false;
    this.tasksEnabled = false;
    this.negotiatedProtocol = undefined;
    await this.transport.send(request, options);
  }

  private async driveTask(state: CallState): Promise<void> {
    if (!state.task) throw new TaskProtocolError("task call has no task creation result");
    const taskId = state.task.taskId;
    let pollIntervalMs = state.task.pollIntervalMs;
    let progress = 1;

    while (!state.terminal) {
      this.throwIfStopped(state);
      await this.sleepForPoll(state, pollIntervalMs);
      this.throwIfStopped(state);
      const response = await this.poll(state, taskId);
      if ("error" in response) throw new TaskProtocolError(`tasks/get failed: ${response.error.message}`);
      const current = parseGetTaskResult(response.result, taskId);
      this.emitProgress(state, current, progress++);

      switch (current.status) {
        case "working":
          pollIntervalMs = current.pollIntervalMs;
          break;
        case "completed":
          this.complete(state, parseTerminalToolResult(current.result));
          return;
        case "failed":
          throw new TaskFailedError(taskErrorMessage(current));
        case "cancelled":
          throw new TaskCancelledError(`Task ${current.taskId} was cancelled`);
        case "input_required":
          throw new TaskInputRequiredError(`Task ${current.taskId} requires input, which Gustave does not support yet`);
      }
    }
  }

  private async sleepForPoll(state: CallState, requested: number | undefined): Promise<void> {
    const delay = Math.min(
      this.options.maximumPollIntervalMs,
      Math.max(this.options.minimumPollIntervalMs, requested ?? this.options.minimumPollIntervalMs)
    );
    const remaining = state.deadline - this.options.now();
    if (remaining <= 0)
      throw new TaskDeadlineError(`Task ${state.task?.taskId ?? state.originalId} exceeded its deadline`);
    await this.options.sleep(Math.min(delay, remaining), state.signal.signal);
  }

  private async poll(state: CallState, taskId: string): Promise<JsonRpcResponse> {
    const id = this.nextInternalId();
    const response = new Promise<JsonRpcResponse>((resolve) => {
      this.polls.set(id, { state, resolve });
      state.pollIds.add(id);
    });
    const completed = new AbortController();
    const signal = AbortSignal.any([state.signal.signal, completed.signal]);
    try {
      const remaining = state.deadline - this.options.now();
      if (remaining <= 0) throw new TaskDeadlineError(`Task ${taskId} exceeded its deadline`);
      const deadline = this.options.sleep(remaining, signal).then(() => {
        throw new TaskDeadlineError(`Task ${taskId} exceeded its deadline`);
      });
      const sending = this.transport.send(
        { jsonrpc: "2.0", id, method: "tasks/get", params: this.taskParams(state, taskId) },
        { signal }
      );
      await Promise.race([sending, deadline]);
      return await Promise.race([response, deadline]);
    } finally {
      completed.abort();
      this.polls.delete(id);
      state.pollIds.delete(id);
    }
  }

  private throwIfStopped(state: CallState): void {
    if (state.terminal || state.signal.signal.aborted) {
      throw state.signal.signal.reason ?? new TaskCancelledError("Task call stopped");
    }
    if (this.options.now() >= state.deadline) {
      throw new TaskDeadlineError(`Task ${state.task?.taskId ?? state.originalId} exceeded its deadline`);
    }
  }

  private complete(state: CallState, result: unknown): void {
    if (state.terminal) return;
    const id = state.originalId;
    this.cleanup(state);
    this.emitMessage({ jsonrpc: "2.0", id, result });
  }

  private completeWithError(state: CallState, error: unknown): void {
    if (state.terminal) return;
    const id = state.originalId;
    const message = errorMessage(error);
    if (!(error instanceof TaskFailedError) && !(error instanceof TaskCancelledError)) {
      void this.cancelTask(state);
    }
    this.cleanup(state);
    this.emitMessage({ jsonrpc: "2.0", id, result: toolError(message) });
  }

  private abortCall(state: CallState, reason: unknown): void {
    if (state.terminal) return;
    this.rememberIgnoredResponse(state.originalId);
    void this.cancelTask(state);
    state.signal.abort(reason);
    this.cleanup(state);
  }

  private cleanup(state: CallState): void {
    if (state.terminal) return;
    state.terminal = true;
    this.calls.delete(state.originalId);
    if (state.task) this.tasks.delete(state.task.taskId);
    for (const id of state.pollIds) this.polls.delete(id);
    state.pollIds.clear();
    if (state.sourceSignal && state.onSourceAbort) {
      state.sourceSignal.removeEventListener("abort", state.onSourceAbort);
    }
  }

  private async cancelTask(state: CallState): Promise<void> {
    if (state.cancelSent || !state.task || !this.cancellationSupported) return;
    state.cancelSent = true;
    const id = this.nextInternalId();
    try {
      await this.transport.send({
        jsonrpc: "2.0",
        id,
        method: "tasks/cancel",
        params: this.taskParams(state, state.task.taskId),
      });
    } catch {
      // Cancellation is best-effort; the original call is already settled locally.
    }
  }

  private emitProgress(state: CallState, task: CreateTaskResult | GetTaskResult, progress: number): void {
    if (state.progressToken === undefined || state.terminal) return;
    this.emitMessage({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: state.progressToken,
        progress,
        message: task.statusMessage ?? `Task ${task.taskId}: ${task.status}`,
      },
    });
  }

  private taskParams(state: CallState, taskId: string): Record<string, unknown> {
    return withTaskCapabilityMeta({ taskId, ...(state.requestMeta ? { _meta: state.requestMeta } : {}) });
  }

  private rememberIgnoredResponse(id: JsonRpcId): void {
    this.pruneIgnoredResponses();
    if (this.ignoredResponses.size >= 1_024) {
      const oldest = this.ignoredResponses.keys().next().value;
      if (oldest !== undefined) this.ignoredResponses.delete(oldest);
    }
    this.ignoredResponses.set(id, this.options.now() + this.options.overallTimeoutMs);
  }

  private pruneIgnoredResponses(): void {
    const now = this.options.now();
    for (const [id, expiresAt] of this.ignoredResponses) {
      if (expiresAt <= now) this.ignoredResponses.delete(id);
    }
  }

  private nextInternalId(): string {
    let id: string;
    do id = `gustave-task:${++this.internalId}:${Math.random().toString(36).slice(2, 10)}`;
    while (this.calls.has(id) || this.polls.has(id));
    return id;
  }

  private handleClose(): void {
    if (this.closed && this.closeEmitted) return;
    this.closed = true;
    for (const state of [...this.calls.values()]) {
      state.signal.abort(new TaskTransportClosedError("Underlying MCP transport closed"));
      this.cleanup(state);
    }
    this.polls.clear();
    this.tasks.clear();
    this.ignoredResponses.clear();
    this.emitClose();
  }

  private emitMessage(message: JsonRpcMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of this.closeListeners) listener();
  }
}
