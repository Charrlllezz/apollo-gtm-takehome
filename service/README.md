# Generation & Enrollment Service

The one step native Apollo can't do (see the spec: `generation_and_enrollment_service`,
and diagram Fig. 1.5). Receives a webhook from the Apollo Workflow and, per contact,
generates six persona-grounded touches under a deterministic guardrail — two emails
that pitch, one bump, one breakup, a LinkedIn connect/message pair, and rep-facing
call-prep notes — then writes them all back into Apollo and enrolls the contact in
their persona's sequence.

Write-back/enroll goes through direct Apollo REST calls, not the Apollo MCP connector
— see "Architecture correction" below for why that changed from the original design.

## Status

- [x] Code written, typechecked (`npx tsc --noEmit` — clean), deployed via wrangler
- [x] Apollo API key confirmed working — see auth section below for the real mechanism
- [x] Cloudflare authenticated, deployed: `https://vitally-generation-enrollment-service.apollo-take-home.workers.dev`
- [x] All secrets pushed and live
- [x] Proxy verified end-to-end — real 200 from Apollo's actual MCP server through the deployed proxy; kept as working infra but NOT used by the current `/generate` path (see below)
- [x] **`/generate` fully live-tested and verified against real Apollo state** — run against all 8 required buying-group contacts, each independently re-fetched afterward to confirm the generated content was written verbatim and the contact enrolled correctly
- [x] **Subject/body separation bug found and fixed** — first live test wrote the internal "SUBJECT: X\nBODY: Y" parsing wrapper verbatim into the body field. Fixed: body field gets body text only; a separate custom field holds the subject, merged into the sequence template as `{{Outbound Email N - Subject}}`.
- [x] **Paragraph-spacing bug found and fixed** — rendered email read as one dense block. Fixed by having `assembleEmail`/`assembleFollowUp` join the four schema-guaranteed fields with real `\n\n` server-side, rather than relying on the model to insert its own line breaks.
- [x] **Email 4 rebuilt from a static template into a real generated touch** — the "right person for this?" breakup email was originally hardcoded directly into the sequence step, reasoned at the time as needing no personalization. That broke down at buying-committee scale: multiple required contacts share the same persona sequence, so a static template would land byte-identical across peers who plausibly compare notes. Now generated per-contact via `generateBreakupEmail` / `BREAKUP_SYSTEM_PROMPT`, same guardrail as every other touch.
- [x] **Account-level de-dup guardrail added** — `fetchSiblingSubjects` looks up subject lines already generated for other contacts at the same company before a new Email 1 is written, and the model is required to produce something substantively different, not just a reworded version of the same fact. Capped to the 10 most recent siblings so the prompt doesn't grow unbounded across a large batch.
- [x] **Persona-specific, artifact-named CTAs** — the offer a CTA points to now varies by tier (a Loom recording for Champion/Influencer/Technical Validator, scoped to what that function would want to see; a one-page benchmark for Executive Sponsors — a number and a document, never a demo) and must name the actual artifact, not gesture vaguely at "seeing more." See `PERSONAS[tier].offerType` in `personas.ts`.
- [x] **`max_tokens` bumped 1024 → 2048 after a reproducible truncation bug** — one contact (a long job title + a tight tier word limit + several simultaneous constraints) failed generation 8/8 times with a mid-string JSON truncation. The visible output text was well under the word limit; the model's internal deliberation to satisfy every constraint at once was consuming enough of the token budget that the actual JSON got cut off before it closed.
- [x] **UTF-8 encoding bug found and fixed** — one contact's accented name corrupted in AI-generated custom fields specifically (Apollo's own system contact record stored it correctly, isolating the bug to this pipeline). Fixed by explicitly setting `content-type: application/json; charset=utf-8` on both outbound Apollo REST calls; verified by re-reading the live field back from Apollo after regeneration.

## Architecture correction — Phase B no longer uses Claude+MCP

The original design routed write-back/enroll through Claude with the Apollo MCP connector (least-privilege allowlisted). That consistently failed silently: Anthropic's API returned 200 with zero tools loaded and no error, while a known-good public MCP server (Linear) correctly returned an explicit 400 connection error under an identical request shape — ruling out both the request structure and the SDK version (tested both) as the cause. Root cause narrowed to something in the protocol handshake specific to reaching our proxy, left unresolved rather than burning more time against a deadline.

**The actual fix wasn't a workaround — it was recognizing Phase B never needed an LLM.** By the time generation is validated, we already know exactly which 2 Apollo calls to make with exactly which parameters. `writeBackAndEnroll` now calls Apollo's REST API directly (`PUT /v1/contacts/{id}`, `POST /v1/emailer_campaigns/{id}/add_contact_ids`) with the same `x-api-key` already verified working. Generation stays AI-driven; write-back/enroll is deterministic code — arguably more correct, not a compromise.

