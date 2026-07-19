---
name: ask-user
description: Decision handshake for ambiguous requirements, high-stakes architecture, secrets, destructive actions, or irreversible changes. Use before proceeding when explicit human input is needed.
---

# Ask User

Use the `ask_user` tool before high-stakes decisions, irreversible changes, or when requirements are ambiguous.

Protocol:
1. Gather enough context first with read-only tools.
2. Ask exactly one focused question.
3. Provide a short context summary.
4. Offer clear options when useful.
5. Proceed only after the user answers.

Do not ask multi-part or unrelated questions in one call.
