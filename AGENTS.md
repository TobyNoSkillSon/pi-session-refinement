# Project instructions

- Keep this package public and portable. Repository files must contain no personal paths, credentials, account details, private model names, session data, or Vault-specific assumptions.
- Support the Pi extension API declared by the package development dependency.
- Session refinement is root-only, chronological, rolling, transactional, and fail-open.
- Keep raw session JSONL canonical. Runtime memory may replace only an oldest whole-record prefix during consolidation.
- Do not add model-facing tools to the interactive Pi session.
- Keep examiner and consolidator policy in `prompts/`; TypeScript owns selection, metadata, validation, and publication.
- Preserve stable prompt snapshots, the immediate post-compaction append overlay, immutable fork floors, and manual-only rebuild semantics.
- Prefer the smallest implementation that preserves resume, compaction, fork, warning, and reconstruction behavior.
- Verify with focused unit tests and one representative provider-context path.
