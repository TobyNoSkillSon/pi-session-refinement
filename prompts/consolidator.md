# Session Memory Prefix Consolidator

Replace one oldest whole-record prefix with one quality-preserving continuity checkpoint. The replacement must describe the session as it stood at the prefix cutoff. The supplied prefix is the complete evidence scope. Later retained records are deliberately absent. Do not guess later events, close work anticipatorily, or import facts from outside the prefix.

Read the prefix chronologically. For each thread, retain the latest supported state at the cutoff. Prefer actual outcomes and current truth over plans, intermediate progress, and obsolete status. A later explicit correction may supersede an earlier claim. Mere lateness, repetition, silence, or a lossy recap does not. Do not let a summary roll stronger recorded evidence backward.

Preserve:

- direct user decisions, permissions, corrections, rejected routes likely to recur, and standing behavior changes;
- completed outcomes, durable project state, and the latest meaningful strategy or objective;
- consequential changes in framing, priorities, or operating assumptions when they should improve future decisions;
- important failures and negative results when their cause, constraint, or prevention lesson still matters;
- genuinely unresolved work, blockers, acceptance conditions, and the evidence or authorization needed next;
- provenance and status boundaries. Keep proposed versus accepted, created versus verified, user-reported versus independently tested, accepted versus displayed, and similar distinctions exact.

Treat the prefix as derived continuity rather than canonical evidence. Preserve its stated provenance and never strengthen a claim. Only a decision recorded as the interactive user's direct decision may remain a user decision. Assistant proposals remain proposals.

Deduplicate aggressively. Give each retained fact one home. Drop obsolete plans, completed todo items, superseded test counts, transient progress, repeated inventories, implementation tours, and failure ceremony. Keep a historical correction only when the corrected misconception, rejected route, or rollback risk remains consequential; otherwise state the resulting current truth directly.

Use dense Markdown bullets and only headings that contain retained material, in this order:

### Current-state corrections
### Conversation development
### Behavioural refinements
### Learned information and decisions
### Continuing threads

`Continuing threads` is a freshly computed set as of the cutoff, not a union of old sections. Do not add an outer title, timestamp, metadata comment, separator, item IDs, priorities, confidence labels, or commentary about consolidation.

Before submitting, silently run a final consistency and deletion check. Verify that every claim is supported within the prefix, no newer fact was guessed, no proposal became authority, no final outcome was rolled back to an intermediate state, and no consequential correction was lost. Delete stale, duplicated, intermediate, and closed detail. Confirm that every continuing thread was still open at the cutoff.

Submit the checkpoint body once through `replace_memory_prefix`. Do not echo it as ordinary text.
