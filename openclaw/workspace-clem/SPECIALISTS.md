# SPECIALISTS.md — Clem's internal team

Clem presents to Omar (and to the CRREM team, partners, ASPs, journalists, regulators) as one agent. Behind that single face she runs a panel of internal specialists. The user always sees Clem; she invokes whichever specialist she needs and synthesizes a brand-compliant answer.

This file is the catalogue. It is the source of truth for what Clem can do today, what is stubbed for the next wave, and which permission tier each specialist defaults to.

Code-level catalogue lives at `packages/clem-specialists/src/registry.ts` in the bridge-ai repo.

## Built today

| Specialist    | Description                                                                                                                                 | Reads                                    | Default tier (internal / external) |
|---------------|---------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------|------------------------------------|
| methodology   | V2.04 evolution, pathway analysis, regulatory landscape, ASP cohort, License Partners. Reads CRREM Vault and SharePoint via the M365 surface. | CRREM Vault, Clem's Desk, SharePoint     | delegated / advisory               |
| brand         | Lints every other specialist's output. American English, no "stranded", contrastive negation rewrite, named-owner replacement, ASP and LP spell-out externally. | code-resident rules + workspace BRAND.md | autonomous / autonomous            |
| comms         | Press releases, podcast invites, speaking requests, journalist messages, stakeholder letters. Drafts in CRREM voice. Queues every public-facing draft for Omar's approval. | inbound intake events, brand profile     | delegated / advisory               |
| events        | London Climate Week, Accredited Service Provider cohort kickoff, sector roundtables. Per-event sub-pages: dress code, dietary, hotel, flights, transit, RSVP, follow-up. | calendar surface, Clem's Desk events     | delegated / advisory               |
| data          | Read interface to CRREM pathway data — country and sector and year. Exposes `lookup(country, sector, year)`. | CRREM Vault data tables, in-memory anchors | delegated / advisory               |

## Stubbed for later waves

Listed so Clem can call any of these names without crashing. Each returns a low-confidence stub response until built.

| Specialist | What it will own                                                                  |
|------------|-----------------------------------------------------------------------------------|
| partners   | License Partner relationships, partner roadmap, license renewals.                 |
| regulatory | EPBD, CSRD, SFDR, EU Taxonomy, country disclosure rules — active map.             |
| asp-cohort | ASP onboarding cadence, vetting, peer-review process, cohort calendar.            |
| deck       | Slide library, talk drafts, audience-fit assembly, post-talk archive.             |
| site       | crrem.org content + design tickets. Drafts only. Deploys via the crrem CLI.       |
| finance    | CRREM operating numbers, license revenue, ASP cohort economics.                   |
| board      | Board updates, agenda packets, action-tracking.                                   |

## Permission tier glossary

- **autonomous** — Clem may act without prompting; result is logged.
- **delegated** — Clem may act; result is reviewed on a regular cadence (weekly digest).
- **advisory** — Clem may draft and propose; Omar approves each instance before action.

## Action threshold pattern

Per-specialist, per-action category. Defaults live in `THRESHOLDS.md`. The synthesizer enforces them at response-assembly time. The default policy when a category is ambiguous: advisory.

## Brand-lint as cross-cutting filter

Every specialist runs its own draft through the brand specialist's lint engine before returning it. The synthesizer runs it again at composition time, belt-and-suspenders. Hard rules are encoded in code, not in prose — a regression test in `tests/brand-lint.test.ts` covers each rule.

## Calling pattern (for other agents and the CLI)

```ts
import { getSpecialist, synthesize } from "@bridge/clem-specialists";

const methodology = getSpecialist("methodology");
const data = getSpecialist("data");

const responses = [
  await methodology.query("What's the pathway curve for office in Belgium?", {
    principal: "crrem",
    audience: "team-internal",
  }),
  await data.query("Office pathway for Belgium 2030?", {
    principal: "crrem",
    audience: "team-internal",
  }),
];

const out = synthesize({
  question: "Office pathway for Belgium 2030?",
  context: { principal: "crrem", audience: "team-internal" },
  responses,
});
```

The synthesizer composes a single Clem-voiced response, runs final brand-lint, and decides whether the result is `queued_for_omar` based on audience, register, and any specialist's `requires_omar_approval` flag.

## Spokesperson mode

A distinct register for inbound press, podcast invites, speaking requests, journalist DMs. Tighter language. ALL public-facing drafts queue for Omar's approval. See `SPOKESPERSON.md`.

## Department-tier scaffold

When CRREM upgrades to the org-department plan tier, today's internal specialists become independent agents (Clem-Methodology, Clem-Comms, Clem-Data, Clem-Events). See `DEPARTMENT-TIER.md`.

## Audit

Every specialist invocation logs through `@bridge/audit`. Fallback log at `/Users/omar/.bridge/audit/clem-specialists.jsonl` if the primary substrate is unavailable. Fields per the canonical audit schema (`agent: "clem"`, `principal: "crrem"`).

## How to add a new specialist

1. Add a folder under `packages/clem-specialists/src/<name>/`.
2. Export a `create<Name>Specialist()` factory implementing the `ClemSpecialist` interface from `src/specialist.ts`.
3. Register it in `src/registry.ts` under `BUILT_SPECIALISTS`.
4. Add an entry here, an entry in `THRESHOLDS.md`, and a test file in `tests/`.
5. If the specialist takes public-facing actions, also wire its spokesperson register notes in `SPOKESPERSON.md`.
