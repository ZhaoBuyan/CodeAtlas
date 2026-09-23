---
name: codeatlas
description: Use when orienting in an unfamiliar repository, mapping module boundaries, finding what references a type or function, judging the blast radius before a change, or deciding which subsystem a piece of code belongs to — whenever the CodeAtlas code-graph MCP tools are part of this session.
---

# CodeAtlas — reading a codebase through its MCP tools

This session has an MCP server that serves a pre-scanned **code graph** of a repository:
files, types, members and reference edges. Tool names may show a client-added prefix
(some clients render `mcp__<serverName>__overview`); the server name is user-chosen, so
talk about them by their unprefixed short names.

## Open in this order

1. **`list()` first** — real file / type / line counts per directory, the cheapest way to
   get the lay of the land. `overview` is worth one call for scale, credibility and
   skipped-tree facts — but do not use its "most depended-on" list as your orientation:
   it ranks by reference count, so in JS/TS repos it is dominated by short generic names
   (`t`, `c`, …) that say nothing about architecture.
2. **`impact('<orchestration function>', depth=2)`** — if you can name one top-level entry
   function, this single call draws the main execution trunk (entry points → core →
   watchers). It is usually the highest-value call available.
3. **`symbol(...)` / `file(...)`** — fill in details one at a time, now that you know names.

## Traps that are not in the tool schemas

- **Numeric ids are the escape hatch from name ambiguity.** Hot lists and `map` lines start
  with the numeric id; feed that number straight into `symbol` / `refs` / `impact` when a
  short or common name would be ambiguous by name.
- **`map(budget)` is a fixed-size skeleton**, not a budget-scaled export: past a certain
  size the content is exhausted, so raising `budget` changes nothing — its footer states
  whether everything was emitted or it was cut off at the cap. If it warns that the project
  has no grouping config (**facets**) and the systems layer is empty, treat the output as a
  plain most-referenced list rather than the architecture, and consider the `draft-facets`
  command it suggests.
- **`exclude` is the caller's job.** Fixtures / vendor / generated trees pollute rankings;
  the tool reports what it dropped and never guesses on your behalf.
- **Read the three credibility numbers together**: unmatched references, name ambiguities,
  mapped edges. Structure comes from parsing; dependency edges come from identifier
  matching. A `refs` result is a statistical inference — check the source when it decides
  something.
- **The graph self-refreshes.** The server re-reads the bundle before every call; if a
  result ends with a `🔁 … updated … re-query` notice, the snapshot changed mid-session —
  re-query instead of reusing answers you got before that notice.

## When not to use it

Reading a file you can already name, precise text work, edits, or anything outside the
scanned repository — use normal tools instead. CodeAtlas narrows down *where* to look; it
never replaces looking.
