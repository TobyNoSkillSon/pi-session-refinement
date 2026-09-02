# Session flow illustration

The README embeds [`session-flow.svg`](session-flow.svg). It shows two cycles:

1. Chat and tool activity make a checkpoint eligible.
2. The examiner submits a checkpoint candidate. The host publishes it below the rolling threshold.
3. Compaction activates the newer memory while raw JSONL remains canonical.
4. More chat produces another candidate. If that candidate reaches 80% of the memory budget, the host consolidates an oldest legal whole-record range before publication.
5. The second compaction activates the rolled memory. Immediate continuation receives only the exact new checkpoint as an additive update; the consolidation replacement waits for a fresh prompt.

## Behavior checklist

- Pi checks normal background eligibility after each settled root run. Both elapsed time and root `tool_result` count must pass.
- The examiner receives rendered memory, one new chronological interval, and runtime metadata. Its only tool submits one checkpoint candidate.
- Refinement and consolidation use isolated sessions. Neither adds tools to the interactive conversation.
- Candidate publication is transactional. Before a successful write, active memory and `lastProcessedEntryId` remain unchanged.
- At exactly 80% of `memoryBudgetTokens`, the host selects the oldest legal contiguous whole-record range whose rendered token mass is closest to half the configured budget.
- The consolidator receives only that prefix. It creates continuity at the prefix cutoff and silently checks consistency and deletion before submission.
- Host checks reject empty, malformed, non-compressing, over-budget, and insufficient-headroom output. Valid output should leave memory at roughly 60% of budget or less.
- Consolidation metadata records kind, generation, source coverage, underlying source-record count, creation time, and cutoff chronology. Later rolls can include earlier consolidation records.
- Newer retained records remain byte-exact.
- Only one memory operation runs at a time. Background work does not block ordinary conversation.
- A published background checkpoint stays outside the active prompt snapshot until compaction or resume.
- Immediate post-compaction continuation receives the exact new checkpoint as a non-persistent additive update on every provider call. A consolidation body never uses that bridge as a lower-priority replacement.
- A fresh prompt receives the complete active memory once and resets the bridge.
- Pre-compaction refinement waits for active work and attempts to preserve material that would leave context. Pi may still compact after a failure or cancellation.
- Consolidation failure pauses automatic refinement and asks for `/session-refinement-rebuild`; early context compaction remains available.
- Valid v1 memory stays injected read-only. Historical sessions without memory also require the manual command. The extension scans no siblings and runs no mass migration.
- Root rebuild starts at branch beginning. Rebuild stages every segment, applies the same rolling rule, and publishes only after all segments succeed.
- A v2 fork inherits only the active record prefix valid at its selected point. It records that point as an immutable floor and starts child processing after it. A later rebuild preserves inherited records and reconstructs only the fork-local tail.
- Forks never replay parent JSONL automatically. A historical fork before the rolling base may inherit nothing.
- Raw Pi JSONL remains canonical. The extension may append model-usage custom entries, which stay outside model context.
- Runtime memory exists only for enabled persistent root sessions.
