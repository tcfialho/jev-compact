# codex-jev-compact

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

- Codex-aware `replacement_history` replay and bounded reverse rollout loading;
- preserves `developer`, `system`, user and assistant text in Jev-visible state;
- understands `tool_search_output.tools` and plaintext inter-agent communication;
- fail-open behavior for legacy rollback and encrypted agent context that cannot be judged correctly;
- Jev Noul questions directly measure loss from DROP and TRUNCATE;
- conservative decision precedence matching the base engines: KEEP full result first, then TRUNCATE, then DROP;
- bounded Jev concurrency, timeout, retry/backoff, `Retry-After`, and measured provider token usage;
- TypeSafe direct **or OpenRouter Decisions API**;
- environment or key-file credentials;
- exact `.context.txt` archive plus structured `.messages.json` sidecar;
- `PostCompact` readiness + atomic one-shot restore;
- stale sidecar cleanup;
- per-tool savings/decision metrics and optional dashboard;
- Windows hook commands;
- zero runtime npm dependencies.

## Install

```bash
npm install
npm run build
export TYPESAFE_API_KEY="..."
node dist/cli.js install
```

Then open `/hooks` once in Codex to review/trust the installed hooks.

Until this project has a real published Git repository, direct installation is canonical; no fake marketplace URL is shipped.

### OpenRouter

```bash
export OPENROUTER_API_KEY="..."
export CODEX_JEV_PROVIDER=openrouter
node dist/cli.js install
```

### Key file

Useful when Codex is launched from an environment that does not inherit shell variables:

```bash
export CODEX_JEV_PROVIDER=typesafe
export CODEX_JEV_KEY_FILE="$HOME/.config/codex-jev-compact/typesafe_api_key"
```

Provider-specific alternatives are `TYPESAFE_API_KEY_FILE` and `OPENROUTER_API_KEY_FILE`.

## Restore modes

The default is **`full`**, preserving the main behavior of the base projects. It reinjects Jev-selected context with a 60k-character global cap and per-result head/tail bounding. The complete exact archive remains on disk.

```bash
# base-compatible preservation-first behavior (default)
export CODEX_JEV_RESTORE_MODE=full

# small index only
export CODEX_JEV_RESTORE_MODE=index

# index + smaller verbatim excerpt
export CODEX_JEV_RESTORE_MODE=hybrid
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
| `CODEX_JEV_PROVIDER` | `auto` |
| `CODEX_JEV_KEEP_THRESHOLD` | `0.5` |
| `CODEX_JEV_PRESERVE_RECENT` | `6` |
| `CODEX_JEV_MAX_STATE_TOKENS` | `24000` |
| `CODEX_JEV_MAX_REQUEST_TOKENS` | `30000` |
| `CODEX_JEV_CONCURRENCY` | `4` |
| `CODEX_JEV_TRUNCATE_HEAD_CHARS` | `300` |
| `CODEX_JEV_MIN_REDUCTION` | `0.15` |
| `CODEX_JEV_RESTORE_MODE` | `full` |
| `CODEX_JEV_INDEX_CHARS` | `12000` |
| `CODEX_JEV_CONTEXT_CHARS` | `60000` |
| `CODEX_JEV_TIMEOUT_MS` | `20000` |
| `CODEX_JEV_RETRIES` | `1` |
| `CODEX_JEV_STATE_MAX_AGE_MS` | `172800000` |

Optional goal override: `CODEX_JEV_GOAL` (legacy-compatible `FAST_JEV_GOAL` is also accepted).

Provider overrides: `JEV_MODEL`, `JEV_BASE_URL`, `OPENROUTER_JEV_MODEL`, `OPENROUTER_JEV_URL`, `OPENROUTER_HTTP_REFERER`.

Data directory precedence: `PLUGIN_DATA` -> `CODEX_JEV_DATA_DIR` -> `~/.codex/jev-compact`.

## Development

```bash
npm run check
```

Runtime code has no third-party npm dependencies.

## Credits

Independent implementation informed by the MIT-licensed `IAmUnbounded/save-token-jev-clean`, `leonaaardob/fast-dev-compaction`, and `tamaratran/fast-jev-compaction` projects.
