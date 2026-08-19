# Pi Session Refinement

Pi Session Refinement gives each persistent Pi conversation a chronological memory. A configurable examiner turns new conversation intervals into checkpoints. Pi restores them on resume and keeps injected memory stable between activation points so prompt caches remain reusable.

The extension runs only in persistent interactive root sessions. Spawned children and `--no-session` runs cannot create refinement memory.

## Features

- Separate `memory.md` for each session, preserved across resume and compaction
- Configurable examiner model and thinking level, resolved through Pi's model registry
- Background checkpoints gated by both elapsed time and root tool activity
- Early compaction at a configurable context percentage, with awaited examination before unprocessed material is discarded
- Fork inheritance restricted to checkpoints on the forked branch
- Chronological reconstruction through `/session-refinement-rebuild`
- Three examiner attempts, optional fallback to the current session model, and persistent warnings
- Configurable 32K-token default budget with no automatic deletion
- Non-context usage records for external accounting

## Install

Install directly from GitHub:

```bash
pi install git:github.com/TobyNoSkillSon/pi-session-refinement
```

Or install a local checkout:

```bash
pi install /path/to/pi-session-refinement
```

## Configuration

Runtime configuration belongs to the active Pi profile:

```text
${PI_CODING_AGENT_DIR}/pi-session-refinement/config.json
```

All fields are optional:

```json
{
  "enabled": true,
  "model": "current",
  "thinking": "high",
  "memoryBudgetTokens": 32000,
  "triggers": {
    "contextPercent": 80,
    "elapsedMinutes": 40,
    "minimumToolCalls": 25
  },
  "runOnManualCompaction": true,
  "maxAttempts": 3
}
```

`model` accepts `current`, an exact `provider/model-id`, or a unique available bare model ID. The package does not select a provider for you. See [configuration](docs/configuration.md) for trigger and fallback details.

## Runtime files

```text
${PI_CODING_AGENT_DIR}/pi-session-refinement/
├── config.json
└── sessions/
    └── <session-id>/
        ├── memory.md
        ├── pending.md
        └── state.json
```

These files stay outside the installed package and repository.

## Memory format

The examiner receives the existing memory, one new chronological interval, runtime metadata, and the source-entry range. Its only tool is `append_memory`. The extension owns checkpoint boundaries and timestamps, then commits the complete block atomically.

Normal checkpoints are append-only. Later checkpoints must explicitly supersede outdated claims; the extension never silently deletes history.

## Reconstruction

Run this command for a session that predates installation or needs a clean historical rebuild:

```text
/session-refinement-rebuild
```

The command processes the current branch in chronological segments divided by recorded compactions. It replaces active memory only after every segment succeeds.

## Failure policy

Refinement errors do not block Pi. Persistent problems produce warnings on each user turn. The extension retries up to the configured limit, falls back to a different current-session model when available, and otherwise skips the failed interval.

If a checkpoint exceeds the memory budget, the extension saves it to `pending.md` and leaves active memory unchanged.

## Privacy

The repository contains no credentials, personal paths, or session data. Runtime memory uses private file permissions. The examiner sees only the persistent session it is refining.

## Development

```bash
npm install
npm run check
```

## License

MIT
