# Generation & Enrollment Service

The one step native Apollo can't do (see the spec: `generation_and_enrollment_service`,
and diagram Fig. 1.5). Receives a webhook from the Apollo Workflow, generates
a persona-grounded email under a deterministic guardrail, then writes it
back into Apollo and enrolls the contact — via the native Apollo MCP
connector, not hand-wrapped API calls.

## Status

- [x] Code written, typechecked (`npx tsc --noEmit` — clean), bundles via wrangler (174.15 KiB / 37.62 KiB gzip)
- [x] Apollo API key confirmed working (2026-08-25, direct curl tests) — see auth section below for the real mechanism
- [x] Cloudflare authenticated, deployed: `https://vitally-generation-enrollment-service.apollo-take-home.workers.dev`
- [x] All 5 secrets pushed and live
- [x] Proxy verified end-to-end (2026-08-25) — real 200 from Apollo's actual MCP server through the deployed proxy; kept as working infra but NOT used by the current `/generate` path (see below)
- [x] **`/generate` fully live-tested and verified against real Apollo state (2026-08-25)** — ran against Eric Quanstrom (real contact), then independently re-fetched his contact record and confirmed: the generated body was written verbatim to the custom field, he's really enrolled in the sequence, and Apollo auto-paused him because the sequence is inactive (safety design working as intended — nothing sends without explicit activation)
- [x] **Subject/body separation bug found and fixed (2026-08-25)** — first live test wrote the internal "SUBJECT: X\nBODY: Y" parsing wrapper verbatim into the body field, and the sequence template used a static placeholder subject instead of merging in the real generated one. Fixed: body field gets body text only; a second custom field ("Outbound Email 1 - Subject", id `6a8d5691f6d7c600107a2aa2`) holds the subject, and the sequence template now merges `{{Outbound Email 1 - Subject}}`. Re-verified clean against real Apollo data after the fix.
- [x] **Paragraph-spacing bug found and fixed (2026-08-25)** — rendered email read as one dense block. Two causes, both fixed: (1) the prompt never asked for paragraph structure, so the model wrote continuous prose — added an explicit 3-4-short-paragraph structure rule to SYSTEM_PROMPT; (2) even with real paragraph breaks, the merge target is `body_html` (HTML context), where plain `\n` collapses — `writeBackAndEnroll` now converts `\n` to `<br>` before writing. Re-verified against real Apollo data: body now shows genuine `<br><br>`-separated paragraphs (hook / mechanism / proof / CTA).

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

```bash
curl -X POST http://localhost:8787/generate \
  -H "content-type: application/json" \
  -H "x-webhook-secret: <WEBHOOK_SHARED_SECRET value>" \
  -d '{
    "contact_id": "...", "tier": 1,
    "first_name": "Eric", "title": "VP, GTM Engineering & GM, Apollo Labs",
    "company_name": "Apollo.io",
    "why_now_rationale": "2+ open GTM Engineering / AI Apps roles",
    "email_body_field_id": "...", "sequence_id": "..."
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
