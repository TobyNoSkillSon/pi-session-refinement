# Architecture

## Boundary

Pi Session Refinement runs only in a persistent interactive root session. A session without a session file is ignored, which excludes spawned in-memory children and `--no-session` runs.

Refinement and consolidation each run in a separate isolated `AgentSession`. Those sessions load no extensions, context files, skills, prompt templates, themes, or general coding tools. The examiner receives the current rendered memory and one new transcript interval. The consolidator receives only the selected oldest record prefix. It cannot see the retained suffix.

## Lifecycle

1. `session_start` resolves the session ID, configuration, memory version, resume condition, and fork ancestry.
2. `before_agent_start` processes a valid v2 resume tail once, injects the stable memory snapshot, and emits persistent warnings.
3. `tool_result` counts root activity while automatic refinement is available.
4. `agent_settled` checks context pressure before checking whether refinement is paused, then evaluates the elapsed-time/activity trigger.
5. `session_before_compact` waits for active work and examines material that compaction will remove.
6. `session_compact` activates the newest published memory.
7. `session_shutdown` cancels background work in ordinary interactive Pi. Agent Runner roles drain an already-started post-turn checkpoint so consecutive workers do not overlap it.

## Staged publication

The examiner's `append_memory` tool submits a candidate to trusted host code; it does not write files. The host adds v2 metadata and renders the full candidate in memory.

Below the rolling threshold, the host can publish the staged memory directly. At or above 80%, it considers only contiguous whole-record ranges that can reach the mandatory 60% headroom target. It measures each range as actually materialized, prefers feasible selected mass closest to 50% of budget, and subtracts exact retained-memory, header, heading, and metadata costs before telling the consolidator its body allowance. On forks, a range may be wholly inherited or wholly local but may not cross the immutable boundary. The host then validates actual final size, compression, chronology, and byte-exact retained material.

Publication writes a unique immutable generation, fsyncs it, and then atomically writes `state.json` with the generation path and SHA-256. A process failure before the state rename leaves the old pointer and cursor authoritative. The failed generation is removed best-effort; after success, every generation except the active one is removed best-effort. These files are transaction machinery, not rollback history.

## Model resolution

The examiner and consolidator have separate public model and thinking settings. Each operation resolves exact provider/model references or a unique bare ID through Pi's current `ModelRegistry`. It attempts the configured model up to `maxAttempts`, then tries the current interactive model when different and available. SDK automatic retry and automatic compaction are disabled, so these attempts are the effective count.

## Cache stability

A timed checkpoint publishes a new generation without changing the in-process injected snapshot. The snapshot changes only after compaction, resume, fork bootstrap, or reconstruction.

Pi may call `agent.continue()` after compaction without firing `before_agent_start`. The extension retains the exact newly examined checkpoint in memory and activates it only after compaction. The `context` hook supplies that additive checkpoint as a non-persistent custom message on every immediate provider call. This also covers a disk publication that consolidated memory: the consolidation body is never presented below stale system-prompt memory as if it were a replacement. The next fresh system prompt loads the full authoritative generation and clears the temporary update.

## Persistence

Each `generations/memory-<id>.md` contains model-facing Markdown plus hidden v2 record metadata. `state.json` stores and hashes the active generation together with the transcript cursor, counters, warnings, ordered record metadata, and optional fork floor. Only the generation named by validated state may be injected or inherited. The cursor always names the newest processed raw transcript entry; consolidation does not move it backward.

`memory.md` and v1 `state.json` remain read-only until an explicit successful rebuild replaces them. No derived-memory database or permanent generation archive exists. Raw Pi JSONL remains canonical evidence. Usage entries are custom session records and do not enter model context.

## Compatibility

A valid v1 state and memory are loaded and injected read-only. Automatic writes stop and every turn requests a manual rebuild. The extension applies the same policy to historical sessions with no memory. It does not scan sibling sessions or migrate them.

## Forks

A v2 fork copies only the active record prefix whose source cursors are valid at the selected fork point. It records that point as an immutable rebuild floor even when inherited memory ends earlier. Child processing begins after the floor. Later rebuilds preserve the inherited baseline and segment only the fork-local tail.

The extension never replays parent JSONL automatically. A fork before the parent's rolling base may inherit no records. A v1 fork stays legacy until its user requests a rebuild. A valid inherited v1 baseline is converted then; if it cannot be validated, rebuild drops that inherited prose but retains the recorded floor rather than silently becoming a root rebuild.
