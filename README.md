# jevcomp

When a Codex conversation gets long, Codex **compacts** it: it swaps the old history for a short summary so it can keep working. Exact details often get lost in that summary (an error message, a file it already read, a test result), and Codex may have to fetch them again.

jevcomp works alongside Codex:

1. Right before compaction, it asks **Jev** (a small, fast AI model that only answers yes/no style questions) which old command outputs still matter.
2. Codex compacts as usual.
3. Right after, jevcomp adds back only the useful details the summary lost.

Your own messages are never removed. If anything goes wrong, Codex simply compacts as it normally would.

Good to know:

- It does **not** make compaction itself use fewer tokens. It adds back a limited amount of text (60,000 characters at most by default) so Codex loses less and redoes less work.
- Each compaction may make a few small paid Jev requests, billed to your OpenRouter or TypeSafe key.
- The dashboard shows what it actually did in your sessions.

## Install

You need:

- **Node.js 20 or newer**, free from [nodejs.org](https://nodejs.org).
- An **API key** (a password-like code) from [OpenRouter](https://openrouter.ai/keys) or TypeSafe.

Pick **one** of the two ways below.

Used the old name `jev-compact`? Install `jevcomp` the same way. Your saved key, settings, history and old hooks are picked up automatically; then remove the old plugin with `codex plugin remove jev-compact@jev-compact`.

### Option 1: Codex plugin (recommended)

In a terminal:

```bash
codex plugin marketplace add tcfialho/jevcomp
codex plugin add jevcomp@jevcomp
```

Then, in Codex:

1. Ask: `Configure jevcomp with OpenRouter` (or `with TypeSafe`) and paste the key where the terminal asks for it.
2. Type `/hooks` and approve the four jevcomp hooks.

### Option 2: npm (also gives you the `jevcomp` terminal command)

```bash
npm install -g --install-links github:tcfialho/jevcomp
jevcomp setup openrouter
```

For TypeSafe, run `jevcomp setup` instead. Then restart Codex, type `/hooks` and approve the four hooks.

Keep `--install-links`: without it, current npm versions install a broken link.

### Check that it works

- npm: `jevcomp doctor`
- Plugin: ask Codex `Check jevcomp`.

The next time Codex starts, it shows the dashboard address (see [Dashboard](#dashboard)).

Commands below are written as `jevcomp ...`. With the plugin only, ask Codex to run them for you.

## What Jev is doing

Jev is used as a fast **judge**, not as the coding model. For each completed tool call/result pair it answers two questions:

1. Would removing this call and result lose information still needed for the task?
2. Would shortening only the result lose information still needed?

Jev receives a bounded text view of the conversation and tool evidence. Common credential patterns are redacted from that provider-bound view, but the redaction cannot recognize every possible secret.

That produces three practical outcomes:

| Decision | What happens |
| --- | --- |
| **Keep** | Call and complete result remain in the retained evidence. |
| **Shorten** | Call remains; a long result keeps a bounded prefix plus a recovery note. |
| **Remove** | Call and result are omitted from `jevcomp`'s retained evidence. The tool can be rerun if needed. |

Recent messages are pinned and never pruned.

## How it fits into Codex

Current Codex does not let a `PreCompact` command hook replace the history that Codex itself will compact. `jevcomp` therefore wraps native compaction instead of replacing it:

```text
PreCompact
    ↓
Jev selects exact evidence worth preserving
    ↓
Codex native compaction runs normally
    ↓
PostCompact confirms success
    ↓
SessionStart(source=compact)
    ↓
exact post-compaction membership check
    ↓
only selected evidence still missing is restored once
```

`UserPromptSubmit` is a recovery path if the compact `SessionStart` delivery is missed.

If Jev fails, a key is missing, the rollout cannot be reconstructed safely, or the reduction is too small, the hook **fails open** and Codex continues with its native compaction.

## Dashboard

Open **http://127.0.0.1:43127/** in your browser. It starts by itself when a Codex session starts, and Codex shows the address. It keeps running until you restart the computer; after an update, the next Codex session switches it to the new version.

- Restart it: `jevcomp dashboard` (plugin: ask Codex to restart the jevcomp dashboard).
- Other port: `JEVCOMP_DASHBOARD_PORT=43200`.
- Do not start it: `JEVCOMP_DASHBOARD=off`.

The dashboard shows values that `jevcomp` can actually measure:

- characters present before and after Jev selection;
- exact characters removed from retained tool history;
- how much Jev-selected evidence was already present verbatim after native Codex compaction, so `jevcomp` did not duplicate it;
- how much selected evidence was still missing and eligible for restore;
- the complete hook context actually returned to Codex after compaction, plus the evidence-only portion;
- real Jev input/output token usage when the provider returns usage counters, including how many Jev requests reported them;
- Jev request count and selection time;
- native fallbacks, skips and restore errors separately;
- removed retained-context characters grouped by tool;
- recent Keep / Shorten / Remove decisions and their Jev loss-risk values;
- recent compaction runs and which restore mode they used.
- observe-mode runs, including what would have been restored while Codex context remained unchanged.

It deliberately **does not claim Codex billing-token savings** from a `characters ÷ 4` estimate. Hook mode cannot observe Codex's final billing tokenizer/cache accounting, so the dashboard keeps those numbers separate from what is actually measured.

For a terminal summary:

```bash
jevcomp stats
```

Machine-readable output:

```bash
jevcomp stats --json
```

## Observe mode

If you want to measure `jevcomp` on your own Codex sessions before allowing it to add context back, use:

```bash
jevcomp config mode observe
```

In `observe` mode the real Jev selection still runs at `PreCompact`, and after native compaction `jevcomp` performs the same exact membership/dedupe analysis it would use in active mode. It records:

- what Jev selected;
- whether the configured minimum reduction would have allowed a restore;
- how much selected evidence already survived native Codex compaction verbatim;
- how much was still missing;
- how much evidence/context would have been returned after the configured restore mode and caps;
- real Jev request/token/latency metrics when available.

But it returns **no `additionalContext`** to Codex. Native Codex context is therefore unchanged by `jevcomp`; the trade-off is that you still pay the Jev request cost and wait for its selection during compaction.

Return to normal behavior with:

```bash
jevcomp config mode active
```

`shadow` remains accepted as an environment/config alias for `observe`, but `observe` is the preferred user-facing name.

### Why post-compaction dedupe is conservative

The optimization does not ask another model whether two pieces of text are "basically the same". It only suppresses extra reinjection when there is objective evidence in the new Codex history:

- a normal message must match the same role and full text exactly;
- a completed tool pair is considered already present only when both the exact call and exact result survive;
- result content uses a full-content hash, not a matching prefix;
- the post-compaction rollout must contain a modern checkpoint appended at or after the byte position captured by `PreCompact`.

If the transcript is stale, missing, unsupported, or ambiguous, dedupe is disabled for that restore and `jevcomp` falls back to the previous preservation-first behavior. In other words, a failed membership check can cause duplicate context, but it must not cause retained evidence to disappear.

## Restore modes

The restore mode controls how much of the Jev-selected evidence is added back to Codex after native compaction. `jevcomp` disables Codex's generic hook-output spill for its two restore hooks, so these modes and `JEVCOMP_RESTORE_MAX_CHARS` are the source of truth for our evidence payload instead of being silently truncated again by Codex. The max-chars setting applies to all three modes; a mode may have a smaller internal limit.

### `preserve` — default

```bash
jevcomp config restore-mode preserve
```

Uses the most preservation-first reinjection: selected evidence is restored up to the global cap. To stop one enormous tool result from crowding out everything else, an individual very large result is represented by a bounded head+tail excerpt in the injected payload; the full retained normalized archive always stays on disk and its path is included.

Use this when continuity/exact details matter more than minimizing the extra context added after compaction.

### `balanced`

```bash
jevcomp config restore-mode balanced
```

Injects a compact index plus a bounded evidence excerpt. The full retained normalized archive stays on disk.

This reduces the context added by `jevcomp` while still giving Codex some exact evidence immediately.

### `minimal`

```bash
jevcomp config restore-mode minimal
```

Injects only the compact index and file pointers. The full retained normalized archive stays on disk.

This minimizes `jevcomp`'s own post-compaction payload, but Codex receives less selected evidence automatically.

Legacy values `full`, `hybrid` and `index` are still accepted as aliases for `preserve`, `balanced` and `minimal`.

## Options most users may care about

Defaults are preservation-first. You can change the user-facing settings without editing shell files; this matters when Codex is launched from a desktop app.

```bash
jevcomp config
jevcomp config mode observe
jevcomp config restore-mode balanced
jevcomp config restore-max-chars 40000
jevcomp config pin-recent-messages 8
jevcomp config loss-threshold 0.4
jevcomp config min-reduction-ratio 0.20
```

| Setting | Default | Plain meaning | If you increase it |
| --- | ---: | --- | --- |
| `mode` | `active` | `active` restores selected evidence; `observe` runs the same analysis and records what would happen without injecting context. | Named mode, not a number. Use `observe` to validate behavior safely. |
| `restore-mode` | `preserve` | How much selected evidence is put back after compaction. | This is a named mode, not a number: `balanced` and `minimal` inject less. |
| `restore-max-chars` | `60000` | Hard character cap for the evidence payload in **every** restore mode, before the recovery header/path. `0` disables this global cap; mode-specific limits and the per-result anti-crowding safeguard still apply. | More selected old evidence can return to the model. |
| `pin-recent-messages` | `6` | Newest normalized messages Jev is not allowed to prune. | Safer/more conservative; less history becomes removable. |
| `loss-threshold` | `0.5` | Maximum Jev loss-risk accepted for removing/shortening evidence. The action only happens when its risk is **below** this value. | More aggressive pruning because a higher estimated loss risk is tolerated. |
| `min-reduction-ratio` | `0.15` | Minimum measured character reduction required before a retained sidecar is used. | Requires a larger reduction before jevcomp adds anything back. |

`loss-threshold` is deliberately named around what Jev answers: **risk of losing still-needed information**. If you are unsure, leave it at `0.5`; the dashboard exposes the actual decision scores.

Saved settings live under `~/.config/jevcomp/settings.json`. Environment variables still override saved settings for automation and compatibility: `JEVCOMP_MODE`, `JEVCOMP_RESTORE_MODE`, `JEVCOMP_RESTORE_MAX_CHARS`, `JEVCOMP_PIN_RECENT_MESSAGES`, `JEVCOMP_LOSS_THRESHOLD`, and `JEVCOMP_MIN_REDUCTION_RATIO`. Legacy aliases, including the old `JEV_COMPACT_*` names, remain accepted.

## Advanced options

These are operational limits. They exist for unusual workloads, provider limits and debugging; changing them is normally unnecessary.

| Option | Default | What it controls |
| --- | ---: | --- |
| `JEVCOMP_CONCURRENCY` | `4` | Maximum Jev requests simultaneously in flight. |
| `JEVCOMP_INDEX_MAX_CHARS` | `12000` | Maximum compact-index size used by `balanced`/`minimal`. |
| `JEVCOMP_MAX_STATE_TOKENS` | `24000` | Internal estimated budget for conversation state shown to Jev. |
| `JEVCOMP_MAX_REQUEST_TOKENS` | `30000` | Internal estimated budget for state + questions per Jev request. |
| `JEVCOMP_TRUNCATE_HEAD_CHARS` | `300` | Result prefix retained for **Shorten**. |
| `JEVCOMP_TIMEOUT_MS` | `20000` | Timeout for one Jev provider request. |
| `JEVCOMP_RETRIES` | `1` | Retries after transient provider/network failures. |
| `JEVCOMP_RESTORE_TTL_MS` | `86400000` | How long a completed compaction may wait for its one-shot restore. |
| `JEVCOMP_STATE_MAX_AGE_MS` | `172800000` | Age at which stale per-session sidecars are removed. |
| `JEVCOMP_GOAL` | automatic | Optional explicit task text supplied to Jev instead of deriving it from recent user prompts. |

Provider endpoint/model overrides (`JEV_MODEL`, `JEV_BASE_URL`, `OPENROUTER_JEV_MODEL`, `OPENROUTER_JEV_URL`, `OPENROUTER_HTTP_REFERER`) are intended for provider/development overrides, not normal tuning.

## Provider configuration

Normal first-time use is the `setup` command shown at the top of this README. It stores the selected provider/key and prepares the hooks for the installation method in use. Use `configure` when you want to change the provider or key. The five normal behavior settings use the same config directory, so desktop-launched Codex sessions do not depend on shell startup files.

```bash
jevcomp configure typesafe
jevcomp configure openrouter
```

Environment variables are also supported and override saved configuration:

```bash
export TYPESAFE_API_KEY="..."
```

or:

```bash
export OPENROUTER_API_KEY="..."
export JEVCOMP_PROVIDER=openrouter
```

Key-file overrides are supported through `TYPESAFE_API_KEY_FILE`, `OPENROUTER_API_KEY_FILE`, or `JEVCOMP_KEY_FILE` when the provider is selected by environment or by the saved setup preference.

## Manual inspection

Preview what Jev would retain from a Codex rollout without modifying Codex:

```bash
jevcomp compact rollout.jsonl \
  --context retained.txt \
  --json retained.json
```

The command writes the retained context/JSON and prints compaction statistics to stderr.

## What it deliberately does not do

- It does **not** replace Codex's native compaction request in hook mode.
- It does **not** invent exact Codex token/billing savings from character counts.
- It does **not** select user/developer/system text for deletion.
- Its post-compaction dedupe does **not** use semantic similarity. Anything not proven present verbatim is preserved for reinjection.
- It does **not** semantically judge context it cannot safely read. Encrypted agent content, image/audio content and unsupported history shapes fail open to native Codex behavior.
- It does **not** need the dashboard to record metrics; they are always saved locally.

Codex's experimental token-budget context reset also emits the standard compact-hook lifecycle. `jevcomp` therefore preserves selected evidence around that reset as well. If your reason for enabling token-budget mode is specifically to force a completely clean context with no old retained evidence, disable `jevcomp` for that workflow.

## Data files

Data directory precedence:

```text
PLUGIN_DATA
→ JEVCOMP_DATA_DIR
→ active Codex plugin data directory (including when CLI is run from a release or npm package)
→ CODEX_HOME/jevcomp (or ~/.codex/jevcomp)
```

Each active session can have:

- state metadata;
- a full retained normalized `.context.txt` archive;
- structured retained `.messages.json`;
- local `history.jsonl` observability data.

Old per-session sidecars are cleaned up automatically. History is retained for dashboard/statistics use. `setup` keeps its stable compiled runtime under `~/.codex/jevcomp/runtime` (or under `CODEX_HOME` when set) unless `JEVCOMP_RUNTIME_DIR` overrides it.

## Development

```bash
npm run check
```

Runtime code has no third-party npm dependencies. `dist/` is committed so a downloaded/cloned release can run setup/install without building first.

The test suite uses fake/local Jev transports and does not require paid network calls.

## Credits

Independent implementation informed by the MIT-licensed:

- `IAmUnbounded/save-token-jev-clean`
- `leonaaardob/fast-dev-compaction`
- `tamaratran/fast-jevcompion`
- `fatelei/jevcomp` (post-compaction membership/backfill idea)
- `GhalebDweikat/winnow` (observe/shadow-mode methodology)

See `AUDIT.md` for the detailed behavior comparison and Codex compatibility notes.
