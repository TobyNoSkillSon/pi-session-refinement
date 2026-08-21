# Session lifecycle

## New sessions

A new persistent session starts with no memory. Trigger counters begin at startup.

## Resume

Existing memory is loaded before the first model response. If memory has a valid cursor and the branch contains a new tail, the examiner processes that tail synchronously before injection. Historical sessions with no refinement files receive a persistent rebuild warning rather than incurring unrequested reconstruction cost.

## Timed checkpoints

After the configured elapsed time and minimum root tool results, the examiner processes entries after the persistent cursor. Work is background and single-flight. The completed block is stored immediately but activated only after compaction or resume.

## Context and manual compaction

At the configured context percentage, the extension requests compaction. `session_before_compact` is awaited by Pi, so the examiner completes, exhausts retries, or skips before normal Pi compaction proceeds. Manual `/compact` follows the same ordering.

## Progress and interaction

Model-backed refinement displays a non-modal animated indicator above the editor. Background checkpoints do not block conversation. Resume processing finishes before the first response, while Pi queues submissions during compaction. Reconstruction behaves as a foreground maintenance operation: the editor remains usable, submitted prompts wait, and Escape cancels before the replacement commit begins.

## Budget

When a complete proposed checkpoint would exceed the configured budget, active memory is unchanged and the proposed block is written to `pending.md`. A persistent warning instructs the root agent to consult the user before editing, compressing, merging, or deleting memory.

## Broken state

Unreadable or inconsistent mechanical state disables examination but not Pi. The condition warns on every user turn until the user requests `/session-refinement-rebuild` or repairs the files through the root agent.
