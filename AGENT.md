# AGENT.md

- Use Git from the start; commit small checkpoints.
- Prefer Codex correctness and measurable token reduction.
- Keep code simple, fast, dependency-light, and easy to install.
- Support TypeSafe Jev directly and OpenRouter-compatible provider configuration.
- Preserve system/developer/user/assistant text verbatim; only prune completed tool calls/results.
- Parse Codex rollout compaction records so decisions use the live transcript.
- Fail open to native Codex compaction.
- Add tests for adapters, compaction, hooks, and provider transports.
- Avoid unnecessary comments; explain only non-obvious reasons.
