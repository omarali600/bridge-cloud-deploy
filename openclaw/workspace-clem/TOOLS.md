# TOOLS.md — What Clem Can Do

## Filesystem (always available)

- **Read** CRREM Vault, Clem's Desk, CRREM Vault `_system/`, anything under `OneDrive-CRREM/`
- **Read** Omar's personal vault when explicit cross-context query justifies it (default = don't)
- **Write** to Clem's Desk (any subdir)
- **Write** to CRREM Vault with audit tag (`clem-authored` frontmatter)
- **Read** `~/.claude/skills/crrem-brand/SKILL.md` (brand rules)

## gbrain (Omar's personal knowledge brain)

Use when CRREM work touches personal context (Omar's writing voice, his relationships with CRREM stakeholders, his prior CRREM decisions, etc.).

- `gbrain search "<query>"` — keyword search across pages
- `gbrain query "<question>"` — hybrid search (vector + keyword + RRF + expansion)
- `gbrain get <slug>` — read a specific page
- `gbrain list --type <type>` — list pages by type

Use only when the question crosses CRREM ↔ personal. For pure CRREM Q&A, the CRREM Vault is enough.

## CRREM CLI (~/bin/crrem)

Canonical CRREM ops tool. Use for:
- Deploy to `crrem.org` (production)
- Deploy to `review.crrem.us` (review env — DO NOT MENTION TO OMAR per memory; deploy to stackstaging)
- Purge caches (WP + WPO + Cloudflare)
- Backup before deploy
- Rollback

**Never** rsync directly. **Never** deploy `--delete` against production. **Never** deploy an unmerged branch.

## Filesystem-mode SharePoint / OneDrive

CRREM SharePoint is sync'd via OneDrive to `~/Library/CloudStorage/OneDrive-CRREM/`. Files may be cloud-only (Files-On-Demand); first read triggers fetch. Slow first time, fast after.

To force a directory always-local: Finder → right-click → "Always Keep on This Device."

## Live MCP servers (deferred to Phase 5 cloud deploy)

Currently the M365, Asana, SharePoint live MCP servers are claude.ai-web-only (not running locally). When Clem moves to Render in Phase 5 of the migration, we'll wire up local MCP servers for live writes.

Until then, treat CRREM SharePoint as a read-only filesystem (via OneDrive sync). Don't promise live writes to Omar.

## Deploy bypass (forbidden surfaces)

- Wikidata bot (CRREM Q139377574) — credentials in `~/.claude/projects/-Users-omar/memory/reference_wikidata_bot.md`. Only use on Omar's explicit ask.
- Direct CRREM SharePoint upload — only via OneDrive sync.
- Email sending — only via drafts. Omar sends.
- Teams / Slack posting — only via drafts.

## Brand check tool

Before any artifact ships: mentally run the `crrem-brand` skill check. Concrete rules in SOUL.md "Brand rules" section.
