# Memory format

`memory.md` is append-only chronological Markdown:

```markdown
# Session Memory

Read chronologically. When entries conflict, the later explicit correction supersedes the earlier one.

---

## Memory checkpoint — 2026-08-19T14:10:00.000Z

### Current-state corrections

Supersedes an earlier status when later evidence changes it.

### Conversation development

...

### Behavioural refinements

...

### Learned information and decisions

...

### Continuing threads

...
```

The extension adds an HTML metadata comment before each checkpoint with source-entry cursors and trigger information. These comments support incremental processing and safe fork inheritance and are stripped before the memory reaches the model.

Checkpoint prose has no item IDs, priorities, or confidence schema. When later evidence changes an earlier claim, an optional `Current-state corrections` section states the explicit replacement while preserving chronological history. The examiner appends a coherent block; the extension validates only mechanical requirements such as non-empty text, budget, and successful storage.
