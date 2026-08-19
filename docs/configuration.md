# Configuration

Configuration path:

```text
${PI_CODING_AGENT_DIR}/pi-session-refinement/config.json
```

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Enable refinement for persistent interactive sessions. |
| `model` | `current` | Examiner model: `current`, exact `provider/model-id`, or unique available model ID. |
| `thinking` | `high` | Examiner thinking level. Pi clamps unsupported levels to model capability. |
| `memoryBudgetTokens` | `32000` | Approximate injected-memory budget. Exceeding it creates `pending.md` and pauses refinement. |
| `triggers.contextPercent` | `80` | Context percentage at which the extension requests early compaction. |
| `triggers.elapsedMinutes` | `40` | Minimum elapsed time for a background checkpoint. |
| `triggers.minimumToolCalls` | `25` | Minimum root tool results for the same background checkpoint. |
| `runOnManualCompaction` | `true` | Examine unprocessed material before manual compaction. |
| `maxAttempts` | `3` | Total examiner attempts per model, including the first. |

The time checkpoint requires both elapsed time and tool activity. The context trigger is independent.

## Model fallback

The configured model is attempted first. After `maxAttempts`, the extension warns and tries the interactive session model when it differs. A missing configured model creates a persistent warning on each user turn until configuration is fixed. If fallback also fails, only the current interval is skipped.

## Changing configuration

There is intentionally no model-facing settings tool. Edit `config.json` directly or ask the interactive Pi agent to change it. Available models can be inspected with Pi's normal model listing.
