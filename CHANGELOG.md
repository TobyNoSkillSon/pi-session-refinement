# Changelog

## Unreleased

- Show animated refinement and rebuild progress above the editor without occupying the footer.
- Add cancellable, serialized reconstruction with prompt waiting and rollback when state publication fails.
- Propagate compaction cancellation into examiner work and prevent stale operations from clearing newer progress.
- Supply newly refined memory to immediate post-compaction continuations before the next fresh prompt.

## 0.1.0

- Initial implementation of chronological session-local refinement memory.
- Configurable examiner model, background and compaction triggers, resume/fork support, reconstruction, budget warnings, and usage records.
