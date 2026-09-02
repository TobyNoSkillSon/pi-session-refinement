# Session flow

The README diagram follows one session from top to bottom. [`session-flow.mmd`](session-flow.mmd) is the Mermaid source; [`session-flow.svg`](session-flow.svg) is the styled GitHub asset.

## Reading the timeline

1. Conversation accumulates in Pi's raw session JSONL.
2. The examiner turns the unprocessed interval into one checkpoint.
3. The host publishes the new checkpoint memory. A later safe prompt boundary loads it.
4. A later interval creates another checkpoint while the staged memory keeps chronological order.
5. When a staged candidate reaches 80% of the configured memory budget, the host chooses the oldest checkpoints it can safely replace together.
6. The consolidator rewrites only those selected old checkpoints. Recent checkpoints remain byte-exact.
7. The next safe prompt uses one consolidated base followed by the exact recent checkpoints. The sequence repeats as the session grows.

Raw JSONL remains complete throughout. It is the rebuild source when derived memory must be recreated.

## Details omitted from the picture

The image leaves transaction mechanics, model fallback, fork boundaries, and the immediate post-compaction update out of the main path. Those rules still apply and are covered in [architecture](architecture.md) and [session lifecycle](lifecycle.md).
