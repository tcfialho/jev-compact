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

Do not claim that hook mode rewrites the native Codex compaction request. It preserves selected verbatim evidence around native compaction.

## Useful commands

- `jev-compact doctor`
- `jev-compact stats --json`
- `jev-compact dashboard`
- `jev-compact compact <rollout.jsonl> --context retained.txt --json retained.json`

## Files

The data directory is `PLUGIN_DATA`, then `JEV_COMPACT_DATA_DIR`, then `~/.codex/jev-compact`.
Per-session files include state, an exact rendered context archive, and structured retained messages. History metrics are stored in `history.jsonl`.
