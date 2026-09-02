# Session flow

The README diagram is a hand-styled rendering of [`session-flow.mmd`](session-flow.mmd). The Mermaid source defines the behavior; [`session-flow.svg`](session-flow.svg) is the GitHub-friendly visual asset.

## Reading the diagram

A new transcript interval enters an isolated examiner. The examiner submits prose through one tool, but trusted host code owns the source cursors, record metadata, size checks, and publication.

Below the rolling threshold, the staged candidate can be published directly. At the threshold, the host selects an oldest legal whole-record prefix and sends only that prefix to the consolidator. The consolidator cannot see the exact suffix. Host code joins its replacement to that untouched suffix and validates the complete rolled candidate.

Publication has two durable steps. The extension writes and hashes a unique generation first. It then atomically replaces `state.json` with a pointer to that generation. Only the generation named by valid state is authoritative.

The next safe boundary loads the full generation. An immediate continuation after compaction receives only the exact new checkpoint as a temporary update because a lower-priority message cannot replace stale system-prompt memory safely.

Raw session JSONL remains canonical throughout.

## Required behavior

- Background eligibility requires both elapsed time and root tool activity.
- Pre-compaction refinement is awaited before Pi discards context.
- The examiner receives current rendered memory and one chronological transcript interval.
- The consolidator receives one selected old prefix and no retained suffix.
- Selection uses rendered token mass, whole records, fork boundaries, and a practical output allowance.
- A valid roll leaves memory at roughly 60% of budget or less.
- Retained records remain byte-exact.
- Generation publication precedes atomic state-pointer publication.
- Prompt snapshots change only at established activation boundaries.
- Model or storage failure leaves Pi usable and preserves raw history for rebuild.
- v1 memory remains read-only until the active session is rebuilt explicitly.
- Forks inherit only branch-valid active records and never replay parent JSONL automatically.
- Spawned children and `--no-session` runs create no refinement memory.
