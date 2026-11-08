---
name: modern-cli-tools
description: >
  Reference for modern CLI tools available in this environment. Use when performing
  code search (ast-grep, semgrep, ripgrep), file operations (fd, bat, eza), data
  processing (jq, yq), git analysis (difftastic, delta, gitleaks), HTTP testing
  (httpie, hurl), benchmarking (hyperfine, scc, k6), or file watching (watchexec).
  Prefer these tools over legacy equivalents (grep, find, cat, sed, curl, diff).
---

# Modern CLI Tools

Prefer these over legacy equivalents when they are available. Before relying on
one in automation, check it with `command -v` or provide a portable fallback.

## Provisioning

Use mise for reproducible project tools and versions. Keep only tools required to
build, test, or maintain the project in its `.mise.toml`; installing this entire
optional toolbox for every contributor would be slow and unnecessary.

Mise's registry provides aliases for every tool below except HTTPie and scc. Use
their direct backends when needed:

```bash
mise use -g pipx:httpie@latest
mise use -g go:github.com/boyter/scc/v3@latest
```

Homebrew is also reasonable for a workstation-wide, rolling-release toolbox.
Prefer mise when version pinning and cross-machine setup matter.

## Code Search & Analysis

### ast-grep — AST-based structural search and rewrite

Think "grep but understands code syntax." Uses tree-sitter ASTs across 20+ languages.

```bash
# Pattern search
ast-grep run -p 'console.log($ARG)' -l javascript

# Search and rewrite (preview)
ast-grep run -p 'var $V = $VAL' -r 'const $V = $VAL' -l javascript

# Apply all rewrites (after review!)
ast-grep run -p 'var $V = $VAL' -r 'const $V = $VAL' -l javascript -U

# JSON output for programmatic analysis
ast-grep run -p 'console.log($ARG)' -l javascript --json

# Rule-based scan
ast-grep scan --rule rule.yml
ast-grep scan --inline-rules 'id: test
language: javascript
rule:
  kind: function_declaration
  has:
    pattern: await \$EXPR
    stopBy: end'

# Debug AST structure
ast-grep run -p 'your code' -l javascript --debug-query=cst
```

**Metavariables:** `$VAR` (single node), `$$$ARGS` (zero+), `$_VAR` (non-capturing).

**Key rule:** Always use `stopBy: end` in relational rules (`has`, `inside`).

**Do NOT use** `--interactive` flag — requires human input.

See `references/ast-grep-rules.md` for full rule syntax, metavariable reference, and language-specific patterns.

### semgrep — semantic code analysis and SAST

Pattern-based static analysis. Understands data flow, taint tracking, and language semantics.

```bash
# Quick pattern scan (use language-appropriate dangerous patterns)
semgrep -e 'subprocess.call(...)' --lang python .

# Auto-detect rules for project
semgrep --config auto .

# Use specific rulesets
semgrep --config p/security-audit .
semgrep --config p/owasp-top-ten .
semgrep --config p/python .

# JSON output
semgrep --config auto --json .

# Scan specific files
semgrep -e '$X == None' --lang python src/

# Diff-aware (only new findings)
semgrep --config auto --baseline-commit main .
```

**When to use:** Security audits, enforcing coding standards, finding anti-patterns with data-flow awareness. Complements ast-grep — semgrep understands semantics (taint, constants), ast-grep is better for structural rewriting.

### ripgrep (rg) — fast regex code search

```bash
# Basic search
rg 'pattern' .

# File type filter
rg 'TODO' --type python
rg 'function' --type js

# Glob filter
rg 'import' --glob '*.ts'

# Context lines
rg 'error' -C 3

# JSON output
rg 'pattern' --json

# Files only
rg -l 'pattern'

# Count matches
rg -c 'pattern'

# Fixed string (no regex)
rg -F 'exact.match()'

# Multiline
rg -U 'fn.*\{[\s\S]*?unsafe'
```

## Modern Unix Replacements

### bat — cat with syntax highlighting

