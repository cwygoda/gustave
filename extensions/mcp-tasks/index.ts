import { createMcpExtension, type McpTransportFactory } from "@earendil-works/pi-coding-agent";

import { createTaskCapableTransport } from "./default-transport.ts";
import { defaultSleep, type Sleep } from "./task-transport.ts";

export interface TaskMcpOptions {
  overallTimeoutMs?: number;
  minimumPollIntervalMs?: number;
  maximumPollIntervalMs?: number;
  sleep?: Sleep;
  now?: () => number;
}

export function createTaskMcpExtension(options: TaskMcpOptions = {}) {
  const createTransport = createTaskCapableTransport(options) as McpTransportFactory;
  return createMcpExtension({ createTransport });
}

export { createTaskCapableTransport, defaultSleep };
export { TaskAwareTransport } from "./task-transport.ts";
export * from "./task-protocol.ts";

export default createTaskMcpExtension();
