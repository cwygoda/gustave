# Gustave

Gustave is a custom coding-agent distribution based on [pi](https://pi.dev). It wraps pi with a branded CLI, bundled skills/tools, MCP access, browser automation, subagents, memory, and the [`pi-powerline-footer`](https://pi.dev/packages/pi-powerline-footer) TUI.

## Copy/paste install

One-liner install/update:

```bash
curl -fsSL https://raw.githubusercontent.com/cwygoda/gustave/main/install.sh | sh
```

Private GitHub / non-default SSH key:

```bash
curl -fsSL https://raw.githubusercontent.com/cwygoda/gustave/main/install.sh | \
  GIT_SSH_COMMAND='ssh -i ~/.ssh/id_ed25519_cwygoda -o IdentitiesOnly=yes -o BatchMode=yes' sh
```

The script clones/updates `git@github.com:cwygoda/gustave.git` into `~/.local/src/gustave`, runs `pnpm install --ignore-scripts`, installs the absolute launcher into `~/.local/bin/gustave`, and runs `gustave self-test`. Before cloning/updating GitHub SSH repos, it probes your current `GIT_SSH_COMMAND`, default SSH setup, `~/.ssh/config` `IdentityFile` entries, and `~/.ssh/id_*` keys with a dry-run push to find a key with repository write access.

Script knobs:

```bash
GUSTAVE_REPO=git@github.com:cwygoda/gustave.git \
GUSTAVE_REF=main \
GUSTAVE_INSTALL_DIR=~/.local/src/gustave \
GUSTAVE_BIN_DIR=~/.local/bin \
GUSTAVE_ONLINE_TEST=1 \
  sh install.sh
```

Set `GUSTAVE_SKIP_SSH_DETECT=1` to skip SSH key probing.

Fresh machine manual install with private GitHub checkout:

```bash
GIT_SSH_COMMAND='ssh -i ~/.ssh/id_ed25519_cwygoda -o IdentitiesOnly=yes -o BatchMode=yes' \
  git clone git@github.com:cwygoda/gustave.git ~/.local/src/gustave && \
  cd ~/.local/src/gustave && \
  pnpm install --ignore-scripts && \
  node ./bin/gustave.mjs install-bin && \
  ~/.local/bin/gustave github-ssh --owner cwygoda && \
  ~/.local/bin/gustave self-test
```

From an existing Gustave repo checkout:

```bash
pnpm install --ignore-scripts && pnpm gustave install-bin && gustave self-test
```

If `pnpm gustave` is not available in your shell, use:

```bash
pnpm install --ignore-scripts && node ./bin/gustave.mjs install-bin && ~/.local/bin/gustave self-test
```

This installs `~/.local/bin/gustave` as a tiny launcher with **absolute paths** to the Node executable and this checkout's `bin/gustave.mjs`. That avoids the mise/pnpm failure mode where a repo-local `pnpm` or `node_modules/.bin` shadows or breaks a global pi installation.

Add this to your shell if needed:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Custom user bin dir:

```bash
node ./bin/gustave.mjs install-bin --dir "$HOME/bin"
```

## Architecture and engineering defaults

Gustave's base prompt and `architecture` skill bias it toward:

- hexagonal architecture / ports-and-adapters and clean architecture boundaries where appropriate
- domain/application logic independent of frameworks, IO, storage, HTTP, queues, and CLIs
- a fast test pyramid: many unit/domain tests, focused integration/contract tests, few high-value e2e tests
- modern fast CLI tools when available (`rg`, `fd`, `jq`, `yq`, `bat`, `eza`, `delta`, `hyperfine`) with portable fallbacks when needed

## Commit policy

When Gustave creates commits, it enforces:

- **Conventional Commits only**: `type(scope): summary`
- no agent/AI attribution lines such as `Generated with Claude Code`
- no `Co-Authored-By` / `Signed-off-by` lines naming Claude, Codex, ChatGPT, OpenAI, Anthropic, Gustave, or pi

This is enforced two ways:

1. Gustave appends the rule to pi's system prompt.
2. Gustave injects an environment-only Git `commit-msg` hook for processes it starts.

Disable only if necessary:

```bash
GUSTAVE_DISABLE_GIT_COMMIT_POLICY=1 gustave ...
```

## Development tooling with mise

Gustave uses mise to pin local development tools:

```bash
mise install
mise run check
```

Pinned tools in `.mise.toml`:

- Node.js
- pnpm
- ShellCheck
- shfmt

Lint/format commands:

```bash
mise run lint
mise run format
pnpm lint
pnpm format
```

Install repository Git hooks:

```bash
mise run install-hooks
# or
pnpm hooks:install
```

Hooks:

- `pre-commit` runs lint + typecheck through mise when available.
- `commit-msg` enforces Conventional Commits and blocks agent attribution lines.

Bypass pre-commit lint only when necessary:

```bash
GUSTAVE_SKIP_LINT_HOOK=1 git commit ...
```

## Updating with self-tests

```bash
gustave self-update
```

`self-update` does:

1. detects the right GitHub SSH key for `github.com/cwygoda` when this checkout's git remote points there,
2. `git pull --ff-only`,
3. dependency install,
4. local self-tests,
5. reinstalls the absolute user-bin launcher.

Include the live Svelte MCP smoke test:

```bash
gustave self-update --online
```

Run tests without updating:

```bash
gustave self-test
gustave self-test --online
```

## GitHub SSH detection for `github.com/cwygoda`

On machines where your default SSH key is **not** connected to your private GitHub account, run:

```bash
gustave github-ssh --owner cwygoda
```

Gustave probes `~/.ssh/config` and private keys under `~/.ssh`, asks GitHub which account each key authenticates as, and persists the matching command to `~/.gustave/config.json`:

```json
{
  "env": {
    "GIT_SSH_COMMAND": "ssh -i ~/.ssh/your-cwygoda-key -o IdentitiesOnly=yes -o BatchMode=yes",
    "GUSTAVE_GITHUB_OWNER": "cwygoda"
  }
}
```

You can force it manually:

```bash
GUSTAVE_GITHUB_SSH_COMMAND='ssh -i ~/.ssh/id_ed25519_cwygoda -o IdentitiesOnly=yes' gustave github-ssh --owner cwygoda
```

That persisted `GIT_SSH_COMMAND` is injected into Gustave/pi/subagents, so Git operations against `github.com/cwygoda/...` use the correct identity.

## CLI

```bash
gustave [pi options] [@files...] [messages...]
gustave update [pi update options]      # pi update passthrough
gustave self-update [--online]          # Gustave update + tests
gustave self-test [--online]
gustave install-bin [--dir ~/.local/bin]
gustave github-ssh [--owner cwygoda]
gustave mcporter [...args]
gustave svelte-mcp [list|tool ...args]
gustave paseo [...args]
gustave agent-browser [...args]
gustave pi-help
```

Examples:

```bash
gustave -p "Summarize this repository"
gustave --model sonnet:high "Refactor the auth module"
gustave update --all
gustave mcporter list svelte --brief
gustave svelte-mcp list-sections
gustave agent-browser snapshot
gustave paseo ls
```

## Configuration

Gustave merges config files in this order:

1. `~/.config/gustave/config.json`
2. `~/.gustave/config.json`
3. `./.gustave/config.json`

Set `GUSTAVE_CONFIG=/path/to/config.json` to load an explicit config first.

Example for Bedrock:

```json
{
  "env": {
    "AWS_PROFILE": "work-bedrock",
    "AWS_REGION": "us-east-1"
  },
  "envFiles": ["~/.gustave/env"],
  "piArgs": ["--provider", "bedrock"],
  "theme": "gustave"
}
```

`envFiles` support simple `KEY=value` lines.

## Bundled capabilities

| Area | Tools/commands | Purpose |
|---|---|---|
| TUI | `pi-powerline-footer`, `/powerline`, `/bash-mode`, `/vibe` | fixed-editor powerline, git/context/token/cost segments, stash/history, bash mode, working vibes |
| Output style | `i-have-adhd` skill | action-first, numbered, low-tangent responses for ADHD-friendly execution |
| Architecture | `architecture` skill | hexagonal/clean architecture judgment, fast test pyramid, modern CLI tool defaults |
| Ask user | `ask_user` | structured human decision handshakes |
| Research | `web_search`, `fetch_url` | web/docs research (`BRAVE_API_KEY` optional) |
| Memory | `memory_save`, `memory_search`, `memory_delete` | durable memory in `~/.gustave/memory` |
| Plans | `plan_annotate`, `plan_read` | markdown plan tracking |
| Subagents | `subagents_list`, `subagent` | isolated specialized pi subprocesses |
| Credential firewall | `/credential-firewall` | keeps `gh`/`aws` usable while blocking known credential extraction and redacting accidental token leaks from tool output |
| MCP | `mcp_list`, `mcp_call`, `svelte_mcp`, `gustave mcporter` | MCP access through MCPorter |
| Svelte | `gustave svelte-mcp ...`, `svelte_mcp` | official Svelte MCP via `https://mcp.svelte.dev/mcp` |
| Browser | `gustave agent-browser ...`, MCP server `agent-browser` | token-efficient browser automation |
| Paseo | `gustave paseo ...` | external multi-agent orchestration |

## Credential firewall

Gustave includes a credential firewall extension that lets authenticated CLIs keep working while reducing accidental credential exposure to the model/session.

It blocks known credential-extraction actions such as:

```bash
gh auth token
aws configure export-credentials
aws configure get aws_secret_access_key
cat ~/.aws/credentials
cat ~/.config/gh/hosts.yml
```

It also redacts common token shapes from `bash` and `read` tool output before they enter the session. Normal commands such as `gh repo view`, `gh pr list`, `aws s3 ls`, and `aws sts get-caller-identity` remain available.

Check status inside Gustave:

```text
/credential-firewall
```

## MCPorter and Svelte MCP

Gustave writes `~/.gustave/mcporter.json` with:

- `svelte` — official Svelte MCP over HTTP
- `svelte-local` — bundled `@sveltejs/mcp` stdio server
- `agent-browser` — local `agent-browser mcp` stdio server
- imports from Cursor, Claude, Codex, Windsurf, OpenCode, and VS Code MCP configs

Examples:

```bash
gustave mcporter list
gustave mcporter list svelte --brief
gustave svelte-mcp list-sections
gustave svelte-mcp get-documentation section=docs/svelte/overview
```

Inside Gustave, the agent can use `mcp_list`, `mcp_call`, and `svelte_mcp`.

## agent-browser

Install Chrome for Testing once if needed:

```bash
gustave agent-browser install
```

Then:

```bash
gustave agent-browser open https://example.com
gustave agent-browser snapshot
gustave agent-browser click @e2
gustave agent-browser screenshot page.png
gustave agent-browser close
```

Or use it through MCP:

```bash
gustave mcporter list agent-browser --brief
```

## Paseo

Gustave bundles `@getpaseo/cli`:

```bash
gustave paseo --help
gustave paseo run "implement user authentication"
gustave paseo ls
gustave paseo attach <id>
gustave paseo send <id> "also add tests"
```

## Pi package

This repository is also a pi package. Pi discovers resources from:

- `extensions/`
- `skills/`
- `prompts/`
- `themes/`

The wrapper writes initial Gustave settings into `~/.gustave/agent/settings.json` and keeps paths absolute. Gustave also bundles `pi-powerline-footer` as a dependency and loads it from `node_modules/pi-powerline-footer/index.ts`; the local `gustave-ui` extension only publishes a small `gustave` status item for that powerline.
