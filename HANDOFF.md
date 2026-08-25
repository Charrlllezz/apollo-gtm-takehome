# HANDOFF — Read This First

Apollo GTM Engineer take-home, Charles Ellenburg. **Presentation Thursday 11am,
submit by Thursday ~10am.** This doc is the entry point for a fresh Claude
Code session picking this up on a different device — it has no memory of the
session that built this, so read this whole file before doing anything else.

## What this project is

A signal-to-sequence GTM engine for Vitally (AI-powered Customer Success
platform), reframed as a signal-orchestration layer pitched to Apollo's own
RevOps/GTM Engineering buying committee (the actual panel reviewing this
take-home). Full design lives in `spec/signal-to-sequence-engine.yaml` — read
it top to bottom, it's the single source of truth for the architecture,
every decision made, and why. The companion diagram (3 figures — targeting,
generation handoff, cadence/branching) is published at:

**https://claude.ai/code/artifact/2ba1ea98-4417-47d1-99e0-4f9d5763b743**

## Current status (as of last session)

**Done and verified against real Apollo state, not just self-reported:**
- Sections 1–6 of the assignment fully designed (company/value prop, signals,
  workflow, messaging system, metrics) — see the spec.
- 4 persona sections written into the REAL Apollo Context Center (Playbooks
  product, id `6a8b680792fcb3001857db00`).
- **Generation & Enrollment Service** — `service/` — deployed and live-tested:
  `https://vitally-generation-enrollment-service.apollo-take-home.workers.dev`
- Real sequence created (inactive — safe, nothing sends):
  "Vitally — Champion / Influencer Cadence", id `6a8d4ce53967bf000cff33d8`
- Real custom fields created (contact-level):
  - `Outbound Email 1` (body, textarea) — id `6a8d4b66a650150018f7b500`
  - `Outbound Email 1 - Subject` (string) — id `6a8d5691f6d7c600107a2aa2`
- Confirmed sending mailbox: `6a8745b5490488001c00db94` (Gmail,
  charles@charlesapps.com, default)
- Eric Quanstrom's Email 1 generated for real multiple times, verified
  correct in Apollo (contact id `6a8b5024a8826e0018986bf7`)
- Existing "Apollo Buying Group" list already in the account (6 contacts,
  id `6a8b4f9591a3530020b06b87`) — reuse, don't rebuild

