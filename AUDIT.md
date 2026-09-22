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

| Capability | save-token | fast-dev | ours 0.3 | Decision |
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
| Image/audio message or tool-result context | opaque/generic handling varies | not handled | fail-open | Codex-aware: do not let text-only Jev judge unseen media |
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
| Stale pending state invalidation on new PreCompact | no | no | yes | prevents an older prepared sidecar being readied by a later compaction |
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

`JEV_COMPACT_RESTORE_MODE=index` remains available for aggressive token reduction. `hybrid` is the middle ground. The exact archive is kept on disk in all modes.

## Evidence-driven invariants

- Never remove or mutate user/developer/system text during Jev pruning.
- Only make DROP/TRUNCATE decisions for paired completed tool calls/results.
- Prefer KEEP when independent Jev answers are inconsistent about whether a full result is necessary.
- Do not mark a sidecar ready until native Codex compaction succeeded.
- Consume a ready restore at most once.
- Fall back to native Codex behavior when rollout semantics are known to be unsafe to reconstruct.


## 0.3 performance/correctness pass — 2026-09-22

Validated again against current `openai/codex` main hook schema and rollout item shapes. No architectural behavior from the base projects was removed.

Changes in this pass:

- immutable Jev state is serialized once per compaction instead of once per request batch; provider/key/config resolution is cached per client;
- tool inputs and Jev question objects are built once and reused through fitting/batching; token estimation no longer allocates a regex match array;
- state fitting removes only already-content-free omission markers before merging old call runs, allowing materially larger call histories to fit without dropping additional semantic text;
- post-checkpoint rollout parsing is streamed in chunks instead of loading the entire suffix into a second full string; giant cross-chunk records remain supported;
- history/metrics writes are explicitly best-effort and cannot turn a valid compaction/restore into a functional failure; restore reads the archive before atomically claiming it;
- `PostCompact` persistence failure is fail-open because native compaction has already succeeded;
- archives are written concurrently and `.messages.json` uses compact JSON; the `ready` history row no longer duplicates all Jev decisions;
- Noul outputs outside `[0,1]`, encrypted function arguments, and image-generation context are rejected/fail-open instead of being silently misinterpreted;
- hook numeric configuration is bounded and unknown restore modes fall back to preservation-first `full`.

Synthetic local measurements on this environment (not provider/network benchmarks):

- 50 repeated Jev batches sharing a large state: local provider serialization/config path ~136.6 ms -> ~27.1 ms with immutable-state caching; request bytes are unchanged;
- ~20 MB Codex rollout suffix: loader ~85.8 ms / 161.5 MB RSS -> ~63.6 ms / 123.8 MB RSS;
- 300-call synthetic compactor case: ~35.1 ms baseline -> ~23.7 ms in this pass;
- the previous 24k-state-budget synthetic case failed around 400 calls; the revised fitter accepts 600 calls and still rejects 800 when the genuinely minimal Jev state exceeds the configured budget.

These measurements isolate local implementation overhead. They do not claim reductions in TypeSafe/OpenRouter network latency.
