# Changelog

## 0.2.0 (unreleased)

- Introduce incompatible v2 state and memory records. Existing v1 sessions remain injected read-only until an explicit rebuild; no automatic migration runs.
- Stage checkpoint publication and roll memory at the 80% threshold by consolidating an oldest whole-record prefix selected by rendered token mass.
- Add an isolated, configurable consolidator with immediate retries, current-model fallback, visible prompt policy, deterministic validation, and a 60% headroom target.
- Preserve newer record bytes during a roll and track record kind, generation, source coverage, underlying record count, and cutoff chronology.
- Pause automatic refinement after consolidation failure while keeping Pi and early context compaction available.
- Make rebuild use the same staged rolling path and convert v1 only after every segment succeeds.
- Replace automatic fork reconstruction with cheap v2 prefix inheritance, an immutable fork floor, and fork-local rebuilds.
- Remove overflow side files and their warning policy.
- Keep immediate post-compaction append updates while withholding prefix replacements until a fresh prompt.
- Strengthen public checks against private paths, model configuration, credentials, and session material.
- Reject mathematically feasible but unusable consolidation ranges, persist no-range failures as rebuild-required pauses, clean crash-orphaned generations on startup, and reconcile stale missing-model warnings after configuration repair.
- Confine session identifiers and inherited source spans before reading or publishing fork memory.
- Detect persistent delegated-agent markers explicitly so inherited profile extensions cannot create or update child refinement stores, and defer ordinary baseline publication until the first prompt instead of leaking empty state directories from idle processes.
- Align the declared Node.js floor with Pi 0.83's actual requirement: Node 22.19 or newer.

## 0.1.0

- Initial implementation of chronological session-local refinement memory.
- Configurable examiner model, background and compaction triggers, resume and fork support, reconstruction, budget warnings, and usage records.
