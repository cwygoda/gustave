# MCP Tasks Extension Plan

## Goal

Add reusable MCP Tasks support to the Gustave harness while retaining Pi's public MCP integration for configuration, `/mcp`, OAuth credentials, tool exposure, resources, and lazy reconnection.

The first implementation targets the task protocol currently used by `dwh-mcp`: MCP `2026-07-28`, the `io.modelcontextprotocol/tasks` extension, task-producing `tools/call`, and polling through `tasks/get` until the terminal response embeds a normal `CallToolResult`.

## Architectural decision

Build a replacement MCP extension with Pi's public API:

```ts
createMcpExtension({ createTransport })
```

The custom transport factory will create standard public `@earendil-works/pi-mcp` transports and decorate them with task-aware protocol translation.

This design:

- keeps Pi's `/mcp` interface;
- keeps Pi's `mcp.json` loading;
- keeps Pi's `mcp-auth.json` OAuth credentials and refresh behavior;
- keeps tool discovery, exposure modes, resources, permission hooks, and lazy reconnect;
- avoids private Pi imports;
- avoids a second, independently registered set of MCP tools;
- removes the need for server-specific commands such as `/dwh-login` and `/dwh-reconnect`.

Registering `/mcp` through `createMcpExtension()` should cause Pi's replaceable built-in MCP extension to stand down. Do not add `--no-mcp` unless a regression test proves it is necessary.

## Scope

### Version 1 includes

- Streamable HTTP and stdio MCP transports.
- Negotiation of MCP `2026-07-28` with fallback for older servers.
- Advertisement of `io.modelcontextprotocol/tasks`.
- Immediate non-task `tools/call` responses.
- Task creation responses from `tools/call`.
- Polling with `tasks/get`.
- Embedded terminal `CallToolResult` handling.
- Failed, cancelled, and unsupported `input_required` outcomes.
- Concurrent task calls.
- Abort, timeout, shutdown, and best-effort `tasks/cancel` handling.
- Progress notifications that renew Pi's inactivity timeout.
- A separate configurable overall task deadline.
- Existing Pi exposure modes: `direct`, `codemode`, `deferred`, and `hidden`.

### Version 1 excludes

- A task-management TUI.
- Generic task listing or task resumption after restarting Gustave.
- Interactive handling of `input_required`.
- Changes to Pi's standalone `gustave mcp ...` command implementation.
- Private imports from `@earendil-works/pi-coding-agent/dist` or `src`.
- Runtime dependence on the official MCP SDK.

## Proposed layout

```text
extensions/mcp-tasks/
├── index.ts                 # Gustave/Pi extension entry point
├── default-transport.ts     # Public HTTP and stdio transport construction
├── task-transport.ts        # McpTransport decorator and correlation state
└── task-protocol.ts         # Narrow task types, guards, and status helpers

test/
├── mcp-task-protocol.test.ts
├── mcp-task-transport.test.ts
└── mcp-default-transport.test.ts
```

The multi-file extension belongs in a subdirectory with one `index.ts`. Pi will load it as one extension rather than treating helper files as independent extensions.

## Implementation plan

### Phase 1: lock the protocol contract

1. Capture fixtures from the current `dwh-mcp` implementation for:
   - task-capable initialization;
   - immediate `tools/call` completion;
   - task creation;
   - working task status;
   - completed task with embedded `CallToolResult`;
   - failed, cancelled, and `input_required` states;
   - cancellation.
2. Keep unknown task fields intact for forward compatibility.
3. Confirm whether the server advertises cancellation separately before claiming cancellation support.
4. Record draft protocol constants in one module so future protocol changes remain isolated.

### Phase 2: add protocol primitives

Implement narrow structural validators for:

- task creation results;
- task IDs;
- task statuses;
- timestamps and TTL;
- polling intervals;
- terminal embedded tool results;
- task errors.

Add explicit errors for malformed responses, missing terminal results, failed tasks, cancelled tasks, unsupported input, deadline expiry, and transport closure.

### Phase 3: build the transport decorator

Implement `TaskAwareTransport` over the public `McpTransport` interface.

Delegate unchanged:

- `start()`;
- `close()`;
- listener registration;
- ordinary requests, responses, and notifications;
- transport errors and close events.

#### Initialization translation

