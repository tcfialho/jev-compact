---
name: jev-compact
description: Inspect and explain Jev-guided retained context around Codex compaction, its decisions, metrics, and local sidecar files.
---

# Jev Compact

Use this skill when the user asks about the plugin's compaction decisions, retained context, configuration, metrics, or troubleshooting.

## Lifecycle

- `PreCompact`: read the Codex rollout, reconstruct model-visible conversation content, score completed tool calls/results with Jev, and write retained sidecars.
- Codex runs its native compaction unchanged.
- `PostCompact`: mark the prepared sidecar ready only after compaction succeeds.
- `SessionStart(source=compact)`: inject the retained index/context once. `UserPromptSubmit` is a recovery fallback if that lifecycle delivery is missed.

Do not claim that hook mode rewrites the native Codex compaction request. It preserves selected tool evidence around native compaction.

## Useful commands

- `jev-compact setup` (TypeSafe, first-time setup)
- `jev-compact setup openrouter` (OpenRouter, first-time setup)
- `jev-compact doctor`
- `jev-compact config`
- `jev-compact config restore-mode balanced`
- `jev-compact stats --json`
- `jev-compact dashboard`
- `jev-compact compact <rollout.jsonl> --context retained.txt --json retained.json`

## Files

The data directory is `PLUGIN_DATA`, then `JEV_COMPACT_DATA_DIR`, then `~/.codex/jev-compact`.
Per-session files include state, a full retained normalized context archive, and structured retained messages. History metrics are stored in `history.jsonl`.


## Restore semantics

Preferred modes are `preserve` (default), `balanced`, and `minimal`. The restore hooks set Codex `additionalContextLimit` to `0` intentionally so Codex does not apply its own generic hook-output spill on top of jev-compact's restore mode/cap. `JEV_COMPACT_RESTORE_MAX_CHARS` is therefore the plugin-level global cap for the selected evidence payload in all restore modes; mode-specific limits may be smaller.

For normal use, prefer the persistent `jev-compact config` command. The five user-facing controls are `restore-mode`, `restore-max-chars`, `pin-recent-messages`, `loss-threshold`, and `min-reduction-ratio`. Environment variables remain overrides for automation and compatibility.

The preferred pruning control is `loss-threshold` / `JEV_COMPACT_LOSS_THRESHOLD` (default `0.5`). Higher means more aggressive pruning because a higher Jev-estimated loss risk is accepted. The old `JEV_COMPACT_KEEP_THRESHOLD` name remains an alias.
