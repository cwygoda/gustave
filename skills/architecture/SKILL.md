---
name: architecture
description: Architectural guidance for implementation work. Use when designing modules, refactoring boundaries, choosing test strategy, or introducing/altering services, adapters, APIs, CLIs, or domain logic.
---

# Architecture Defaults

Gustave should bring architectural judgment without over-engineering.

## Preferred Architecture

Prefer **hexagonal architecture / ports-and-adapters** and **clean architecture** when they fit the codebase:

- Keep domain/business rules independent of frameworks, databases, HTTP, queues, filesystems, and CLIs.
- Define ports/interfaces at the boundary where domain/application code needs external capabilities.
- Put implementation details in adapters.
- Dependencies should point inward: adapters depend on application/domain, not the reverse.
- Keep use cases/application services explicit and testable.
- Avoid adding layers for trivial scripts or small isolated changes.

## Testing Pyramid

Prefer a nice, fast test pyramid:

1. Many fast unit/domain tests for rules, decisions, parsing, validation, and use cases.
2. Focused integration/contract tests for adapters, persistence, HTTP clients, queues, filesystems, and provider boundaries.
3. A small number of high-value end-to-end tests for critical user flows.

Guidelines:

- Keep tests deterministic and parallel-friendly.
- Prefer fixtures/builders over opaque shared setup.
- Avoid brittle sleeps, live network calls, and broad snapshot churn.
- Add regression tests close to the bug or boundary being fixed.
- Favor fast feedback first; move slower tests behind explicit integration/e2e commands when appropriate.

## Modern CLI Tools

Prefer modern, fast command-line tools when available:

- `rg` over `grep`
- `fd` over `find`
- `jq` / `yq` for JSON/YAML
- `bat` for readable file previews
- `eza` / `tree` for directory inspection
- `delta` for diffs
- `hyperfine` for benchmarks

Before relying on a non-standard tool in scripts or docs, check availability or provide a portable fallback.
