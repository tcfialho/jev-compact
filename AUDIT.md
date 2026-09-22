# Base-project audit

Audit date: 2026-09-22.

Compared against:

- `IAmUnbounded/save-token-jev-clean`
- `leonaaardob/fast-dev-compaction`
- current `openai/codex` main, including compaction lifecycle, rollout reconstruction, hook schema, and plugin manifest guidance.

## Important correction about PreCompact

The two base Codex implementations are not wrong for using `PreCompact`.

Their design is:

1. inspect the rollout before Codex compacts it;
2. use Jev to choose exact evidence worth preserving;
3. save that retained evidence to a sidecar;
4. allow Codex native compaction to run;
5. restore the retained evidence after successful compaction.

Current Codex command hooks give `PreCompact` control over continue/stop, not a rewritten history payload. Therefore this hook architecture is a **retention layer around native compaction**, not a replacement for the native compaction request. That distinction does not make the base projects useless; it describes what they actually implement.

`PostCompact` plus `SessionStart(source=compact)` is useful because Codex only queues the compact session-start source after it installs the replacement history. Our implementation keeps that behavior and makes the sidecar consumable only after `PostCompact` confirms success.

## Feature comparison after this audit

| Capability | save-token | fast-dev | ours 0.2 | Decision |
|---|---:|---:|---:|---|
| PreCompact selection | yes | yes | yes | kept |
| Native Codex compaction remains in control | yes | yes | yes | kept |
| PostCompact confirmation | no | yes | yes | kept from fast-dev |
| SessionStart(compact) restore | yes | yes | yes | kept |
| UserPromptSubmit recovery fallback | no | no | yes | extra safety |
| Replay `replacement_history` | incomplete | yes | yes | kept/improved |
| Modern bounded rollout tail loading | no | no | yes | Codex-aware improvement |
| Legacy compaction handling | weak | yes | yes | kept |
| Legacy rollback correctness | no | partial/full replay | fail-open | deliberate: never judge known-wrong history |
| Plaintext inter-agent communication | no | no | yes | Codex-aware improvement |
| Encrypted agent context | not handled | not handled | fail-open | deliberate |
| Developer/system message preservation | generic adapter yes | Codex parser user/assistant only | yes | fixed in 0.2 |
| `tool_search_output.tools` | generic adapter loses it | explicit support | yes | fixed before 0.2 |
| Staged Jev state fitting | yes | yes | yes | kept |
| Preserve recent messages | yes | yes | yes | kept |
| Conservative KEEP -> TRUNCATE -> DROP precedence | yes | yes | yes | restored in 0.2 |
| Untouched object identity | yes | yes | yes | restored in 0.2 |
| Concurrent Jev batches | bounded | unbounded Promise.all | bounded | kept from save-token |
| Provider timeout | yes | no | yes | kept |
| Retry/backoff | limited | no | yes, including Retry-After | improved |
| Real Jev usage tokens | response supports it, not central | no | yes | improved |
| Direct TypeSafe | yes | yes | yes | kept |
| OpenRouter Decisions API | no | no | yes | added |
| API-key file fallback | macOS keychain/env | yes | yes | key-file behavior kept, no platform-specific keychain dependency |
| `PLUGIN_DATA` | yes | plugin-style data | yes | fixed in 0.2 |
| Exact retained context file | sidecar context | yes | yes | kept |
| Structured retained messages file | no | yes | yes | restored in 0.2 |
| Stale sidecar cleanup | no | 48h | 48h | restored in 0.2 |
| Result head/tail before large reinjection | no | yes | yes | restored in 0.2 |
| Full restore mode | effectively yes | yes, capped | yes, **default** | base behavior preserved |
| Index restore mode | no | no | yes, optional | token-first option |
| Per-tool decision/savings history | yes | limited | yes | restored in 0.2 |
| Dashboard | rich, auto-start | no | rich, manual | manual intentionally avoids process startup in hook path |
| Windows hook command | limited | yes | yes | restored in 0.2 |
| Manual compact + JSON/context outputs | generic CLI | yes | yes | restored in 0.2 |
| Skill docs | no | yes | yes | restored in 0.2 |
| Valid plugin author metadata | yes | yes | yes | fixed in 0.2 |
| Marketplace manifest | repo-specific URL | valid published URL | omitted until a real repository URL exists | avoids shipping a fake `YOUR_ORG` URL |
| Claude/OpenCode/OpenAI generic adapters | yes | no | no | intentionally out of Codex-focused runtime scope |

## Deliberate non-copies

### Multi-host adapters

`save-token-jev-clean` is a portable library for multiple hosts. This project is deliberately Codex-first. Copying Claude/OpenCode/OpenAI adapter surfaces does not improve the Codex hook and would increase maintenance/API surface. The core Jev engine remains separable, so adapters can be added later without changing compaction semantics.

### Auto-start dashboard

`save-token` can start its dashboard from the hook path. Ours leaves the dashboard explicit (`dashboard`) so a compaction hook does not spawn or probe an extra process unless requested. Metrics are still always recorded locally.

### Marketplace placeholder

A local package cannot honestly contain a Git marketplace URL until a real repository exists. The previous `YOUR_ORG` manifest was removed. Direct installation remains `node dist/cli.js install`; a marketplace manifest should be added when the repository is published.

## Current restore default

During this audit the default was changed back to `full`, capped at 60,000 characters, because that matches the useful behavior of the base compaction plugins: Jev-selected evidence should actually be available to the model after compaction.

`CODEX_JEV_RESTORE_MODE=index` remains available for aggressive token reduction. `hybrid` is the middle ground. The exact archive is kept on disk in all modes.

## Evidence-driven invariants

- Never remove or mutate user/developer/system text during Jev pruning.
- Only make DROP/TRUNCATE decisions for paired completed tool calls/results.
- Prefer KEEP when independent Jev answers are inconsistent about whether a full result is necessary.
- Do not mark a sidecar ready until native Codex compaction succeeded.
- Consume a ready restore at most once.
- Fall back to native Codex behavior when rollout semantics are known to be unsafe to reconstruct.
