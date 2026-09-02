# Pi Session Refinement

Pi Session Refinement keeps a durable memory beside each saved Pi conversation. It turns completed stretches of a long session into chronological checkpoints, then rolls older checkpoints into a compact current-state record before memory becomes another context problem.

The extension does not replace Pi's transcript or compaction summary. Raw session JSONL remains the source of truth. Refinement memory is a smaller continuation aid that Pi loads into later prompts.

![How v2 checkpoints, consolidates, and publishes session memory](docs/session-flow.svg)

## Why it exists

Long Pi sessions eventually cross compaction boundaries. Pi can continue from its compaction summary, but a single summary must serve the immediate next turn. It is not designed to preserve every correction, decision, evidence limit, or unresolved thread accumulated across a project.

Session Refinement maintains that longer continuity separately. The examiner records what changed since the previous cursor. The consolidator later rewrites only the oldest eligible memory records, leaving newer checkpoints byte-for-byte intact.

## How v2 works

### Checkpoint

After enough time and root tool activity, or before context compaction, an isolated examiner receives the current memory and one unprocessed transcript interval. It submits a checkpoint candidate. Host code adds source cursors and validates the complete staged memory before anything is published.

### Roll

When the staged candidate reaches 80% of `memoryBudgetTokens`, the host selects an oldest legal whole-record range. A separate isolated consolidator sees only that range. It produces one continuity record at the range cutoff; it never sees or rewrites the retained suffix.

The finished memory must fit at roughly 60% of the configured budget or less. Empty, malformed, non-compressing, or oversized output is rejected.

### Publish and activate

The extension writes and hashes a new immutable generation, then atomically updates `state.json` to point at it. A crash before the pointer update leaves the old generation authoritative. Failed and superseded generations are cleanup residue, not a history archive.

A background checkpoint does not mutate the prompt already in flight. The full new generation becomes active at the next fresh prompt, resume, fork bootstrap, compaction, or rebuild. If Pi continues immediately after compaction, only the exact new checkpoint is supplied as a temporary additive update. A consolidation replacement never masquerades as an append to stale system memory.

[Read the diagram notes and behavior checklist](docs/session-flow.md).

## Where it runs

The extension runs in saved, interactive root sessions. It does not activate in spawned children, `--no-session` processes, or idle sessions that never submit a prompt.

It adds no model-facing memory tool to the root conversation. Refinement and consolidation happen in isolated SDK sessions with one submission tool each.

## Add it to Pi

Give this repository URL to your coding agent:

`https://github.com/TobyNoSkillSon/pi-session-refinement`

Ask it to inspect your Pi profile, add the package, and keep runtime configuration outside the repository. The public package does not choose a model provider.

Pi Session Refinement v2 requires Node.js 22.19 or newer and Pi `>=0.83.0 <1.0.0`.

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
  "consolidator": {
    "model": "current",
    "thinking": "high"
  },
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

Both model fields accept `current`, an exact `provider/model-id`, or a unique available bare model ID. See [configuration](docs/configuration.md) for field behavior and fallback rules.

## Upgrading v1 sessions

v2 never migrates old sessions in the background. Valid v1 memory remains injected read-only so the session can continue without surprise model calls or state changes.

Run the only maintenance command when you want to convert the active session:

```text
/session-refinement-rebuild
```

A rebuild reads the authorized branch in chronological segments and stages the complete v2 result separately. Root sessions start at branch beginning. Forks preserve their inherited baseline and rebuild only after the immutable fork floor. Active memory changes only after every segment succeeds. Escape cancels without replacing the old memory.

The same command can create memory for a historical session that has none.

## Fork behavior

A fork inherits only the active v2 record prefix whose source cursors exist at the selected fork point. It records that point as an immutable floor and processes new child history after it. The child never replays parent JSONL automatically.

A fork created before the parent's rolling base may inherit little or no memory. That trade keeps forks cheap and prevents hidden parent-history reconstruction.

## Failure and recovery

Refinement is fail-open. A failed examiner leaves the transcript cursor unchanged, so raw JSONL can regenerate the interval. The configured model is tried up to `maxAttempts`; the current interactive model is used as fallback when it is different and available.

If consolidation cannot produce valid headroom, automatic memory writes pause for that session and Pi asks for `/session-refinement-rebuild`. Conversation and context compaction remain usable. Corrupt or inconsistent state follows the same rebuild path.

## Runtime files

```text
${PI_CODING_AGENT_DIR}/pi-session-refinement/
├── config.json
└── sessions/
    └── <session-id>/
        ├── state.json
        └── generations/
            └── memory-<generation-id>.md
```

`state.json` names and hashes the authoritative generation. `memory.md` exists only for read-only v1 compatibility and is removed after a successful rebuild. Runtime files use private permissions and stay outside the package repository.

## Privacy

The repository ships code, prompts, examples, and documentation. It contains no runtime memory or session history. Each isolated model operation receives only the material required for that operation; the consolidator never receives the retained suffix.

## Documentation

- [Architecture](docs/architecture.md)
- [Session lifecycle](docs/lifecycle.md)
- [Configuration](docs/configuration.md)
- [Memory format](docs/memory-format.md)
- [Diagram source](docs/session-flow.mmd)
- [Diagram notes and behavior checklist](docs/session-flow.md)

## Development

```bash
npm install
npm run check
```

## License

MIT
