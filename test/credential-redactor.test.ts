import assert from "node:assert/strict";
import { test } from "node:test";

import credentialRedactor, {
  createCredentialRedactingSink,
  credentialExtractionReason,
  redactCredentialContent,
  redactCredentialText,
} from "../extensions/credential-redactor.ts";

function registeredHandlers() {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  credentialRedactor({
    on(name: string, handler: (event: any, ctx?: any) => any) {
      handlers.set(name, handler);
    },
    registerCommand() {},
  } as never);
  return handlers;
}

test("redactCredentialText removes known token shapes and quoted credential fields", () => {
  const input = [
    "github=ghp_12345678901234567890",
    "aws=AKIA1234567890ABCDEF",
    "slack=xoxb-12345678901234567890",
    "openai=sk-proj-12345678901234567890123456789012",
    "Authorization: Bearer header.payload.signature",
    "refresh_token=super-secret-value",
    'token="quoted-secret-value"',
    '"password": "json secret value"',
    "AWS_SECRET_ACCESS_KEY='aws secret value'",
    'Authorization: Bearer "bearer secret value"',
    "AWS_SECRET_ACCESS_KEY    table-secret-value",
  ].join("\n");

  const output = redactCredentialText(input);

  assert.doesNotMatch(
    output,
    /ghp_|AKIA|xoxb-|sk-proj-|header\.payload|super-secret|quoted-secret|json secret|aws secret|bearer secret|table-secret/
  );
  assert.match(output, /REDACTED_GITHUB_TOKEN/);
  assert.match(output, /REDACTED_AWS_ACCESS_KEY_ID/);
  assert.match(output, /REDACTED_SLACK_TOKEN/);
  assert.match(output, /REDACTED_API_KEY/);
  assert.match(output, /token="\[REDACTED\]"/);
  assert.match(output, /"password": "\[REDACTED\]"/);
});

test("redactCredentialText leaves ordinary output unchanged", () => {
  const input = "status=healthy\ncount=42";
  assert.equal(redactCredentialText(input), input);
});

test("credentialExtractionReason blocks explicit exports and standalone environment dumps", () => {
  for (const command of [
    "gh auth token",
    'gh auth "token"',
    "gh --hostname github.example auth token",
    "aws configure export-credentials --profile dev",
    'aws configure "export-credentials"',
    "aws --profile dev configure get aws_secret_access_key",
    'aws configure get "aws_secret_access_key"',
    "a\\ws configure get aws_secret_access_key",
    "aws configure get profile.dev.aws_secret_access_key",
    "security -q find-generic-password -s github -w",
    'security find-generic-password "-w"',
    "printenv",
    "/usr/bin/printenv",
    "command env",
    "export",
    "declare -x",
    "FOO=bar printenv",
    "sudo printenv",
    "env printenv",
    "env -0",
    "Get-ChildItem Env:",
    "Get-ChildItem Env:*",
    "dir Env:",
    "gci Env:\\*",
    "echo ok && env",
  ]) {
    assert.ok(credentialExtractionReason(command), `expected blocked command: ${command}`);
  }
});

test("credentialExtractionReason allows normal authenticated commands and scoped env assignments", () => {
  for (const command of [
    "gh repo view",
    "aws sts get-caller-identity",
    "env FOO=bar node script.mjs",
    "env -u FOO node script.mjs",
    "export FOO=bar",
    "set -e",
  ]) {
    assert.equal(credentialExtractionReason(command), undefined, `expected allowed command: ${command}`);
  }
});

test("redactCredentialContent changes text parts only", () => {
  const image = { type: "image", data: "abc" };
  const content = [{ type: "text", text: "token=secret-value", metadata: "kept" }, image];

  assert.deepEqual(redactCredentialContent(content), [
    { type: "text", text: "token=[REDACTED]", metadata: "kept" },
    image,
  ]);
});

test("createCredentialRedactingSink handles secrets split across chunks", () => {
  const chunks: Buffer[] = [];
  const sink = createCredentialRedactingSink((chunk) => chunks.push(chunk));

  sink.write(Buffer.from('token="split-'));
  sink.write(Buffer.from('secret-value"\nstatus='));
  sink.write(Buffer.from("healthy"));
  sink.end();

  assert.equal(Buffer.concat(chunks).toString(), 'token="[REDACTED]"\nstatus=healthy');
});

test("createCredentialRedactingSink streams bounded non-secret output", () => {
  const chunks: Buffer[] = [];
  const sink = createCredentialRedactingSink((chunk) => chunks.push(chunk));
  const output = "a".repeat(70 * 1024);

  sink.write(Buffer.from(output));
  assert.ok(chunks.length > 0, "expected incremental output before end");
  sink.end();

  assert.equal(Buffer.concat(chunks).toString(), output);
});

test("extension blocks bash and PowerShell exports and redacts their results", async () => {
  const handlers = registeredHandlers();
  const toolCall = handlers.get("tool_call");
  const toolResult = handlers.get("tool_result");
  assert.ok(toolCall);
  assert.ok(toolResult);

  for (const toolName of ["bash", "powershell"]) {
    const blocked = await toolCall({ toolName, input: { command: "gh auth token" } });
    assert.equal(blocked.block, true);

    const result = await toolResult({
      toolName,
      content: [{ type: "text", text: '"token": "tool-secret-value"' }],
    });
    assert.deepEqual(result.content, [{ type: "text", text: '"token": "[REDACTED]"' }]);
  }
});

test("extension blocks interactive exports and redacts streamed user_bash output", async () => {
  const userBash = registeredHandlers().get("user_bash");
  assert.ok(userBash);

  const blocked = userBash({ command: "aws --profile dev configure get aws_secret_access_key" });
  assert.equal(blocked.result.exitCode, 126);

  const allowed = userBash({ command: "printf 'token=streamed-secret-value'" });
  const chunks: Buffer[] = [];
  const result = await allowed.operations.exec("printf 'token=streamed-secret-value'", process.cwd(), {
    onData: (chunk: Buffer) => chunks.push(chunk),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.concat(chunks).toString(), "token=[REDACTED]");
});