1. Intercept the outgoing `initialize` request.
2. Replace its requested protocol version with `2026-07-28`.
3. Merge `io.modelcontextprotocol/tasks` into client capabilities without dropping existing or unknown capabilities.
4. Record the actual protocol selected by the server.
5. If the server selects `2026-07-28`, rewrite the response seen by Pi to `2025-11-25`, which Pi 1.2 accepts.
6. When Pi calls `setProtocolVersion("2025-11-25")`, set the underlying HTTP transport to the real negotiated version.
7. If an older server selects an older supported protocol, pass it through and disable task interception for that connection.

#### Tool-call translation

For each outgoing `tools/call` request:

1. Record its request ID, `_meta`, progress token, signal, and deadline.
2. Forward the request unchanged apart from required task metadata.
3. Pass an immediate normal `CallToolResult` straight through.
4. If the response is a task envelope, withhold it from Pi.
5. Poll `tasks/get` with collision-resistant internal request IDs.
6. Carry forward the original extension metadata required by the server.
7. Honor the server poll interval with configured minimum and maximum bounds.
8. Emit progress notifications associated with the original progress token.
9. On completion, emit the embedded `CallToolResult` under the original request ID.
10. On failure, cancellation, or unsupported input, emit a normal MCP tool error result under the original request ID.

#### Correlation and concurrency

Maintain separate maps for:

- original Pi request IDs;
- internal poll request IDs;
- server task IDs.

Use namespaced string IDs for internal requests. Terminal flags and `finally` cleanup must prevent duplicate completion, late delivery, ID reuse, and cross-talk between concurrent tasks.

#### Abort and shutdown

On original signal abort, MCP cancellation notification, deadline expiry, or transport close:

1. stop sleeping and polling;
2. remove all correlation state;
3. send at most one best-effort `tasks/cancel` when supported;
4. never emit a late result after the original request has settled.

### Phase 4: recreate default transport construction

Add `@earendil-works/pi-mcp` as a direct Gustave dependency. Do not rely on its transitive installation through Pi.

Using public exports, construct:

- `StreamableHttpTransport` with the exact `authProvider` supplied by Pi;
- `StdioTransport` with command, arguments, cwd, environment, inherited environment, stderr capture, and home-directory expansion.

Preserve documented configuration behavior for:

- literal header and environment values;
- `${NAME}` environment interpolation;
- whole-value `!command` resolution;
- relative cwd values;
- leading `~/` paths.

Add parity tests before making this factory the default for every Gustave MCP server.

### Phase 5: create the Gustave extension

Export a reusable factory and default extension from `extensions/mcp-tasks/index.ts`:

```ts
export interface TaskMcpOptions {
  overallTimeoutMs?: number;
  minimumPollIntervalMs?: number;
  maximumPollIntervalMs?: number;
  sleep?: typeof defaultSleep;
  now?: () => number;
}

export function createTaskMcpExtension(options?: TaskMcpOptions) {
  return createMcpExtension({
    createTransport: createTaskCapableTransport(options),
  });
}

export default createTaskMcpExtension();
```

Inject clocks and sleep functions so polling tests remain deterministic and fast.

### Phase 6: wire Gustave startup

1. Add `extensions/mcp-tasks/index.ts` to the explicit bundled extension list in `bin/gustave.mjs`.
2. Keep `gustave mcp add/list/login/logout/remove` on Pi's standalone implementation.
3. Verify both paths use the same agent directory, `mcp.json`, and `mcp-auth.json`.
4. Verify exactly one `/mcp` command and one set of MCP tools are registered in session mode.
5. Remove project-local task clients only after the Gustave extension passes live integration testing.

## Test strategy

### Unit tests

Cover:

- protocol version translation;
- capability merging without field loss;
- old-server protocol fallback;
- immediate tool results;
- task creation and polling;
- completed, failed, cancelled, malformed, and `input_required` tasks;
- poll interval bounds;
- overall deadline;
- abort before task creation, during sleep, and during polling;
- concurrent calls with out-of-order responses;
- duplicate and late responses;
- exactly-once cancellation;
- listener disposal and map cleanup.

### Contract tests

Use `@earendil-works/pi-mcp/testing` and an in-memory fake server to drive a real `McpClient.callTool()` through the decorator.

Verify:

