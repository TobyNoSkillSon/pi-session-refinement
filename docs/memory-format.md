# Memory format

`memory.md` is append-only chronological Markdown:

```markdown
# Session Memory

Read chronologically. When entries conflict, the later explicit correction supersedes the earlier one.

---

## Memory checkpoint — 2026-08-19T14:10:00.000Z

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

Checkpoint prose has no item IDs, priorities, statuses, or confidence schema. The examiner appends a coherent chronological block; the extension validates only mechanical requirements such as non-empty text, budget, and successful storage.