```bash
# View file with syntax highlighting + line numbers
bat file.rs

# Plain output (no decoration) — useful for piping
bat -pp file.rs

# Specific language
bat --language json data.txt

# Show diff
bat --diff file.rs

# Multiple files
bat src/*.ts
```

### fd — fast find alternative

```bash
# Find by name
fd 'pattern'

# Find by extension
fd -e ts

# Find in specific dir
fd 'test' src/

# Exact match
fd -g 'package.json'

# Include hidden/ignored
fd -H -I 'pattern'

# Execute on results
fd -e py -x black {}

# Type filter (f=file, d=dir, l=symlink)
fd -t f 'config'

# Exclude dirs
fd -E node_modules -E .git 'pattern'
```

### eza — modern ls

```bash
# Long listing with git status
eza -la --git

# Tree view
eza --tree --level 3

# Sort by modified
eza -la --sort modified

# Filter by type
eza -la --only-files
eza -la --only-dirs

# Icons
eza -la --icons
```

### sd — modern sed

```bash
# Simple replacement
sd 'before' 'after' file.txt

# Regex
sd 'fn (\w+)' 'function $1' file.js

# Preview (dry run)
sd -p 'old' 'new' file.txt

# In-place across files
fd -e ts | xargs sd 'oldApi' 'newApi'
```

## Data Processing

### jq — JSON processor

```bash
# Pretty print
jq '.' data.json

# Extract field
jq '.name' data.json

# Array operations
jq '.items[] | .id' data.json
jq '.items | length' data.json

# Filter
jq '.items[] | select(.status == "active")' data.json

# Transform
jq '{name: .title, count: (.items | length)}' data.json

# Slurp multiple objects into array
cat *.json | jq -s '.'

# Raw output (no quotes)
jq -r '.url' data.json

# From string
echo '{"a":1}' | jq '.a'
```

### yq — YAML/TOML/XML processor (jq syntax for YAML)

```bash
# Read YAML
yq '.services' docker-compose.yml

# Edit in place
yq -i '.version = "3.9"' docker-compose.yml

# Convert YAML to JSON
yq -o json '.' config.yml

# Convert JSON to YAML
yq -P '.' data.json

# Merge files
yq eval-all 'select(fileIndex == 0) * select(fileIndex == 1)' base.yml override.yml

# TOML support
yq -p toml '.database' config.toml
```

## Git Enhancement

### GitHub CLI (gh) — repositories, pull requests, issues, and workflows

```bash
# Inspect pull requests and checks
gh pr list
gh pr view 123 --comments
gh pr checks 123

# Create a pull request from the current branch
gh pr create --fill

# Inspect workflow runs
gh run list --limit 10
gh run view <run-id> --log-failed

# Query fields not exposed by a dedicated command
gh api repos/{owner}/{repo}/releases/latest --jq '.tag_name'
```

Prefer structured output (`--json` plus `--jq`) in automation. Commands that
create, merge, close, or delete remote resources require explicit user approval.

### difftastic (difft) — structural diff

Compares by AST nodes, not text lines. Ignores whitespace/formatting changes.

```bash
# Diff two files
difft old.js new.js

# Use as git difftool
GIT_EXTERNAL_DIFF=difft git diff
GIT_EXTERNAL_DIFF=difft git show HEAD

# With git log
GIT_EXTERNAL_DIFF=difft git log -p --ext-diff
```

### delta — syntax-highlighted git diffs

Configured as git pager. Features: line numbers, side-by-side, word-level highlighting.

```bash
# Direct use
delta file_a file_b

# Typically auto-used via git config:
# [core] pager = delta
# [delta] navigate = true, side-by-side = true
```

### gitleaks — secret detection

```bash
# Scan repository history
gitleaks git .

# Scan files without Git history
gitleaks dir ./src

# JSON report
gitleaks git . --report-format json --report-path report.json

# Scan selected history
gitleaks git . --log-opts="--all"

# Pre-commit check (staged only)
gitleaks git . --staged
```

## HTTP Testing

### httpie (http/https) — intuitive HTTP client

