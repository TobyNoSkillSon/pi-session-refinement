# Session lifecycle

## New sessions

A new persistent session starts with v2 state and no memory records. Trigger counters begin at startup.

## Resume and compatibility

A valid v2 memory loads before the first response. If its cursor has a new branch tail, the examiner processes that tail before injection. This can create the first checkpoint after a short session resumes.

A valid v1 session follows a stricter path: its memory is still injected, but it stays read-only. Automatic refinement pauses and every turn asks for `/session-refinement-rebuild`. Historical sessions with no refinement memory receive the same warning without the extension creating replacement state. There is no automatic or multi-session migration.

Unreadable state, missing record bodies, and cursor mismatches also pause automatic work and require the command.

## Timed checkpoints

After the configured elapsed time and root tool-result count, the examiner processes entries after `lastProcessedEntryId`. Work is single-flight and runs in the background. A completed candidate is published immediately unless it first requires consolidation. The current prompt continues using its existing snapshot.

## Rolling consolidation

The host checks each staged candidate against 80% of `memoryBudgetTokens`. At the threshold, it selects an oldest legal whole-record range by rendered token mass, aiming closest to 50% of the budget. Ranges that satisfy the size equation but leave no practical model-output allowance are discarded. Existing consolidation records count as ordinary oldest records during later rolls.

A separate isolated model turns that prefix into current continuity at the cutoff. Host metadata records its kind, generation, covered source cursor, underlying source-record count, creation time, and cutoff time. The retained suffix stays byte-exact. Empty, malformed, non-compressing, over-budget, and insufficient-headroom replacements are rejected.

The host publishes only after refinement and any required consolidation succeed. A crash or failure leaves active memory and its cursor unchanged.

## Context and manual compaction

At the configured context percentage, the extension requests compaction. `session_before_compact` is awaited by Pi, so refinement completes, exhausts retries, or skips before Pi compacts. Manual `/compact` follows the same ordering unless disabled in configuration.

If Pi continues the same run, a temporary context message supplies the exact new checkpoint, including when publication also consolidated older records. The next fresh prompt carries the full memory. The consolidation body itself never uses the additive bridge as a lower-priority replacement.

A `consolidation-failed` warning pauses further automatic memory writes but does not suppress early context compaction.

## Rebuild

`/session-refinement-rebuild` asks for confirmation, then processes chronological segments in a temporary transaction. Root sessions start at the branch beginning. A v2 fork begins with its inherited baseline and reconstructs only entries after its immutable floor. Each segment uses the normal rolling check. Active files change only after every segment succeeds.

The editor remains usable while the non-modal loader reports progress. Submitted prompts wait. Escape cancels before replacement publication.

## Forks

At creation, a child copies only the active v2 record prefix valid on the selected branch. Its processing cursor starts at the fork floor, even when inherited memory covers less. The extension never reconstructs the parent's raw history for the child. Old fork points can therefore inherit little or no memory.

A v1 child remains read-only until manual rebuild.

## Failure

Examiner failure leaves the raw interval available to retry. Consolidator failure persists a session warning and asks for rebuild. Pi and its normal compaction lifecycle remain available. Runtime storage contains no permanent old-memory archive; publication keeps an old value only long enough to roll back a failed state write.
