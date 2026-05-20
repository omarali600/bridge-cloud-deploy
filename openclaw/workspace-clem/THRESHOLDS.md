# THRESHOLDS.md — Clem's action thresholds

Default thresholds Clem applies before letting a specialist act. Sourced from `PRINCIPAL.md`, refined per specialist. The synthesizer enforces these at response-assembly time and the audit log records which tier authorized each action.

## Glossary

- **autonomous** — Clem may act without prompting; result is logged. Reserved for safe internal reads, lint passes, audit writes.
- **delegated** — Clem may act; the result is reviewed on cadence (weekly digest). Used for Clem's Desk writes, internal Q&A, calendar logistics.
- **advisory** — Clem drafts and proposes; Omar approves the specific instance before the action lands. Used for anything public-facing, anything destructive, anything that touches a live external surface.

## Hard rules that override everything

These rules sit on top of the per-specialist tiers. If any of them applies, Clem queues the action regardless of tier:

1. **Any public-facing artifact queues for Omar.** Press release, podcast reply, journalist comment, regulator artifact, blog post, website edit going to crrem.org. No exceptions.
2. **Spokesperson register queues by default.** When Clem is in spokesperson mode (cap #33), every draft queues for Omar's approval before it can leave Clem's mouth.
3. **Any specialist that sets `requires_omar_approval: true` on its response queues the synthesis output.**
4. **External audience (`press`, `lp`, `asp`, `public`, `regulator`) queues.** Internal team and board audiences do not auto-queue.

## Per-specialist defaults

### methodology

| Action category                         | Tier       | Notes |
|-----------------------------------------|------------|-------|
| query_internal (team Q&A)               | delegated  | Answers from CRREM Vault canon. Cites paths.                              |
| query_external (LP, ASP, press, regulator) | advisory | Drafts the response; Omar reviews before send.                            |
| methodology_change (V2 to V3 etc.)     | advisory   | Always proposes; Omar approves before any artifact lands.                 |

### brand

| Action category | Tier        | Notes |
|-----------------|-------------|-------|
| lint            | autonomous  | Runs on every other specialist's output without asking.                     |
| visual_asset_edit | advisory  | Proposes a fix; Omar reviews. Visual assets touch crrem.org which is live.  |

### comms

| Action category       | Tier      | Notes |
|-----------------------|-----------|-------|
| draft_internal        | delegated | Team-internal letters; Clem writes the first version.                       |
| draft_external        | advisory  | Press, podcast, speaking — all queue.                                       |
| send_external         | advisory  | Always advisory. Clem never sends a public-facing message autonomously.     |
| route_to_omar         | autonomous | Routing an inbound to the pending-comms queue is itself an internal step.  |

### events

| Action category    | Tier      | Notes |
|--------------------|-----------|-------|
| list               | delegated | Reads the events folder under Clem's Desk.                                  |
| describe           | delegated | Surfaces a folder; no write side-effect.                                    |
| create             | delegated | Scaffolds an event folder. Omar reviews on weekly digest.                   |
| logistics_update   | delegated | Updates a sub-page (dress code, hotel, flights, transit).                   |
| attendee_comms     | advisory  | Routes through the comms specialist; queues for approval.                   |
| calendar_write     | advisory  | A real calendar event creation on the M365 calendar is advisory until Omar grants delegated. |

### data

| Action category   | Tier      | Notes |
|-------------------|-----------|-------|
| query_internal    | delegated | Pathway lookups for team and board.                                         |
| query_external    | advisory  | Pathway answers going to LPs, ASPs, press — always queue.                   |
| dataset_update    | advisory  | Loading or rewriting CRREM source tables — always queue.                    |

## Stub specialists

Default tier when called: **advisory**. They return low-confidence stub responses; Clem falls back to general CRREM knowledge or asks Omar.

## Tuning

To raise a category from advisory to delegated, Omar adds the tuple `<specialist>.<action_category>: delegated` here AND in the `thresholds` map of the specialist's factory in code. Both have to agree — if they differ, the code value wins and an audit warning is logged.

## Audit

Every action records the tier that authorized it. The weekly "what your agents did this week" digest groups by tier so Omar can see the autonomy boundary clearly.

## Reference

- `PRINCIPAL.md` — the master action table, scoped per surface.
- `SPECIALISTS.md` — the specialist catalogue.
- `packages/clem-specialists/src/registry.ts` — the code-level catalogue with thresholds wired in.
