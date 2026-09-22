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
- [ ] Optional future: portable host adapters from save-token if multi-host support becomes a goal.
- [ ] Optional future: compaction-only Responses proxy; do not replace hook mode.
