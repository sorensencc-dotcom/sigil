---
ijfw_version: 1.3.2
ijfw_schema: 1
type: software
primary_type: software
secondary_types: []
confidence: 0.907
detected_at: 2026-09-05T15:13:58.710Z
signals:
  - kind: manifest
    weight: 0.9
    manifests: [package.json, package.json]
  - kind: file_extension_ratio
    weight: 0.7
    domain: software
    ratio: 1
    count: 368
---
# AGENTS.md

This file follows the open AGENTS.md spec (https://agents.md/) and is the
canonical agent-instructions surface for this project. Platform-specific
files (CLAUDE.md, GEMINI.md, WAYLAND.md, codex/AGENTS.md, .cursorrules,
.windsurfrules, copilot-instructions.md) are thin adapters that point here.

Five IJFW-managed regions live in this file. Content outside the markers is
yours -- IJFW will never touch it.

| Region | Purpose |
|---|---|
| MEMORY | Project memory recalled from `.ijfw/memory/` |
| ROUTING | Platform skill-routing rules |
| AGENTS | Registered agent roster |
| BLACKBOARD | Multi-CLI orchestration scratchpad (Pillar B) |
| DISCIPLINE | Per-domain discipline rules (code \| narrative \| business \| design \| research) |

<!-- IJFW-MEMORY-START -->
Project memory at .ijfw/memory/. Call `ijfw_memory_prelude` for full context.

Last handoff: Handoff: 2026-09-09 — Sigil FIX session layer
===============================================
<!-- IJFW-MEMORY-END -->

<!-- IJFW-ROUTING-START -->
<!-- IJFW-ROUTING-END -->

<!-- IJFW-AGENTS-START -->
No project agents yet. Run `ijfw team` to set them up.
<!-- IJFW-AGENTS-END -->

<!-- IJFW-BLACKBOARD-START -->
<!-- Reserved for Pillar B multi-CLI orchestration. Empty in alpha. -->
<!-- IJFW-BLACKBOARD-END -->

<!-- IJFW-DISCIPLINE-START -->
<!-- IJFW-DISCIPLINE-END -->

<!-- trail:start -->
## Trail — repo context graph

This repo is indexed in `.trail/cache/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `trail map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `trail ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `trail grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `trail skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `trail callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `.trail/cache/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `trail ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `trail build` (deterministic,
no API key, $0).
<!-- trail:end -->
