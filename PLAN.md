# Checklist — base-project audit

- [x] Verify why both base Codex projects use PreCompact from source, not assumption.
- [x] Compare base feature surfaces against our implementation.
- [x] Preserve base-compatible full restore as default; keep index/hybrid optional.
- [x] Restore conservative KEEP -> TRUNCATE -> DROP decision ordering.
- [x] Preserve developer/system messages and untouched object identity.
- [x] Add key-file fallback, PLUGIN_DATA, stale cleanup, structured messages sidecar.
- [x] Restore result head/tail injection bounding, per-tool history/dashboard metrics.
- [x] Add Windows hooks, skill docs and current Codex-valid plugin metadata.
- [x] Remove fake marketplace URL rather than ship invalid distribution metadata.
- [x] Run full test/package/diff checks.
- [x] Rename project surface to `jev-compact` / `JEV_COMPACT_*`.
- [x] Invalidate stale pending state on every new PreCompact.
- [x] Fail open on media/encrypted context Jev cannot inspect.
- [x] Avoid repeated copying for giant JSONL lines in reverse rollout scan.
- [x] Keep compiled `dist/` in Git for zero-build plugin runtime.
- [ ] Optional future: portable host adapters from save-token if multi-host support becomes a goal.
- [ ] Optional future: compaction-only Responses proxy; do not replace hook mode.


# 0.3 optimization pass

- [x] Re-check current Codex hook lifecycle and ResponseItem shapes.
- [x] Remove repeated Jev state/config/input/question serialization work.
- [x] Increase fitter capacity without discarding additional semantic content.
- [x] Stream post-checkpoint rollout parsing and retain giant-line correctness.
- [x] Make metrics/history unable to control functional hook success.
- [x] Make restore readable-before-claim and keep one-shot atomic semantics.
- [x] Reduce sidecar/history write amplification.
- [x] Add regressions for provider caching, Noul bounds, encrypted args/media, restore retry and logging failure.
- [x] Final release validation, Git commit, ZIP/bundle/npm package.