**Bugs found and fixed this session — don't rediscover these:**
1. Original Phase B design routed write-back/enroll through Claude + the
   Apollo MCP connector. This silently failed (200 response, zero tools
   loaded, no error) — root cause never fully resolved. **Fixed by calling
   Apollo's REST API directly** from the Worker instead (`PUT
   /v1/contacts/{id}`, `POST /v1/emailer_campaigns/{id}/add_contact_ids`).
   Don't re-attempt the MCP connector route without a strong reason — see
   `generation_and_enrollment_service.tool_access_history` in the spec for
   the full debugging story.
2. Apollo's MCP server (if you do touch it) authenticates via `x-api-key`,
   NOT `Authorization: Bearer`. An auth-translating proxy exists at
   `/apollo-mcp-proxy` in `service/src/index.ts`, tested working
   independently, currently unused by the main path.
3. The generated email body was originally written with the internal
   "SUBJECT: X\nBODY: Y" parsing wrapper still in it — fixed, body field
   now gets body text only, subject goes to its own field.
4. Plain `\n` collapses in the HTML merge target — paragraphs must be
   joined with `<br>`, not `\n`. Now handled by structured output
   assembly (see #6).
5. `@anthropic-ai/sdk` MUST be >= 0.120.0 for `mcp_toolset`/structured
   output types to work — the originally-installed 0.68.0 silently failed
   to serialize beta fields. `zod` MUST be v4 (`zodOutputFormat` needs
   Zod 4's internal types) — package.json already reflects both.
6. Same-input nondeterminism (identical contact produced meaningfully
   different emails run to run) — fixed via structured outputs
   (`output_config.format` + Zod schema forcing 4 named fields: hook,
   mechanism, proof_point, cta) plus a hardened banned-word list and
   per-field FORM rules (not just function) in `SYSTEM_PROMPT`. See
   `service/src/personas.ts`.

**Known, real, unresolved gap (surfaced late in last session, not yet
fixed):** `/generate` requires a hand-built payload — it does NOT yet fetch
real Apollo account/contact enrichment data itself (the rich
`Business Executive Summary`/`Reasoning` fields already on the Apollo.io
account, id `6a8745ba589af20001f98904`, genuinely improve output quality
when hand-fed in — proven, but not automated). Building that fetch step is
still open.

## Blocked, waiting on Apollo support

`apollo_mixed_people_api_search` and `apollo_mixed_companies_search` return
`API_INACCESSIBLE` citing "not included in your Organization (Trial) plan"
— confirmed 5x including with a fresh master-scoped API key ("even with a
master key" in the error — rules out key scoping). This is a stale
org-level entitlement flag, not a real Trial-plan limitation (UI shows
Custom plan). Charles has a request in with his Apollo point of contact —
**check with him whether it's resolved before assuming these are still
blocked.** If still blocked, the Apollo web UI's own search (not API) works
fine as a workaround for building target lists manually — see the spec's
`execution_notes` for the reasoning why the UI isn't affected by this API
tier restriction.

## Secrets — NOT in this repo, you'll need to re-provide them

`service/.dev.vars` is gitignored and was never pushed. The DEPLOYED Worker
already has its secrets set (via `wrangler secret put`) and keeps running
fine without local `.dev.vars` — you only need it for local `wrangler dev`
testing or if pushing new secrets. If you need it, ask Charles for:
`ANTHROPIC_API_KEY`, `APOLLO_MCP_TOKEN` (Apollo API key), and reconstruct
`MCP_PROXY_SHARED_SECRET`/`WEBHOOK_SHARED_SECRET`/`MCP_PROXY_URL` fresh
(random strings + the deployed URL above — see `service/README.md` setup
section for the exact commands). Do not ask Charles to paste secrets in
plain chat text if avoidable — write straight to a gitignored file.

Also: this new device needs its own `npx wrangler login` (Cloudflare) and
the Apollo MCP connector needs to be connected in Claude Code's settings
(same Apollo account: charles@charlesapps.com) before any `apollo_*` MCP
tool calls will work.

## Remaining work, in priority order

1. **Check status**: did Apollo support resolve the access issue? Ask
   Charles first thing.
2. Quick Apollo UI checks: the mystery Workflow (4 pending
   "Review pending approvals" tasks, cause still unknown) and whether the
   pre-existing custom fields (Messaging Angle, Outreach Urgency,
   Qualification Status, Reasoning, Qualify Contact) are unrelated prior
   work.
3. Targeting: run Stage 1a/1b for real via MCP if access is resolved,
   otherwise build the target list manually in the Apollo UI (exact filter
   values are in `spec/signal-to-sequence-engine.yaml` under
   `stage_1a_foundational_filters` / `stage_1b_signal_overlay`).
4. Generate the remaining committee members' Email 1s through the proven
   `/generate` pipeline: Adam Carr, Alison Mcdonough, Stephanie Ervin, Rene
   Cobar, Samuel Elliott, Henry Mizel, John Choi. Their contact records
   already exist (see `worked_example` in the spec for names/titles/tiers;
   look up current contact IDs via `apollo_contacts_search`, they weren't
   all captured previously).
5. Build the real Stage 5 Workflow in the Apollo UI (trigger conditions →
   webhook → the deployed service URL above) — produces the workflow
   screenshot the assignment requires. Do this after step 2's Workflow
   check, so it doesn't duplicate existing work.
6. Decide the deck format (HTML Artifact was recommended, Gamma was the
   alternative — never finalized) and assemble Sections 1–6 (content is
   locked, safe to build now regardless of what's still pending).
7. Screenshots: the sequence (buildable now), the Workflow (after step 5).
8. Explicit human review and sign-off before anything real sends — create
   reviewed drafts as real Apollo objects, get Charles's explicit approval
   before calling anything that actually sends (`apollo_emailer_campaigns_approve`
   / `apollo_emailer_messages_send_now`). Never skip this gate.
9. Section 7 (optional case study) — needs Charles's own real example,
   nothing to generate here.
10. Final deck assembly and submission to james.thomas@apollo.io.

## Key files

- `spec/signal-to-sequence-engine.yaml` — the full design, source of truth
- `service/` — Generation & Enrollment Service (TypeScript, Cloudflare
  Workers). `service/README.md` has setup/deploy/test commands and the
  full debugging history for the bugs listed above.
- This diagram: https://claude.ai/code/artifact/2ba1ea98-4417-47d1-99e0-4f9d5763b743
