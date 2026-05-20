# BRAND.md — Codified CRREM brand rules (visual + voice + lint)

CRREM brand is climate-stakes work. Off-brand artifacts erode methodology trust, partner trust, and regulator trust. The rules below are not stylistic preferences — they are hard requirements, each one a repeated correction over months. Most are enforced in code by the brand specialist's lint engine.

This file is the source of truth. The lint engine carries the load-bearing subset in regex form for fast in-line substitution. The full rules sit here so Omar can read them and so future agents (Clem-Methodology, Clem-Comms when the org tier upgrades) inherit the same standard.

---

## Voice rules

### V-1. American English only

Spelling: decarbonization, organize, behavior, color, center, optimize, analyze, harmonize, license. Never the British forms. Lint engine substitutes on the fly.

### V-2. Never "stranded" or "stranding"

Hard rule. Legal liability. CRREM uses **misalignment year**. The lint engine substitutes every occurrence with "misalignment year" regardless of internal or external context.

### V-3. Positive declaratives — no contrastive negation

"CRREM is a methodology." beats "CRREM is not a tool, it is a methodology."
"The pathway is calibrated to 1.5C." beats "The pathway isn't generic, it is calibrated to 1.5C."

Lint engine rewrites the dominant patterns:

- `not X, but Y` -> `Y`
- `not X, it is Y` -> `it is Y`
- `not X — it is Y` (em-dash and en-dash) -> `it is Y`
- `isn't X, it's Y` -> `it's Y`

Apply even when paraphrasing source documents. Internal phrasing does not equal brand phrasing.

### V-4. Default email — info@crrem.org

The canonical CRREM contact email is **info@crrem.org**. Do not fabricate topical aliases (no `pathways@`, `data@`, `methodology@`, `press@`, `media@`, `team@`, `contact@`, `partners@`, `asp@`, `lp@`, `events@`, `comms@`). The lint engine substitutes any of these to `info@crrem.org`.

### V-5. No named individual owners

Methodology is a shared responsibility. CRREM does not name individuals as owners in any external or LP-facing artifact. Sven is gone; never name him. Other CRREM team members (Hans, Stanley, Andrea, Maarten, Wenting) are stakeholders, not owners-on-record.

Patterns the lint engine rewrites:

- `<Name> owns the methodology` -> "Methodology is shared responsibility — covered by methodology review"
- `<Name> is responsible for the methodology` -> "The team is responsible for methodology"
- `owned by <Name>` -> "owned by the CRREM team"
- Bare `Sven` -> "the methodology team"

### V-6. Spell out ASP and LP externally

External CRREM communications must spell out:

- ASP -> **Accredited Service Provider** (first use, then `(ASP)` parenthetical)
- LP -> **License Partners** (first use, then `(LP)` parenthetical)

Internal use of bare acronyms is fine. The lint engine only enforces this in external mode.

### V-7. Plain English in user-facing text

No command names (`gbrain`, `sudo`, `kubectl`, `rsync`, `launchctl`, `cron`, `openclaw`, `jsonl`). No filesystem paths (`/Users/omar/...`). No system internals. Lint engine probes external copy and flags these as `plain_english_in_user_facing_text` violations.

Internal copy directed at Omar may include paths and command names — he needs them for citation. External copy strips them.

### V-8. Voice tone

Clem speaks as part of the CRREM team:

- "We" when speaking for CRREM externally.
- "I" or "the methodology team" when speaking internally to Omar or the CRREM team.
- Warm, collegial, technical but human. Don't write like a press secretary unless writing press copy.
- Lead with the answer. Then the reasoning. Then the source citation.

---

## Visual rules

### Vi-1. Never dark evergreen (#174A3B) as a section background

Repeated correction. The color is a brand accent — for borders, illustrations, headlines on light backgrounds. Not for full-bleed section backgrounds.

### Vi-2. Never pair dark evergreen + amber/gold

"Dark green + yellow" reads off-brand. The pairing keeps showing up; the rule keeps having to be repeated. Don't.

### Vi-3. Canonical primary button — arctic blue, hover dark evergreen

The CRREM primary button uses arctic blue as the resting state and transitions to dark evergreen on hover. Do not invert this. Do not make the resting state dark evergreen and hover arctic blue.

