# GSD Pi Hermes Memory Extension

## Project Overview

This is a GSD Pi coding agent extension that brings Hermes-style persistent memory and a learning loop to any GSD Pi user. After `gsd install`, users get persistent memory across sessions, a background learning loop, and session-end flush.

**v0.0.7 is in release-candidate phase (M001 Fondazioni)**. See `docs/ROADMAP.md` for the full roadmap and `.gsd/phases/01-fondazioni-0-0-7-dipendenza-gsd-pi-e-fix/` for the active phase plan.

## Architecture

- **Language**: TypeScript (loaded via jiti, no compilation needed at runtime)
- **Runtime**: GSD Pi extension API (`@gsd/pi-coding-agent`)
- **Storage**: Two markdown files (`MEMORY.md`, `USER.md`) in `~/.gsd/agent/memory/`
- **Entry point**: `src/index.ts` — registers tools, event handlers, and commands
- **Dependency model**: il package dipende da `@opengsd/gsd-pi@^1.17.0` (installato via npm); `scripts/link-pi-sdks.mjs` crea symlink `node_modules/@gsd/*` → `node_modules/@opengsd/gsd-pi/packages/*` ad ogni `npm install`. Idempotente.

## Key Files

| File | Purpose |
| --- | ---
| `src/index.ts` | Extension entry point — wires all components together |
| `src/types.ts` | Shared TypeScript interfaces + `getMessageText()` helper |
| `src/constants.ts` | Prompts, defaults, delimiter |
| `src/store/memory-store.ts` | Core `MemoryStore` class — CRUD, persistence, frozen snapshot |
| `src/store/content-scanner.ts` | `scanContent()` — injection/exfiltration detection |
| `src/store/recovery-maintenance.ts` | sweep `.recovery-*`/`.retired-*` su store dormienti; wired in `session_start` con `console.warn` non-bloccante |
| `src/store/db.ts` | migration FTS5 `tokenize='trigram'` idempotente (preserva dati) |
| `src/tools/memory-tool.ts` | `registerMemoryTool()` — LLM tool definition |
| `src/handlers/background-review.ts` | `setupBackgroundReview()` — learning loop via `pi.exec` |
| `src/handlers/session-flush.ts` | `setupSessionFlush()` — pre-compaction/shutdown flush |
| `src/handlers/insights.ts` | `registerInsightsCommand()` — `/memory-insights` command |
| `src/handlers/migrate-from-pi-hermes-memory.ts` | bridge `~/.pi/agent/pi-hermes-memory/` → `~/.gsd/agent/`, idempotente via marker file |
| `scripts/link-pi-sdks.mjs` | symlink `@gsd/*` → `@opengsd/gsd-pi/packages/*` con version detection `MIN_GSDPI_VERSION` |
| `scripts/cherry-pick.sh` + `scripts/cherry-pick.manifest` | infrastruttura cherry-pick da upstream pi-hermes-memory (32 entry placeholder + header) |
| `PLAN.md` | Full v0.1 implementation plan with Hermes source file reference map |
| `docs/ROADMAP.md` | Full roadmap with Hermes competitive analysis + gap analysis |
| `docs/0.2/TASKS.md` | v0.2 task breakdown — Skills + Smart Curation |

## Design Decisions

1. **Frozen snapshot** — Memory is injected into system prompt once at session start, never mutated mid-session (preserves Pi's prompt caching)
2. **Atomic writes** — Temp file + `fs.rename()` for crash safety
3. **`pi.exec()` for background review** — Stays within Pi's intended extension API
4. **`§` delimiter** — Same as Hermes for consistency
5. **No SQLite** — GSD Pi has its own `SessionManager`, we read from it directly
6. **Lock DB unificato** — `withMarkdownMutationLock` usa `.gsd-pi-hermes-locks.sqlite` su tutti i siti (consolidation, auto-consolidate, sync-markdown, migration); atomic-lock-coordinator e sqlite-lazy-load accettano path arbitrari per i test

## Hermes Source Reference

The implementation is ported from the Hermes agent harness. See `PLAN.md` → "Hermes Source File Reference Map" for exact files and line ranges to read.

## Roadmap & Task Tracking

- **Roadmap**: `docs/ROADMAP.md` — full roadmap with Hermes competitive analysis, gap analysis, and phased plan (v0.1 → v0.5 → v1.0)
- **v0.1 tasks** (complete): `docs/0.1/TASKS.md`
- **v0.2 tasks** (current): `docs/0.2/TASKS.md` — Skills, auto-consolidation, correction detection, tool-call-aware nudge

**Workflow:**

1. Pick a task from `docs/0.2/TASKS.md`
2. Mark it `[~]` (in progress)
3. Implement it
4. Mark it `[x]` (done) with the commit hash
5. Move to the next task

**Before starting any work, read `docs/0.2/TASKS.md` to see what's next.**

## Development

```bash
# Type check
npm run check

# Test locally
gsd -e ./src/index.ts
```

## Installation (for users)

```bash
gsd install npm:@efrembaraldo/gsd-pi-hermes-memory

# or from git
gsd install git:github.com/efrembaraldo/gsd-pi-hermes-memory
```
