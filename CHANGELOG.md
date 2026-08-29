# Changelog

## Unreleased

- Start timed refinement correctly on inherited forks, preserve retained tool activity across compaction, and process the first checkpoint when an empty-memory session resumes.
- Detect checkpoint metadata, cursor, or body loss before resume; keep provider-context transformation fail-open and strengthen checks against private configuration or credentials entering the public project.
- Prevent stale or disposed extension UI contexts from crashing Pi when asynchronous compaction or background refinement fails.
- Show animated refinement and rebuild progress above the editor without occupying the footer.
- Add cancellable, serialized reconstruction with prompt waiting and rollback when state publication fails.
- Propagate compaction cancellation into examiner work and prevent stale operations from clearing newer progress.
- Supply newly refined memory to immediate post-compaction continuations before the next fresh prompt.

## 0.1.0

- Initial implementation of chronological session-local refinement memory.
- Configurable examiner model, background and compaction triggers, resume/fork support, reconstruction, budget warnings, and usage records.
