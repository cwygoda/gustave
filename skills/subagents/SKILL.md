---
name: subagents
description: Delegate isolated tasks to specialized Gustave subagents for scouting, planning, reviewing, or other focused work.
---

# Subagents

Use subagents when isolated context or specialized perspective helps.

Tools:
- `subagents_list` — inspect available agents.
- `subagent` — run a single specialized agent in a separate pi process.

Bundled agents:
- `scout` — fast read-only reconnaissance.
- `planner` — concrete implementation planning.
- `reviewer` — code/diff review.

Guidelines:
1. Use `scout` before broad or unfamiliar changes.
2. Use `planner` for multi-step work.
3. Use `reviewer` before final response on risky changes.
4. Treat subagent output as advice; verify critical claims.
5. Project-local agents in `.gustave/agents` require explicit approval.