- Pi's client receives an ordinary final `CallToolResult`;
- progress renews Pi's request timeout;
- structured content and `isError` survive translation;
- ordinary tools and resources remain unchanged;
- the supplied OAuth provider reaches the HTTP transport unchanged;
- transport closure remains owned by Pi's lazy reconnect logic.

### Harness regression tests

Verify:

- Gustave loads one MCP implementation;
- Svelte HTTP still connects;
- Svelte local and agent-browser stdio servers still connect;
- `direct`, `codemode`, `deferred`, and `hidden` exposure still works;
- `/mcp` login/logout/reconnect still works;
- `gustave mcp list --json` still works outside a session;
- no implementation imports private Pi paths;
- the default suite is deterministic and offline.

### Live smoke test

Run one manually gated test against `dwh-mcp`:

1. configure `dwh-mcp` in Gustave's normal `mcp.json`;
2. authenticate with `/mcp login dwh-mcp` or `gustave mcp login dwh-mcp`;
3. call `health`;
4. call task-backed `query`;
5. restart the local DWH stack;
6. call `health` again and verify lazy reconnection;
7. start a query, cancel it, and verify polling stops.

Never store credentials or auth files in fixtures.

## Acceptance criteria

1. A task-backed DWH query resolves to its final Parquet artifact through a normal Pi MCP tool call.
2. `/dwh-login` and `/dwh-reconnect` are unnecessary.
3. Pi's standard `/mcp` authentication is used by task-capable calls.
4. Non-task MCP servers behave as before.
5. Concurrent task calls cannot exchange responses or state.
6. Cancellation and shutdown leave no polling loops or late results.
7. Pi's request timeout remains an inactivity timeout while the extension enforces an overall task deadline.
8. MCP resources and every exposure mode pass regression tests.
9. Production code imports only declared package exports.
10. `pnpm check` and the offline self-test pass.
11. Existing unrelated working-tree changes are preserved.

## Validation commands

```bash
cd "/Users/cwygoda/Hobbyforge/Public Projects/gustave"

pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm check

git diff --check
rg -n '@earendil-works/pi-coding-agent/(dist|src)|extensions/mcp/runtime|createDefaultTransport' \
  extensions test
```

The private-import search should return no production imports.

## Delivery slices

1. Protocol fixtures and validators.
2. Task transport with deterministic unit tests.
3. Public default transport factory and parity tests.
4. Gustave extension entry and startup wiring.
5. Harness regression tests and documentation.
6. Live `dwh-mcp` validation.
7. Removal of the project-local DWH task client in a separate change.

Prefer one Conventional Commit per slice.

## Estimate

- Protocol and transport core: 4–6 hours.
- Default transport parity and harness wiring: 2–3 hours.
- Unit and integration tests: 3–5 hours.
- Live validation and cleanup: 1–2 hours.

Expected total: approximately 1.5–2 working days.

## Risks and mitigations

### Draft protocol changes

Keep all protocol constants and wire guards in `task-protocol.ts`. Preserve unknown fields and base tests on captured target-server fixtures.

### Incorrect capability advertisement

Advertise only the task behavior the decorator implements. Disable task interception when the server negotiates an older protocol.

### Timeout mismatch

Emit progress while polling and enforce a separate overall deadline.

### Cancellation races

Use per-call abort state, terminal flags, collision-resistant internal IDs, and unconditional cleanup.

### OAuth regression

Pass Pi's supplied `authProvider` through by identity and test it at the HTTP boundary. Never read or duplicate Pi's credential files directly.

### Default transport drift

Keep transport construction isolated and parity-tested. If Pi later publicly exports its default transport factory or native task support, replace the local implementation.

### Existing dirty working tree

At planning time, Gustave already has unrelated modifications in:

- `README.md`;
- `bin/gustave.mjs`;
- `bin/self-test.mjs`;
- `bin/self-update.mjs`;
- `package.json`;
- `pnpm-lock.yaml`.

Use scoped edits. Do not reset, stash, overwrite, or broadly reformat those files.

## Rollback

Remove the explicit `extensions/mcp-tasks/index.ts` entry from Gustave's bundled extensions. Pi's built-in MCP extension will resume ownership automatically. Remove the direct `@earendil-works/pi-mcp` dependency and task extension files in a separate revert.
