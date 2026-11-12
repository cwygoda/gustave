import assert from "node:assert/strict";
import { test } from "node:test";

import commitPolicy, {
  commitPolicyViolation,
  splitCommands,
} from "../extensions/commit-policy.ts";

function registeredHandlers() {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  commitPolicy({
    on(name: string, handler: (event: any, ctx?: any) => any) {
      handlers.set(name, handler);
    },
  } as never);
  return handlers;
}

test("splitCommands keeps quoted content whole and separates on operators", () => {
  assert.deepEqual(splitCommands('git commit -m "feat: x"'), [["git", "commit", "-m", "feat: x"]]);
  assert.deepEqual(splitCommands('git add -A && git commit -m "fix: y"'), [
    ["git", "add", "-A"],
    ["git", "commit", "-m", "fix: y"],
  ]);
  // a commit mentioned inside a quoted string is one word, never its own command
  assert.deepEqual(splitCommands('echo "git commit -m bad"'), [["echo", "git commit -m bad"]]);
});

test("allows well-formed Conventional Commits", () => {
  assert.equal(commitPolicyViolation('git commit -m "feat(cli): add thing"'), undefined);
  assert.equal(commitPolicyViolation('git commit -am "fix: bug"'), undefined);
  assert.equal(commitPolicyViolation('git commit --message="chore: tidy"'), undefined);
  assert.equal(commitPolicyViolation('git commit -m"docs: note"'), undefined);
  assert.equal(commitPolicyViolation("git add -A && git commit -m 'refactor: split'"), undefined);
});

test("ignores non-commit commands and unparseable message sources", () => {
  assert.equal(commitPolicyViolation("git push origin main"), undefined);
  assert.equal(commitPolicyViolation("rm -rf build"), undefined);
  // no inline -m (editor/-F/amend): not validated here
  assert.equal(commitPolicyViolation("git commit --amend --no-edit"), undefined);
  assert.equal(commitPolicyViolation("git commit"), undefined);
});

test("blocks non-conventional subjects", () => {
  const reason = commitPolicyViolation('git commit -m "update stuff"');
  assert.match(String(reason), /Conventional Commit/);
});

test("blocks agent/AI attribution lines across -m paragraphs", () => {
  const reason = commitPolicyViolation(
    'git commit -m "feat: x" -m "Generated with Claude Code"'
  );
  assert.match(String(reason), /attribution/);
});

test("does not block a commit hidden inside an unrelated quoted argument", () => {
  assert.equal(commitPolicyViolation('echo "git commit -m nope" && git push'), undefined);
});

test("only guards the bash tool via tool_call", async () => {
  const toolCall = registeredHandlers().get("tool_call");
  assert.ok(toolCall);

  assert.equal(await toolCall({ toolName: "write", input: { command: "git commit -m bad" } }), undefined);

  const blocked = await toolCall({ toolName: "bash", input: { command: 'git commit -m "bad subject"' } });
  assert.equal(blocked.block, true);
  assert.ok(typeof blocked.reason === "string" && blocked.reason.length > 0);
});