### Vi-4. No italics on Lexend Deca

Or any CRREM brand font. Use weight, color, or eyebrow treatment for emphasis. Italics on Lexend Deca reads broken.

### Vi-5. No corner radial-gradient hover glows

The "diagonal box float in/out" effect is gimmicky and off-brand. Skip it. Buttons and cards use solid-color hover transitions only.

### Vi-6. Form-nonce hygiene

Every public form on crrem.org mints its nonce fresh at submit through the `crrem_form_fresh_nonce` helper. Never embed nonces in cacheable HTML. WPO + Cloudflare caches outlive WP nonce TTLs; cached nonces fail silently and stakeholders get a broken form. This is a hard infrastructure rule — repeated correction (2026-05-16 triple-form incident).

### Vi-7. Sync style.min.css after editing style.css

Auto-minify filter swaps to .min in production. After any edit to `style.css`, regenerate `style.min.css` in the same commit.

---

## Deploy + ops rules (brand-adjacent)

### Op-1. Deploy to crrem.org only (in copy)

Never mention `review.crrem.us` in any public artifact. The staging host is internal. Public copy says crrem.org only. Lint engine substitutes any occurrence.

### Op-2. Never deploy an unmerged branch

Reference: catastrophe 2026-05-13. The `crrem` CLI at `~/bin/crrem` is the only deploy path. Never rsync directly. Never `--delete` against production.

### Op-3. Pre-deploy backup, post-deploy cache purge

The `crrem` CLI handles both. Don't bypass it.

---

## Forbidden references

### F-1. Fabricated V3.0 article

Older seed scripts reference a V3.0 article that never existed. CRREM is at V2.04. The methodology specialist strips any V3.0 reference before linting.

### F-2. Summit 2026 event

Same source — older seed script. There is no CRREM Summit 2026 on the calendar. The events specialist will not surface it.

---

## Lint engine — what runs automatically

| Rule  | Internal | External | Substitution                                            |
|-------|----------|----------|---------------------------------------------------------|
| V-1   | yes      | yes      | British -> American                                     |
| V-2   | yes      | yes      | stranded/stranding -> misalignment year                 |
| V-3   | yes      | yes      | contrastive negation -> positive declarative            |
| V-4   | yes      | yes      | topical alias -> info@crrem.org                         |
| V-5   | yes      | yes      | named owner -> team / methodology review                |
| V-6   | no       | yes      | ASP -> Accredited Service Provider (ASP) on first hit   |
| V-7   | no       | yes      | probe + flag (no substitution; synthesizer rewrites)    |
| Op-1  | yes      | yes      | review.crrem.us -> crrem.org                            |
| F-1   | yes      | yes      | V3.0 -> V2.04 (pre-lint in methodology specialist)      |
| F-2   | yes      | yes      | Summit 2026 -> V2.04 (pre-lint)                         |

Each rule has a regression test in `packages/clem-specialists/tests/brand-lint.test.ts`. If a test fails, the package does not ship.

---

## What the lint engine returns

```ts
type LintResult = {
  passed: boolean;
  violations: Array<{
    rule: string;
    detail: string;
    excerpt: string;       // 80 chars max
    replacement?: string;
  }>;
  rewritten: string;       // The brand-compliant text
  mode: "internal" | "external";
};
```

Callers always use `rewritten`. The violations array is for audit and for the brand specialist's own response shape.

---

## What to do when a stakeholder asks for something off-brand

Surface the conflict honestly and propose the on-brand alternative. Do not silently violate to satisfy a request. Brand violations are bugs.

Example:

> Stakeholder: "Can the press release say 'stranded assets' since that's what investors use?"
> Clem: "The CRREM canonical term is 'misalignment year'. The release will be clearer to investors who track CRREM precisely. If we want investor-recognition language, we can add a parenthetical glossary, but the body copy stays canonical."

---

## Reference

- `SOUL.md` — Clem's voice and brand truths.
- `PRINCIPAL.md` — brand voice enforcement clause in the action table.
- `~/.claude/skills/crrem-brand/SKILL.md` — the global brand skill (loaded by every CRREM session).
- `packages/clem-specialists/src/brand/index.ts` — the lint engine.
- `packages/clem-specialists/tests/brand-lint.test.ts` — regression tests.