```bash
# GET
http httpbin.org/get

# POST JSON (default)
http POST api.example.com/users name=John email=john@test.com

# Headers
http GET api.example.com Authorization:"Bearer token123"

# Form data
http -f POST api.example.com/login user=admin pass=secret

# Download
http --download example.com/file.zip

# Quiet (headers only)
http --headers GET api.example.com
```

### hurl — HTTP request testing (file-based)

```bash
# Run test file
hurl api-tests.hurl

# With assertions
hurl --test api-tests.hurl

# Variable injection
hurl --variable host=localhost:3000 api-tests.hurl

# Verbose
hurl --very-verbose api-tests.hurl
```

Example `.hurl` file:

```hurl
GET http://localhost:3000/api/health
HTTP 200
[Asserts]
jsonpath "$.status" == "ok"

POST http://localhost:3000/api/users
Content-Type: application/json
{"name": "test"}
HTTP 201
[Asserts]
jsonpath "$.id" isInteger
```

## Analysis & Benchmarking

### hyperfine — command benchmarking

```bash
# Benchmark a command
hyperfine 'fd -e py'

# Compare two commands
hyperfine 'find . -name "*.py"' 'fd -e py'

# Warmup runs
hyperfine --warmup 3 'command'

# Export results
hyperfine --export-markdown bench.md 'command_a' 'command_b'
hyperfine --export-json bench.json 'command'

# Min runs
hyperfine --min-runs 20 'command'
```

### scc — code statistics

```bash
# Project overview
scc

# Specific directory
scc src/

# By file
scc --by-file src/

# JSON output
scc --format json

# Exclude dirs
scc --exclude-dir vendor,node_modules
```

### tokei — code statistics (alternative to scc)

```bash
# Project overview
tokei

# Specific dir
tokei src/

# Sort by lines
tokei --sort lines

# Specific languages
tokei --type Rust,Python
```

### k6 — load testing

```bash
# Run load test
k6 run loadtest.js

# With VUs and duration
k6 run --vus 10 --duration 30s loadtest.js

# Quick test URL
k6 run --vus 5 --duration 10s -e URL=http://localhost:3000 loadtest.js
```

### shellcheck — shell script linter

```bash
# Lint a script
shellcheck script.sh

# Specific shell dialect
shellcheck --shell=bash script.sh

# Exclude rules
shellcheck --exclude=SC2086 script.sh

# JSON/GCC output
shellcheck --format=json script.sh
shellcheck --format=gcc script.sh
```

## Automation

### watchexec — run on file changes

```bash
# Run tests on change
watchexec -e rs 'cargo test'

# Watch specific dir
watchexec -w src/ 'npm run build'

# Multiple extensions
watchexec -e ts,tsx 'npm run typecheck'

# Restart long-running process
watchexec --restart -e py 'python server.py'

# Debounce
watchexec --debounce 500 -e js 'npm test'
```

## When to Use What

| Task | Tool | Instead of |
| ---- | ---- | ---------- |
| Find code patterns structurally | `ast-grep` | complex regex |
| Security/semantic analysis | `semgrep` | manual review |
| Work with GitHub | `gh` | manual web/API calls |
| Text search in code | `rg` | `grep` |
| Find files | `fd` | `find` |
| View files | `bat` | `cat` |
| List files | `eza` | `ls` |
| Text replacement | `sd` | `sed` |
| Process JSON | `jq` | `python -c` |
| Process YAML/TOML | `yq` | custom scripts |
| Diff with syntax awareness | `difft` | `diff` |
| Better git diffs | `delta` | default pager |
| Detect secrets | `gitleaks` | manual grep |
| HTTP requests | `http` (httpie) | `curl` |
| HTTP test suites | `hurl` | shell scripts |
| Benchmark commands | `hyperfine` | `time` |
| Code statistics | `scc` / `tokei` | `wc -l` |
| Lint shell scripts | `shellcheck` | hope |
| Watch & rerun | `watchexec` | `watch` / polling |
| Load testing | `k6` | `ab` / `wrk` |
