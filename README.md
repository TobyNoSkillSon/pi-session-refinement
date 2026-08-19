# Pi Session Refinement

A Pi extension for chronological, session-local refinement memory in long-running conversations.

Pi Session Refinement observes a persistent interactive session, asks a configurable Pi model to append durable chronological checkpoints, reloads those checkpoints on resume, and keeps them stable between compactions for prompt-cache reuse. It does not provide global semantic memory and never activates in spawned children.

## Features

- Session-ID-scoped `memory.md` that survives close, resume, and repeated compaction
- Configurable examiner model and thinking level resolved from Pi's available models
- Background checkpoints after elapsed time **and** root tool activity
- Configurable context-percentage trigger for early compaction
- Awaited examination before manual or automatic compaction
- Stable system-prompt injection between activation points
- Fork inheritance limited to checkpoints on the forked branch
- Historical reconstruction with `/session-refinement-rebuild`
- Three total examiner attempts, current-session-model fallback, and persistent warnings
- Configurable 32K-token default memory budget with no automatic deletion
- Non-context custom usage entries for external accounting

## Install

From a local checkout:

```bash
pi install /path/to/PiSessionRefinement
```

Or add the package path to Pi's `packages` setting.

## Configuration

Runtime configuration lives under the active Pi profile:

```text
${PI_CODING_AGENT_DIR}/pi-session-refinement/config.json
```

Every field is optional:

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

`model` accepts `current`, an exact `provider/model-id`, or a unique available bare model ID. The repository does not hardcode a provider. See [configuration](docs/configuration.md).

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

Runtime files are outside the package and are never part of this repository.

## Memory format

The examiner receives the existing memory, one new chronological interval, current time, trigger reason, context usage, and source-entry range. It receives only one tool: `append_memory`. The extension supplies checkpoint boundaries and timestamps and atomically commits the complete block.

Later checkpoints supersede conflicting earlier ones. Memory remains append-only until the user asks the interactive root agent to curate it.

## Reconstruction

For a historical session created before installation:

```text
/session-refinement-rebuild
```

The command processes the current branch chronologically between recorded compaction events. Existing memory is replaced only after the complete rebuild succeeds.

## Failure policy

The extension fails open: Pi startup, interaction, and compaction continue if refinement is unavailable. Persistent conditions appear as warnings on each user turn. Transient examiner failures are retried three total times, then fall back to the current session model when different, and finally skip only that interval.

## Privacy

The project contains no credentials, personal paths, or session data. Runtime memory contains conversation-derived information and is stored with private file permissions. The examiner sees only material from the persistent interactive session it is refining.

## Development

```bash
npm install
npm run check
```

## License

MIT
