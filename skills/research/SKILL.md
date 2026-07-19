---
name: research
description: Evidence-backed web and documentation research. Use when facts may be outdated, external APIs/libraries are involved, or implementation details require sources.
---

# Research

Use the `web_search` and `fetch_url` tools for current external information.

Workflow:
1. Search with 2-4 varied queries when broad coverage matters.
2. Fetch primary sources: official docs, changelogs, GitHub repositories, issue discussions.
3. Prefer authoritative sources over blog summaries.
4. Cite URLs in your answer.
5. Separate confirmed facts from assumptions.

Configuration:
- Set `BRAVE_API_KEY` for full web search.
- Without it, `web_search` uses a limited DuckDuckGo Instant Answer fallback.