The `/apollo-mcp-proxy` route and auth-translation logic are left in place, working and tested independently, in case genuine agentic Phase B behavior is worth revisiting later.

## Auth — verified 2026-08-25, this is NOT what the design originally assumed

Direct curl tests against Apollo's endpoints found two things:

1. **Apollo's MCP server (`https://mcp.apollo.io/mcp`) rejects `Authorization: Bearer <api-key>` with a 401**, but accepts the identical key via **`x-api-key: <api-key>`** with a 200 (confirmed via a real MCP `initialize` handshake). Apollo's MCP auth is not the same as the OAuth flow this session's own Apollo connector uses — a plain API key works, just via a different header.
2. **Anthropic's MCP connector (`mcp_servers[].authorization_token`) only ever sends `Authorization: Bearer`** — it cannot be configured to send `x-api-key`. So the connector can't talk to Apollo's MCP server directly.

**Fix: an auth-translating proxy, built into this same Worker** (`/apollo-mcp-proxy` in `src/index.ts`). The Anthropic connector is pointed at `MCP_PROXY_URL` (this Worker's own public URL) with `authorization_token` set to `MCP_PROXY_SHARED_SECRET` — a secret we generate ourselves, already in `.dev.vars`. The proxy checks that Bearer secret, then forwards to the real Apollo MCP server with `x-api-key: APOLLO_MCP_TOKEN` substituted in. **The real Apollo key never leaves this Worker or reaches Anthropic's infrastructure.**

Practical consequence: `MCP_PROXY_URL` has to be a real public HTTPS URL — the MCP connector call happens server-side at Anthropic, so `wrangler dev`'s `localhost` can't be reached for Phase B (write-back/enroll) testing. Phase A (generation + validation) has no such constraint and can be tested locally.

## Setup

```bash
npm install

# First deploy (needs `npx wrangler login` first — opens a browser)
npm run deploy
# Note the deployed URL wrangler prints, then:
#   1. Update MCP_PROXY_URL in .dev.vars to  <that-url>/apollo-mcp-proxy
#   2. Push all 5 secrets to the deployed Worker (does NOT read .dev.vars):
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put APOLLO_MCP_TOKEN
npx wrangler secret put MCP_PROXY_SHARED_SECRET
npx wrangler secret put MCP_PROXY_URL
npx wrangler secret put WEBHOOK_SHARED_SECRET
# 3. Redeploy so the Worker's own code has its own URL available: npm run deploy

# Local dev for Phase A only (generation/validation, no MCP calls)
npm run dev
```

## Testing the webhook locally

`email_body_field_id`, `email_2_*`, `email_4_*`, `sequence_id`, and `send_email_from_email_account_id`
are required for every tier — see `isValidPayload` in `src/index.ts` for the full check, and
`WebhookPayload` in `src/types.ts` for which fields are tier-conditional (`email_3_*`, the LinkedIn
fields, and the call-prep fields are optional and simply omitted for tiers that don't have that step).

```bash
curl -X POST http://localhost:8787/generate \
  -H "content-type: application/json; charset=utf-8" \
  -H "x-webhook-secret: <WEBHOOK_SHARED_SECRET value>" \
  -d '{
    "email": "eric.quanstrom@apollo.io", "tier": 1,
    "first_name": "Eric", "title": "VP, GTM Engineering",
    "company_name": "Apollo.io",
    "why_now_rationale": "2+ open GTM Engineering / AI Apps roles",
    "email_body_field_id": "...", "email_subject_field_id": "...",
    "email_2_body_field_id": "...", "email_2_subject_field_id": "...",
    "email_4_body_field_id": "...", "email_4_subject_field_id": "...",
    "sequence_id": "...", "send_email_from_email_account_id": "..."
  }'
```

## Design notes (why the code is shaped this way)

- **Two-phase, not one call.** Phase A (generate + validate) has zero
  Apollo tools attached — it cannot reach Apollo even if the model tried.
  Phase B (write-back + enroll) is a separate call with exactly two Apollo
  tools allowlisted via `default_config: {enabled: false}` +
  per-tool `configs`. This is a real security boundary, not just prompt
  instruction.
- **Validation is our own code, not a model self-check.** `generate.ts`'s
  `validate()` runs deterministically (word count, banned words, generic-CTA
  regex) between phases — the model doesn't grade its own homework.
- **Retry re-prompts with the specific violation**, not a bare "try again" —
  see `generateValidatedEmail`'s message-push on failure.
- **The de-dup guardrail fails open, not closed.** `fetchSiblingSubjects` is a
  best-effort lookup — if the Apollo API call errors for any reason, generation
  proceeds with an empty avoid-list rather than blocking the whole pipeline over
  a non-critical check. A missed duplicate is a worse outcome to catch late than
  a stalled webhook.
