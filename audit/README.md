# bridge-cloud-deploy / audit

Cloud-side mirror of the local `@bridge/audit` package. Same schema, same
interface, different transport.

## Where the cloud log lives

Inside the Render container: `/opt/data/audit/audit.jsonl` (mounted volume).

For replication back to the operator's laptop, the cloud entry-point
periodically `gbrain put`s new lines under
`audit/cloud-<hostname>-<UTC>.jsonl`. The operator side merges those into
the canonical `~/.bridge/audit/audit.jsonl` during the next sync.

## API

```js
import { log, recent, withinHours } from './logger.mjs';

log({
  agent: 'beatrix',
  principal: 'omar',
  action_type: 'write',
  surface: 'vault',
  target: 'people/jane.md',
  reasoning_summary: 'Added Jane to the people graph from a chat reference.',
  reversible: true,
  undo_handle: 'u_2026_05_20_a1b2c3',
  result: 'success',
  tier: 'delegated',
  scope: 'vault-write'
});
```

The shape is identical to the TypeScript writer. Node 18+ required.

## Why a separate module

The cloud OpenClaw container is plain Node (no TypeScript build step in
the gateway). Keeping the writer in `.mjs` form with zero deps means the
container starts fast and the audit logger has no failure mode beyond
"disk full" (which is the same as the local one).
