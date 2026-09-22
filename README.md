# jev-compact

Jev-guided **verbatim context retention around Codex compaction**. It evaluates completed tool calls/results at `PreCompact`, lets Codex perform its native compaction, confirms success at `PostCompact`, and restores the selected evidence once through `SessionStart(source=compact)`.

Validated against current `openai/codex` source on 2026-09-22 and the current TypeSafe System One/Jev API. See `AUDIT.md` for the base-project feature audit.

## What PreCompact does here

The base projects are not mistaken for using `PreCompact`. In current Codex, that hook runs **before** native compaction and can continue or stop the lifecycle, but it does not receive a hook output field that replaces Codex's active history. That makes this architecture useful for a different job:

```text
PreCompact
  -> inspect exact pre-compaction history
  -> Jev selects evidence worth retaining
  -> save sidecars

Codex native compaction

PostCompact
  -> confirm it succeeded

SessionStart(source=compact)
  -> restore selected evidence once
```

So hook mode preserves exact evidence that a summary may lose. It is not claiming to rewrite the native compaction request itself.

## Improvements over the two bases

- Codex-aware `replacement_history` replay with bounded reverse checkpoint discovery and streaming forward parsing;
- preserves `developer`, `system`, user and assistant text in Jev-visible state;
- understands `tool_search_output.tools` and plaintext inter-agent communication;
- fail-open behavior for legacy rollback, encrypted agent context, and image/audio history that a text-only Jev judgment cannot evaluate correctly;
- Jev Noul questions directly measure loss from DROP and TRUNCATE;
- conservative decision precedence matching the base engines: KEEP full result first, then TRUNCATE, then DROP;
- bounded Jev concurrency, timeout, retry/backoff, `Retry-After`, measured provider token usage, and cached immutable-state serialization across batches;
- TypeSafe direct **or OpenRouter Decisions API**;
- environment or key-file credentials;
- exact `.context.txt` archive plus compact structured `.messages.json` sidecar; independent archives are written concurrently, then state is published; pending sidecars are invalidated at every new `PreCompact`;
- `PostCompact` readiness + atomic one-shot restore;
- stale sidecar cleanup;
- per-tool savings/decision metrics and optional dashboard;
- Windows hook commands;
- zero runtime npm dependencies.

## Install

The repository keeps `dist/` committed, so a cloned/released copy can install hooks immediately:

```bash
export TYPESAFE_API_KEY="..."
node dist/cli.js install
```

For development, `npm install` runs the TypeScript build automatically through the package `prepare` script.

Then open `/hooks` once in Codex to review/trust the installed hooks.

Until this project has a real published Git repository, direct installation is canonical; no fake marketplace URL is shipped.

### OpenRouter

```bash
export OPENROUTER_API_KEY="..."
export JEV_COMPACT_PROVIDER=openrouter
node dist/cli.js install
```

### Key file

Useful when Codex is launched from an environment that does not inherit shell variables:

```bash
export JEV_COMPACT_PROVIDER=typesafe
export JEV_COMPACT_KEY_FILE="$HOME/.config/jev-compact/typesafe_api_key"
```

Provider-specific alternatives are `TYPESAFE_API_KEY_FILE` and `OPENROUTER_API_KEY_FILE`.

## Restore modes

The default is **`full`**, preserving the main behavior of the base projects. It reinjects Jev-selected context with a 60k-character global cap and per-result head/tail bounding. The complete exact archive remains on disk.

```bash
# base-compatible preservation-first behavior (default)
export JEV_COMPACT_RESTORE_MODE=full

# small index only
export JEV_COMPACT_RESTORE_MODE=index

# index + smaller verbatim excerpt
export JEV_COMPACT_RESTORE_MODE=hybrid
```

## Commands

```bash
node dist/cli.js doctor
node dist/cli.js stats --json
node dist/cli.js dashboard

node dist/cli.js compact rollout.jsonl \
  --context retained.txt \
  --json retained.json
```

## Important defaults

| Variable | Default |
|---|---:|
| `JEV_COMPACT_PROVIDER` | `auto` |
| `JEV_COMPACT_KEEP_THRESHOLD` | `0.5` |
| `JEV_COMPACT_PRESERVE_RECENT` | `6` |
| `JEV_COMPACT_MAX_STATE_TOKENS` | `24000` |
| `JEV_COMPACT_MAX_REQUEST_TOKENS` | `30000` |
| `JEV_COMPACT_CONCURRENCY` | `4` |
| `JEV_COMPACT_TRUNCATE_HEAD_CHARS` | `300` |
| `JEV_COMPACT_MIN_REDUCTION` | `0.15` |
| `JEV_COMPACT_RESTORE_MODE` | `full` |
| `JEV_COMPACT_INDEX_CHARS` | `12000` |
| `JEV_COMPACT_CONTEXT_CHARS` | `60000` |
| `JEV_COMPACT_TIMEOUT_MS` | `20000` |
| `JEV_COMPACT_RETRIES` | `1` |
| `JEV_COMPACT_STATE_MAX_AGE_MS` | `172800000` |

Optional goal override: `JEV_COMPACT_GOAL`.

Provider overrides: `JEV_MODEL`, `JEV_BASE_URL`, `OPENROUTER_JEV_MODEL`, `OPENROUTER_JEV_URL`, `OPENROUTER_HTTP_REFERER`.

Data directory precedence: `PLUGIN_DATA` -> `JEV_COMPACT_DATA_DIR` -> `~/.codex/jev-compact`.

## Development

```bash
npm run check
```

Runtime code has no third-party npm dependencies.

## Credits

Independent implementation informed by the MIT-licensed `IAmUnbounded/save-token-jev-clean`, `leonaaardob/fast-dev-compaction`, and `tamaratran/fast-jev-compaction` projects.
