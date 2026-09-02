# Memory format

A v2 memory generation is chronological Markdown with hidden host metadata:

```markdown
# Session Memory

Read records chronologically. A consolidation replaces an older prefix and states continuity at its recorded cutoff.

---

## Memory checkpoint — 2026-08-19T14:10:00.000Z

### Learned information and decisions

- A durable fact or decision.

---

## Consolidated memory — cutoff 2026-08-19T14:10:00.000Z

### Current-state corrections

- Current truth as of the cutoff.
```

The file also contains a hidden v2 marker and one JSON metadata comment before each record. These comments do not enter the model prompt.

A checkpoint record carries:

- `kind: "checkpoint"`
- `generation: 0`
- first and last source-entry cursors
- `sourceRecordCount: 1`
- creation and cutoff timestamps
- trigger

A consolidation record carries `kind: "consolidation"`. Its generation is one above the highest generation in the replaced prefix. Its source cursor and cutoff come from the newest replaced record, while `sourceRecordCount` is the sum of the prefix's underlying counts.

Checkpoint prose has no item IDs, priorities, or confidence schema. A later checkpoint states consequential corrections explicitly. Consolidation replaces a legal contiguous record range and recomputes continuity at that range's cutoff. In a root session the range begins at the oldest record. In a fork it may instead begin at the first local record, but it may never cross the inherited/local boundary. Every retained byte stays exact.

`state.json` repeats the ordered record metadata, keeps `lastProcessedEntryId` as the newest processed raw transcript cursor, and names one root-relative generation path with its SHA-256. Paths are confined to the session's `generations/` directory. A generation is accepted only when its hash, canonical document, records, chronology, fork count, and cursor all agree with state. Untracked prose and invalid metadata make the session rebuild-only.

The extension recognizes v1 `memory.md` metadata only after exact checkpoint, body, count, and cursor validation. Valid v1 files remain read-only until explicit rebuild. Invalid legacy prose is not injected.
