# Pi Session Refinement

Pi Session Refinement gives each saved Pi conversation its own chronological memory. A configurable refinement model summarizes new stretches of conversation as checkpoints. Pi loads the latest memory after compaction or when the session resumes, while ordinary turns keep using the same prompt snapshot.

The extension runs only in persistent interactive root sessions. Spawned children and `--no-session` runs cannot create refinement memory.

## What happens during a session

While you work, a background checkpoint becomes eligible only when the time threshold has passed and the root session has produced the configured number of tool results. The refinement model reads the current memory and the conversation since the previous checkpoint, then appends one block to `memory.md`. Refinement makes extra model calls, but it does not interrupt your conversation.

`memory.md` can advance while the current prompt keeps using its existing memory snapshot. Pi uses the new snapshot after compaction, when you resume or fork a session, or after a successful rebuild. If Pi continues the same run immediately after compaction, the extension supplies the newly appended checkpoint on every model call until the next fresh prompt carries the full snapshot. If a short session ends before its first checkpoint, the extension can create one when the session resumes.

![Pi Session Refinement across two compaction cycles](docs/session-flow.svg)

[View the behavior checklist](docs/session-flow-ascii.md).

## Features

- Separate `memory.md` for each session, preserved across resume and compaction
- Configurable examiner model and thinking level, resolved through Pi's model registry
- Background checkpoints gated by both elapsed time and root tool activity
- Early compaction at a configurable context percentage, with refinement completed before unprocessed material leaves active context
- Fork inheritance restricted to checkpoints on the forked branch
- Chronological reconstruction through `/session-refinement-rebuild`
- Non-modal animated progress above the editor during refinement and reconstruction
- Configurable examiner attempts (three by default), automatic fallback to the current session model when available, and persistent warnings
- Configurable 32K-token default budget with no automatic deletion
- Examiner usage records kept outside model context for token and cost accounting

## Use it

Give this repository URL to your coding agent:

`https://github.com/TobyNoSkillSon/pi-session-refinement`

Tell it you want Pi Session Refinement. It can inspect your Pi setup and take it from there.

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

The refinement model receives the existing memory, one unprocessed chronological interval, and runtime metadata. Its only tool is `append_memory`. The extension supplies the interval boundaries and timestamp, then commits the complete block atomically.

Normal checkpoints are append-only. Later checkpoints must explicitly supersede outdated claims; the extension never silently deletes history.

## Reconstruction

Run this command to rebuild a session's memory from its recorded history:

```text
/session-refinement-rebuild
```

The command processes the current branch in chronological segments divided by recorded compactions. An animated indicator reports segment, model, attempt, fallback, and commit progress above the editor. Press Escape to cancel. Submitted prompts wait for the rebuild, and active memory changes only after every segment succeeds.

## Failure policy

Refinement errors do not block Pi. Broken state, an unavailable configured model, a required rebuild, or budget overflow produce warnings on later turns. On resume, the extension checks checkpoint metadata and cursor alignment, and verifies that each recorded checkpoint still has a body. A structural mismatch stops refinement and asks for a rebuild instead of appending to damaged memory. The extension retries examiner failures up to the configured limit, then tries the current session model when it is different and available. If every attempt fails, the cursor stays unchanged so a later eligible run can try the same interval again.

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
