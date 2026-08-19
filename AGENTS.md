# Project instructions

- Keep this package public and portable: no personal paths, credentials, account details, or Vault-specific assumptions.
- Support the Pi extension API declared by the package development dependency.
- Session refinement is root-only, chronological, append-only, and fail-open.
- Do not add model-facing tools to the interactive Pi session.
- Keep examiner policy in `prompts/examiner.md`, not embedded in TypeScript.
- Prefer the smallest implementation that preserves resume, compaction, fork, warning, and reconstruction semantics.
- Verify with targeted unit tests and one representative integration path; do not multiply equivalent tests.
