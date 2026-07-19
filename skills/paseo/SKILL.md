---
name: paseo
description: Use Paseo to orchestrate external coding agents from Gustave. Use when the user wants multi-agent handoffs, loops, advisors, committees, or remote daemon workflows.
---

# Paseo

Gustave bundles the Paseo CLI. Use it from bash through the absolute Gustave wrapper so local mise/pnpm PATH changes do not hijack the install:

```bash
gustave paseo --help
gustave paseo run "task"
gustave paseo ls
gustave paseo attach <id>
gustave paseo send <id> "follow-up"
```

Guidelines:

1. Use Paseo only when the user explicitly asks for external agent orchestration or parallel coding agents.
2. Confirm before starting long-running or costly agent runs.
3. Summarize daemon/agent IDs in your final response so the user can attach later.
