# Memory format

Each authoritative v2 generation is chronological Markdown with hidden host metadata. A typical rolled file looks like this:

```markdown
# Session Memory

Read records chronologically. A consolidation replaces an older prefix and states continuity at its recorded cutoff.

---

## Consolidated memory — cutoff 2026-08-19T14:10:00.000Z

### Current-state corrections

- Current truth as of the cutoff.

---

## Memory checkpoint — 2026-08-19T15:25:00.000Z

### Learned information and decisions

- A later durable fact or decision.
```

The stored file also contains a v2 marker and one JSON metadata comment before each record. Prompt rendering strips those comments.

## Checkpoint records

A checkpoint records one examiner result and carries:

- `kind: "checkpoint"`
- `generation: 0`
- first and last source-entry cursors
- `sourceRecordCount: 1`
- creation and cutoff timestamps
- trigger

Checkpoint prose has no item IDs, priorities, or confidence schema. A later checkpoint states consequential corrections explicitly rather than editing historical prose.

## Consolidation records

A consolidation replaces one legal contiguous whole-record range. Its generation is one above the highest generation in that range. Its source cursor and cutoff come from the newest replaced record; `sourceRecordCount` is the sum of the underlying counts.

Root consolidation begins at the oldest record. Fork consolidation may instead begin at the first local record, but no selected range can cross the inherited/local boundary. Records outside the range remain byte-exact.

## State agreement

`state.json` repeats the ordered record metadata, keeps `lastProcessedEntryId` as the newest processed transcript cursor, and names one root-relative generation path with its SHA-256. Paths are confined to the session's `generations/` directory.

The extension accepts a generation only when its hash, canonical document, records, chronology, fork count, and cursor agree with state. Untracked prose or invalid metadata makes the session rebuild-only.

The extension recognizes v1 `memory.md` only after validating its checkpoints, bodies, count, and terminal cursor. Valid v1 files remain read-only until explicit rebuild. Invalid legacy prose is not injected.
