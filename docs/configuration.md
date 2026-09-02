# Configuration

Configuration path:

```text
${PI_CODING_AGENT_DIR}/pi-session-refinement/config.json
```

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Enable refinement for persistent interactive root sessions. |
| `model` | `current` | Refinement model: `current`, exact `provider/model-id`, or unique available model ID. |
| `thinking` | `high` | Refinement thinking level. Pi clamps unsupported levels to model capability. |
| `consolidator.model` | `current` | Model used by the separate prefix-consolidation operation. |
| `consolidator.thinking` | `high` | Consolidator thinking level. |
| `memoryBudgetTokens` | `32000` | Approximate injected-memory budget. Rolling starts when a staged candidate reaches 80% of this value. |
| `triggers.contextPercent` | `80` | Context percentage at which the extension requests early compaction. |
| `triggers.elapsedMinutes` | `40` | Minimum elapsed time for a background checkpoint. |
| `triggers.minimumToolCalls` | `25` | Minimum root tool results for the same background checkpoint. |
| `runOnManualCompaction` | `true` | Examine unprocessed material before manual compaction. |
| `maxAttempts` | `3` | Attempts per model for both operations, including the first. |

The time checkpoint requires both elapsed time and tool activity. The context trigger is independent and remains active when automatic refinement has paused after a consolidation failure.

## Rolling thresholds

The 80% roll trigger and 60% post-roll target are fixed v2 invariants, not configuration fields. `memoryBudgetTokens` sets the scale for both. Token measurement uses the extension's deterministic rendered-text estimate, so it should be treated as a memory budget rather than a provider billing count.

Selection also reserves a practical allowance for consolidation prose. A mathematically valid range is rejected when metadata and retained memory leave too little room for useful continuity.

## Model fallback

Each operation resolves its configured model independently. After `maxAttempts`, the extension tries the interactive session model when it is different and available. Missing configured models produce a warning. All retries are immediate; the internal SDK session adds no retry layer.

`current` keeps the package provider-neutral and follows the interactive model. A bare model ID must match exactly one available model. Use `provider/model-id` when IDs are ambiguous.

## Changing configuration

There is no model-facing settings tool. Edit `config.json` directly or ask the interactive Pi agent to change it. Pi's normal model listing shows available models.
