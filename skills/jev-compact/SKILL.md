---
name: jev-compact
description: Configure Jev Compact with OpenRouter or TypeSafe, check plugin readiness, and explain compaction decisions and metrics.
---

# Jev Compact

Use this skill when the user asks to set up an API key, check readiness, or inspect compaction decisions and metrics.

## Plugin setup

Find the installed `jev-compact` entry with `codex plugin list --json` and use its `installedPath` to run `dist/cli.js`. Do not assume a global `jev-compact` command exists.

Run `node "<installedPath>/dist/cli.js" doctor --json` first. If `apiKeyConfigured` is true, keep the current provider and key. Run `node "<installedPath>/dist/cli.js" install` to remove any older Jev Compact user hooks while keeping the plugin hooks. Check `/hooks` in Codex and confirm PreCompact, PostCompact, SessionStart, and UserPromptSubmit are active.

If the key is missing, use `setup openrouter` or `setup typesafe` from that installed CLI path. Ask which provider only when the user has not specified one. Give the exact local command and have the user enter the key in the terminal's masked prompt; never ask for the key in chat. Plugin setup keeps hook management inside Codex. Recheck `doctor --json` and `/hooks` afterward. In plugin mode, `hooksInstalled` describes only standalone user hooks; `pluginRoot` identifies the plugin package.

## Lifecycle

- `SessionStart(startup/resume/clear)`: check for a usable API key and migrate older Jev Compact hooks before the plugin runs.
- `PreCompact`: read the Codex rollout, reconstruct model-visible conversation content, score completed tool calls/results with Jev, and write retained sidecars.
- Codex runs its native compaction unchanged.
- `PostCompact`: mark the prepared sidecar ready only after compaction succeeds.
- `SessionStart(source=compact)`: compare retained evidence with the new compacted Codex history and inject only selected evidence still missing verbatim. `UserPromptSubmit` is a recovery fallback if that lifecycle delivery is missed.

Do not claim that hook mode rewrites the native Codex compaction request. It preserves selected tool evidence around native compaction.

## Useful commands

- `node "<installedPath>/dist/cli.js" setup openrouter` (OpenRouter)
- `node "<installedPath>/dist/cli.js" setup typesafe` (TypeSafe)
- `node "<installedPath>/dist/cli.js" doctor`
- `node "<installedPath>/dist/cli.js" config`
- `node "<installedPath>/dist/cli.js" config mode observe`
- `node "<installedPath>/dist/cli.js" config restore-mode balanced`
- `node "<installedPath>/dist/cli.js" stats --json`
- `node "<installedPath>/dist/cli.js" dashboard` (restarts it; the plugin already starts it at `http://127.0.0.1:43127/` with each Codex session)
- `node "<installedPath>/dist/cli.js" compact <rollout.jsonl> --context retained.txt --json retained.json`

## Files

The data directory is `PLUGIN_DATA`, then `JEV_COMPACT_DATA_DIR`, then the active plugin's data directory, then `CODEX_HOME/jev-compact` (or `~/.codex/jev-compact`).
Per-session files include state, a full retained normalized context archive, and structured retained messages. History metrics are stored in `history.jsonl`.


## Restore semantics

Preferred modes are `preserve` (default), `balanced`, and `minimal`. The restore hooks set Codex `additionalContextLimit` to `0` intentionally so Codex does not apply its own generic hook-output spill on top of jev-compact's restore mode/cap. `JEV_COMPACT_RESTORE_MAX_CHARS` is therefore the plugin-level global cap for the selected evidence payload in all restore modes; mode-specific limits may be smaller.

For normal use, prefer `node "<installedPath>/dist/cli.js" config`. The user-facing controls are `mode`, `restore-mode`, `restore-max-chars`, `pin-recent-messages`, `loss-threshold`, and `min-reduction-ratio`. Environment variables remain overrides for automation and compatibility.

`mode=active` is the default. `mode=observe` still runs Jev and the post-compaction membership analysis, records what would have been restored, but returns no `additionalContext` to Codex. `shadow` is a compatibility alias for `observe`.

Post-compaction dedupe is intentionally exact/conservative: message role+full text must match, and a completed tool pair is considered present only when both exact call and exact result survive. The checkpoint used for membership must be newer than the byte position recorded at `PreCompact`; otherwise restore falls back to the full preservation-first behavior.

The preferred pruning control is `loss-threshold` / `JEV_COMPACT_LOSS_THRESHOLD` (default `0.5`). Higher means more aggressive pruning because a higher Jev-estimated loss risk is accepted. The old `JEV_COMPACT_KEEP_THRESHOLD` name remains an alias.
