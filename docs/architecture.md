# Architecture

## Boundary

Pi Session Refinement belongs only to a persistent interactive Pi session. A session without a session file is ignored, which excludes spawned in-memory children and `--no-session` runs. The internal examiner is an isolated AgentSession with no extensions, context files, skills, prompts, themes, or general coding tools.

## Lifecycle

1. `session_start` resolves the session ID, configuration, state, memory, resume condition, and fork ancestry.
2. `before_agent_start` loads pending resume work once, injects the stable memory block, and emits persistent warnings.
3. `tool_result` counts root tool activity.
4. `agent_settled` checks context-percentage and elapsed-time/activity triggers.
5. `session_before_compact` awaits any background examiner and examines unprocessed material before Pi summarizes it.
6. `session_compact` activates the newest on-disk memory version.
7. `session_shutdown` cancels background work in ordinary interactive Pi. Agent Runner roles drain an already-started post-turn checkpoint before disposal so the next one-turn worker cannot overlap it.

## Examiner

The examiner model is resolved from the parent session's current ModelRegistry. Its isolated SDK session receives a dedicated `append_memory` custom tool and a system prompt loaded from `prompts/examiner.md`. SDK automatic retry and automatic compaction are disabled so the configured `maxAttempts` remains the real attempt count.

## Cache stability

A timed checkpoint updates `memory.md` on disk but not the in-process injected snapshot. The snapshot changes only after compaction, resume, fork bootstrap, or reconstruction. Therefore ordinary turns between those events receive byte-identical session memory.

## Persistence

`memory.md` is chronological model-facing content. Machine cursor metadata is stored in hidden HTML comments and removed before prompt injection. `state.json` stores counters, warning state, the last processed session entry, and checkpoint records. Raw Pi JSONL remains canonical evidence.

## Forks

A fork copies only parent checkpoints whose terminal source entry is on the forked branch. Any remaining branch tail is examined before the first response. If no safe checkpoint can be inherited, the fork reconstructs its branch in a temporary directory before activation.

## Usage

Each examiner interval appends a `pi-session-refinement-usage` custom session entry. Custom entries do not enter model context. The entry records configured/used model, thinking, attempts, fallback, usage, trigger, and error.
