# Vitally × Apollo — Signal-to-Sequence GTM Engine

**Apollo GTM Engineer take-home submission — Charles Ellenburg**

An agentic, signal-triggered outbound system built end-to-end inside Apollo: firmographic and behavioral signal detection → AI-qualified buying-committee pull → persona-specific, guardrailed AI generation (a custom Cloudflare Worker service, not Apollo's built-in text box) → multi-channel sequencing with real branching logic.

**📊 Full interactive presentation: [claude.ai/code/artifact/658414ed-6cdb-4a61-b400-e18f10aac5cd](https://claude.ai/code/artifact/658414ed-6cdb-4a61-b400-e18f10aac5cd)**

That page is the primary deliverable — architecture diagrams, the actual system prompt, real messaging variants, screenshots, and the metrics/optimization narrative. This repo is the code and design spec behind it.

---

## What this is

**Vitally** (a real AI-powered Customer Success platform) is pitched as a signal-orchestration layer to **Apollo's own GTM Engineering / RevOps leadership** — the required buying group for this assignment. The pitch is framed as a signal-triggered *expansion* play rather than a cold-from-zero one: Vitally's own site already lists Apollo.io as a customer story, so the campaign uses Apollo's own hypergrowth (headcount, hiring, a new CFO) as the trigger to reach the newer GTM Engineering org a land-and-expand motion hasn't touched yet.

The required buying group, mapped to four buying-committee personas so each person gets a genuinely different angle rather than one email reworded eight times:

| Persona | Tier | Contacts |
|---|---|---|
| Champion (VP/Head) | 1 | Eric Quanstrom |
| Influencer (Manager/Sr Mgr/Director) | 2 | Stephanie Ervin, Alison McDonough, John Choi |
| Executive Sponsor (CRO/COO/CEO) | 3 | Adam Carr, Henry Mizel |
| Technical Validator (Product/Eng) | 4 | Samuel Elliott, René Cobar |

## Architecture

```
Signal detection (Apollo Workflow)
  → firmographic filter + headcount growth + open roles + new-leader-hire
  → Research with AI (account fit-check + per-person LinkedIn digest)
        ↓
Buying Committee Pull (Apollo Workflow)
  → contact added to signal-qualified list, pre-filtered by persona
  → multi-split branch, one lane per tier
  → Traffic Branch (~33/33/34% send-timing cohorts)
  → Send Webhook
        ↓
Generation & Enrollment Service (this repo, service/)
  → Claude Sonnet 5, structured-output schema, deterministic guardrail
  → account-level de-dup check against siblings already generated
  → writes 4 emails + LinkedIn touches + call-prep notes back to Apollo
  → enrolls the contact in their persona's sequence
        ↓
Apollo Sequence (4 persona-specific cadences)
  → Email 1 → Email 2 (reply-threaded) → LinkedIn → Call → Email 3 (new thread)
  → Email 4 (reply-threaded under Email 3) → real branching on reply/interest/OOO
```

Two Apollo Workflows, four Apollo Sequences, one deployed service. Screenshots of all of it are in [`screenshots/`](./screenshots) and embedded directly in the presentation site above.

## Signals used

1. **Company headcount growth** (10%+ trailing 6-month growth)
2. **Open roles** (GTM Engineering / RevOps titles, specific offices)
3. **New leader hire** (a fresh executive hire is a known re-evaluation window)
4. **Person-level LinkedIn post activity** — the deliberately esoteric one: Research with AI pulls what a person *actually argued*, not just that they posted, and the email's proof point is required to engage with that argument directly

## What the generation service actually does

This is the one part of the pipeline Apollo's own platform can't do natively, so it's a purpose-built service — not a prompt typed into Apollo's AI field.

- **Four AI-generated touches per contact**, each with its own job: a first-touch pitch (Email 1), a short bump follow-up (Email 2), a fresh-thread new-angle email (Email 3), and a genuine "right person for this?" breakup email (Email 4) — the last one used to be a static template shared by everyone; see [Notable engineering decisions](#notable-engineering-decisions-and-bugs-found) below for why that changed.
- **Persona-specific CTAs that name a concrete offer** — a Loom recording for Champion/Influencer/Technical Validator (each scoped to what that function would actually want to see), a one-page benchmark for Executive Sponsors (a number and a document, never a demo).
- **Structured output, not freeform text** — Claude is constrained to a Zod schema (hook / mechanism / proof point / CTA as four named fields), so subject lines and structure don't drift contact to contact.
- **A deterministic code-side guardrail** between generation and write-back — word limits, banned words, banned generic CTAs, filler/placeholder detection — with the specific violation re-prompted on failure, not a bare retry.
- **An account-level de-dup guardrail** — before generating, the service looks up what subject lines have already been written for other contacts at the same company, and requires the new one to be substantively different. This exists because a buying-committee campaign enrolls several people at one account at once, and without it, two peers can independently get the same angle.

See [`service/README.md`](./service/README.md) for the full technical write-up, setup instructions, and debugging history.

## Notable engineering decisions and bugs found

Surfaced during build and fixed, not swept under the rug — these are worth knowing before reviewing the code:

- **Apollo's own webhook merge-tag resolution is intermittently unreliable.** The `{{contact.email}}` field sent by Apollo's "Send Webhook" step occasionally resolves to the literal unresolved placeholder string instead of a real email, causing `HTTP 422 invalid character` errors. Apollo's automatic retry usually recovers it; documented as a real platform finding, not assumed to be our bug.
- **A `Traffic Branch: Split by percentage` step delays ~2/3 of enrolled contacts by 1–2 real days by design** — a deliberate send-time experiment, but it means most contacts won't get a same-day touch, which matters if you're validating on a deadline.
- **`max_tokens: 1024` was silently truncating output for specific contacts.** One contact failed generation 8/8 times with a reproducible "unterminated JSON string" error — isolated to a long job title + a tight tier word limit + several simultaneous constraints. Bumped to `2048` and it succeeded immediately; documented in `generate.ts`.
- **A name-encoding bug corrupted one contact's accented character** (`René` → `Ren�`) in AI-generated custom fields specifically, while Apollo's own system contact record stored it correctly — isolated to the generation pipeline, fixed, and verified by re-reading the live field back from Apollo.
- **The original "breakup" email (Email 4) was a static, unpersonalized template** shared identically by every contact in a sequence — safe for a single-contact cadence, but a real problem at buying-committee scale, since several required contacts share the same persona sequence. Rebuilt as a fifth generated touch with its own prompt.

## Repo layout

```
service/            Generation & Enrollment Service — TypeScript, Cloudflare Workers
  src/
    index.ts         Webhook entry point, payload validation, orchestration
    generate.ts       Claude generation calls, guardrail, de-dup lookup, Apollo write-back
    personas.ts       The 4 buying-committee personas, every system prompt, banned words
    types.ts          WebhookPayload contract
  README.md           Setup, deploy, testing, and full debugging history
spec/
  signal-to-sequence-engine.yaml   Full design spec — source of truth for every architecture decision
screenshots/         Real screenshots from the live, deployed Apollo instance
```

## Live service

`https://vitally-generation-enrollment-service.apollo-take-home.workers.dev`

The `/generate` endpoint is shared-secret protected and expects the payload shape defined in `service/src/types.ts`. See `service/README.md` for a working `curl` example.
