Use Gustave subagents for this task:

1. Run `subagent` with agent `scout` to gather relevant codebase context for: {{task}}
2. Run `subagent` with agent `planner`, passing the scout findings, to create an implementation plan.
3. Summarize the plan for me and wait for approval before editing files.
