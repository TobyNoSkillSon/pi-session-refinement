# Session flow illustration

The README embeds [`session-flow.svg`](session-flow.svg). The compact drawing repeats the central lifecycle twice:

1. Chat and tool activity continue down the left track.
2. Refinement appends checkpoint 2, then compaction 1 produces a Pi context containing the abbreviated system prompt, session memory through checkpoint 2, and the first compaction result.
3. `memory.md` persists on the right while more chat accumulates.
4. Refinement appends checkpoint 3, then compaction 2 produces a newer Pi context containing memory through checkpoint 3 and a new compaction result.
5. Before each compaction, the file can be ahead of the memory snapshot in the current prompt.

The checklist below keeps the drawing honest.

## Behavior checklist

- For normal background checkpointing, Pi checks after each settled agent run. Refinement starts only when both the elapsed-time threshold and the configured root `tool_result` count are met.
- The refinement model receives the existing memory without checkpoint metadata, the next unprocessed conversation interval, and runtime metadata. Its only tool is `append_memory`.
- Only one refinement runs at a time. You can keep using the conversation while it runs.
- A successful checkpoint appends to `memory.md` and updates the cursor in `state.json`. It does not change the memory snapshot already in the current prompt.
- The latest memory becomes available after compaction, on resume or fork, and after a successful rebuild. A fresh prompt receives the complete snapshot; an immediate post-compaction continuation receives a temporary update.
- If Pi continues the same run after compaction, a temporary context message supplies the appended checkpoint on every model call. The next fresh prompt carries the complete snapshot and no temporary update.
- When context reaches its configured threshold, the extension requests compaction. By default, manual `/compact` runs the pre-compaction check; configuration can disable it.
- Before compaction, the extension waits for active refinement, then attempts to refine entries that compaction would otherwise remove from active context. This save is best-effort: Pi can continue compacting after a failure or cancellation. Pi then writes its compaction summary and keeps the recent entries.
- On resume, a valid baseline cursor can create the first checkpoint for a session whose memory is still empty. Recorded checkpoints without their matching memory file are treated as broken state. Older sessions with no refinement files receive a rebuild warning instead of automatic reconstruction.
- A fork inherits a checkpoint only when its last entry ID (`throughEntryId`) belongs to the selected branch. If the fork has history but inherits no checkpoints, the extension rebuilds that branch before using its memory.
- For an explicit rebuild, the extension asks for confirmation, then processes the current branch in temporary segments split at recorded compactions. It activates the rebuilt memory only after every segment succeeds. In Pi, pressing Escape cancels before publishing starts. The extension writes `memory.md` before `state.json`; if the state write fails, it attempts to restore the previous memory file.
- If a checkpoint exceeds the memory budget, the extension writes it to `pending.md`, leaves active memory unchanged, and shows a persistent warning.
- The extension never rewrites existing entries in Pi's raw session JSONL. It may append custom usage records; the JSONL remains the canonical session record.
- Refinement memory is not created for disabled configurations, sessions without a persistent file, spawned children, or `--no-session` runs.

