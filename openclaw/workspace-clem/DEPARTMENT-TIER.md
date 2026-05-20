# DEPARTMENT-TIER.md — Clem's department-tier scaffold (cap #32)

How the architecture upgrades when CRREM moves from the org-individual plan tier (one named agent for the company — today's Clem) to the org-department tier (Clem with a leadership team underneath).

Today: methodology, brand, comms, events, data are **internal specialists** Clem calls. There is one Clem-shaped envelope and one set of credentials, one workspace, one audit identity.

Org-department: each of those domains gets promoted to an **independent agent** — Clem-Methodology, Clem-Comms, Clem-Data, Clem-Events. They sit underneath Clem in an explicit org hierarchy. Each has its own workspace, its own keypair, its own audit identity. Clem remains at the top.

This file describes what changes structurally, what stays the same, and how the migration runs without breaking either the existing trust contract or the calls already wired into Bridget and Beatrix.

---

## Plan-tier ladder

From `~/bridge-vault/work/active/bridge/plan-tier-model.md`:

| Tier              | Cost  | Who Clem looks like                                       |
|-------------------|-------|-----------------------------------------------------------|
| Individual        | €     | Beatrix only. (No Clem; this is the personal-only tier.)  |
| **Org-individual**| €€    | **One Clem** with internal specialists. (CRREM today.)    |
| Org-department    | €€€   | Clem + a leadership team. (This file's target state.)     |
| Org-full          | €€€€  | Clem + leadership + every function staffed (finance, legal, partners, board ops). |

CRREM sits at org-individual today. The trigger for the upgrade is operational load — when methodology, comms, data, and events each have enough recurring volume that a single Clem invocation queue becomes the bottleneck, AND Andrea has signed and the team has the budget for the higher tier.

Until then, the code already pretends the upgrade is coming: each internal specialist has its own folder, its own factory, its own threshold map, and its own audit-target identifier. Promotion is a structural rename, not a rewrite.

---

## What changes at the upgrade

### From → to

| Aspect                  | Today (org-individual)                                   | Org-department                                      |
|-------------------------|----------------------------------------------------------|-----------------------------------------------------|
| Number of agents        | 1 (Clem)                                                 | 5 (Clem + 4 department agents)                      |
| Workspaces              | `~/.openclaw/workspace-clem/`                            | `+ workspace-clem-methodology/`, `+ workspace-clem-comms/`, `+ workspace-clem-data/`, `+ workspace-clem-events/` |
| Audit identity          | `agent: clem, principal: crrem`                          | `agent: clem-methodology, principal: crrem` (and so on per agent) |
| Keypairs                | One Ed25519 keypair under `workspace-clem/.openclaw/`    | One per department agent, each signed by the CRREM principal root key |
| Threshold tables        | One THRESHOLDS.md, one set of per-category defaults      | One per department agent. Clem's table delegates to theirs. |
| Brand specialist        | An internal lint engine Clem owns                        | A shared substrate every department agent calls (the lint rules do not duplicate) |
| Spokesperson register   | Clem flips register                                      | Clem-Comms flips register; Clem coordinates above   |
| Synthesizer             | `synthesize()` composes within Clem                       | Cross-agent synthesizer composes across department agents; same shape, more contributors |
| Pending-comms queue     | `/Users/omar/.bridge/clem/pending-comms/`                | `/Users/omar/.bridge/clem-comms/pending/` and so on per agent |
| User-facing surface     | Omar talks to Clem                                       | Omar talks to Clem (still); Clem routes to the right department head |

### What stays the same

- **One face to Omar.** He talks to "Clem". The fact that her methodology question is answered by Clem-Methodology stays under the hood unless he asks who specifically handled it.
- **CRREM principal.** All four new agents declare `principal: crrem`. Information firewalls with Beatrix and other principals are unchanged.
- **Brand voice.** The lint engine is the same. The rules are the same. They sit in a shared package every department agent imports.
- **Audit substrate.** Same `@bridge/audit`. Just more agent IDs in the agent column.
- **Trust contract with Omar.** Default tier policy (advisory for external, delegated for internal) stays. Each department agent inherits the per-category map.

---

## What each department agent owns

### Clem-Methodology

- V2.04 evolution, V2.05 preparation, pathway curve maintenance.
- Regulatory landscape: CSRD, SFDR, EU Taxonomy, EPBD, country disclosure rules.
- ASP cohort knowledge.
- License Partner methodology questions.
- Reads CRREM Vault and SharePoint.
- Default tier: delegated internally, advisory externally.

Workspace: `~/.openclaw/workspace-clem-methodology/`

### Clem-Comms

- Press releases, podcast invites, speaking requests, journalist DMs, stakeholder letters.
- Drafts in CRREM brand voice (calls the shared brand substrate).
- Owns the spokesperson register.
- Queues all public-facing drafts for Omar.

Workspace: `~/.openclaw/workspace-clem-comms/`

### Clem-Data

- Pathway curves by country and sector and year.
- Country benchmarks.
- Sector breakdowns.
- Read interface to CRREM source tables in SharePoint.
- API: `lookup(country, sector, year)`, `availableCountries()`, `availableSectors(country)`.

Workspace: `~/.openclaw/workspace-clem-data/`

### Clem-Events

- Gatherings: London Climate Week, ASP cohort kickoff, sector roundtables, regulator briefings.
- Calendar integration (M365 calendar via the MCP, Google Calendar via Bridget's adapter).
- Per-event sub-pages: dress code, dietary needs, hotel, flights, transit, RSVP, post-event follow-up.

Workspace: `~/.openclaw/workspace-clem-events/`

### Clem (the umbrella)

- Routes Omar's question to the right department head.
- Cross-cuts synthesis when an answer needs more than one department.
- Holds the CRREM-org-level identity and the brand contract.
- Reports up to Omar.

Workspace: `~/.openclaw/workspace-clem/` (unchanged path).

---

## Migration steps (when the trigger fires)

1. **Confirm signal.** Operational load on each domain. Budget signed. Plan-tier upgrade flagged in `bridge-vault/work/active/bridge/plan-tier-model.md`.
2. **Generate per-agent workspaces.** Copy `workspace-clem/` shape into four new directories. Each gets its own IDENTITY.md, SOUL.md (slimmed to the domain), PRINCIPAL.md (same CRREM principal, narrower scope), TOOLS.md, USER.md, HEARTBEAT.md.
3. **Generate per-agent keypairs.** Use the same pattern as the CRREM principal root key bootstrap. Each department agent's directory entry signed by the principal root key.
4. **Move code, not behavior.** The package layout already separates `src/methodology/`, `src/brand/`, `src/comms/`, `src/events/`, `src/data/`. Each becomes its own package: `@bridge/clem-methodology`, `@bridge/clem-comms`, etc. The `@bridge/clem-specialists` package becomes the umbrella router that imports from them.
5. **Update audit identities.** Audit logger's `agent` field shifts from `"clem"` to `"clem-methodology"` (etc.) inside each specialist's call path. Schema unchanged.
6. **Split pending queues.** `/Users/omar/.bridge/clem-comms/pending/`, `/Users/omar/.bridge/clem-events/pending/`. The umbrella reads all of them when Omar asks "what's pending".
7. **Smoke-test trust contract.** Re-run the brand-lint regression suite per package. Verify external requests still queue. Verify spokesperson register still escalates. Verify no department agent can write to another's workspace.
8. **Tell Omar what changed in one paragraph.** That's it. No new surface to learn — Clem still answers his questions. Internally she now delegates to four department agents she trusts.

---

## What does NOT move at the upgrade

- The brand-lint engine. It is shared substrate — one set of rules, one set of regression tests, four agents importing it.
- The audit substrate. Same `@bridge/audit`. Same schema.
- The synthesizer interface. Same `synthesize({ question, context, responses })` shape, just with responses from independent agents.
- Omar's mental model: he still talks to Clem.

---

## Backward compatibility contract

The current `@bridge/clem-specialists` package's public API is the contract:

```ts
import {
  getSpecialist,
  listAllSpecialists,
  synthesize,
  listPendingComms,
  lookup,
  availableCountries,
  availableSectors,
  CURRENT_METHODOLOGY_VERSION,
  lint,
} from "@bridge/clem-specialists";
```

Post-upgrade, the same imports still work. Internally `@bridge/clem-specialists` becomes a thin router that imports from `@bridge/clem-methodology`, `@bridge/clem-comms`, `@bridge/clem-data`, `@bridge/clem-events`. Existing Bridget and Beatrix callers do not need to change.

---

## Information firewalls (multi-agent under one principal)

Even though all four department agents share the CRREM principal, they should not have unbounded cross-access:

- Clem-Methodology cannot read Clem-Comms's pending drafts. (Drafts are private until Omar approves; methodology should not see in-progress comms before they ship.)
- Clem-Comms can ask Clem-Methodology for a quote via the cross-agent consultation protocol (cap #37). The methodology agent answers from canon; that answer is then quoted by comms with attribution to "the CRREM team".
- Clem-Data reads CRREM source tables; nobody else writes to those tables.
- Clem-Events reads calendar; only Clem-Events writes to the events folder.

These firewalls are scope declarations in each `PRINCIPAL.md` and enforced by the audit substrate. Cross-agent reads land in the audit log just like cross-principal reads.

---

## Reference

- `~/bridge-vault/work/active/bridge/plan-tier-model.md` — the plan-tier ladder.
- `~/bridge-vault/work/active/bridge/principal-agent-architecture.md` — the principal-agent contract.
- `~/bridge-vault/work/active/bridge/inter-principal-protocol.md` — handshake between principals; same shape for cross-agent inside one principal.
- `SPECIALISTS.md` — today's catalogue.
- `THRESHOLDS.md` — today's per-specialist thresholds (these become per-department-agent at upgrade).
- `BRAND.md` — voice and visual rules (shared substrate post-upgrade).
- `packages/clem-specialists/` — the code that already separates the specialists by folder, ready to split.
