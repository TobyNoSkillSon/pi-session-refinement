# Session flow

The README diagram follows time down the left column. When memory reaches 80%, the path moves right once and continues downward through consolidation.

[`session-flow.mmd`](session-flow.mmd) is the Mermaid source. [`session-flow.svg`](session-flow.svg) is the styled GitHub asset.

## Timeline

1. Conversation creates checkpoint 1.
2. More conversation creates checkpoint 2 and a new staged checkpoint.
3. At 80%, the host selects the oldest replaceable checkpoints.
4. The consolidator turns that old prefix into one compact record.
5. The recent checkpoint stays exact, and later checkpoints append after it.

Raw session JSONL remains complete and can rebuild derived memory. Transaction mechanics, model fallback, fork boundaries, and post-compaction activation are documented in [architecture](architecture.md) and [session lifecycle](lifecycle.md).
