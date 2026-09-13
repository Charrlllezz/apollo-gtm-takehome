# Signal-to-Sequence Engine

A GTM system built inside Apollo that watches target accounts for buying
signals, pulls and tiers the buying committee, generates every touch of each
person's cadence under a deterministic guardrail, and enrolls them in the right
sequence — with a human sign-off before anything sends.

Built in August 2026 as the Apollo GTM Engineer take-home, on a real Apollo
account, for Vitally (an AI-powered Customer Success platform) pitched to RevOps
and GTM Engineering leadership. The one step native Apollo can't do — generating
per-contact copy and getting it into the sequence — is a deployed Cloudflare
Worker in [`service/`](service/).

**[Presentation](https://claude.ai/code/artifact/658414ed-6cdb-4a61-b400-e18f10aac5cd)** — architecture, the actual system prompt, real
messaging variants, screenshots, metrics. This repo is the code and spec behind it.

**The assignment, in one line:** pick a company, design its outbound engine
end to end (value prop, signals, workflow, messaging system, metrics), and
prove it works with a real Workflow and real sent emails.

## What it does, end to end

```
Signal detection ── Apollo Workflow "Headcount Growth Signal"
  firmographic fit (200-5000 employees, $25M+ raised, US/CA/UK, software)
  + headcount growth 10%+ over 6 months · open GTM/RevOps roles · new leader hire
  → Research with AI: account fit-check, per-person LinkedIn digest
        ↓
Buying committee pull ── Apollo Workflow, one lane per persona
  Champion (VP/Head) · Influencer (Mgr/Dir) · Exec Sponsor (C-suite) · Technical Validator
  → traffic split into send-timing cohorts → Send Webhook
        ↓
Generation & Enrollment Service ── this repo, Cloudflare Worker
  Phase A  generate each touch → validate in code → retry with the violation named
  Phase B  resolve the contact, write every field back, enroll in the persona's sequence
        ↓
Apollo Sequences ── four persona-specific cadences
  Email 1 → Email 2 (bump) → LinkedIn → Call → Email 3 (new angle) → Email 4 (right person?)
  branching on reply / interest / out-of-office; human approves before anything sends
```

Two Apollo Workflows, four Sequences, one deployed service. Live Workflow
screenshots are in [`screenshots/`](screenshots/); the tier taxonomy, cadences,
metrics loop and decision history are in the
[spec](spec/signal-to-sequence-engine.yaml), with a companion
[diagram](https://claude.ai/code/artifact/2ba1ea98-4417-47d1-99e0-4f9d5763b743).

## What shipped

- The service, deployed on Cloudflare Workers and wired to a real Apollo
  account. Live-tested against all eight buying-group contacts, each
  independently re-fetched afterward to confirm the generated content landed
  verbatim and the contact was enrolled.
- Real Workflows, four real sequences, real custom fields per touch, a
  connected sending mailbox. Real emails went out through it.
- Per contact, the service generates a first-touch pitch, a bump, a new-angle
  email, a "right person for this?" breakup, a LinkedIn connect note and
  message, and two rep-facing call-prep notes — the LinkedIn and call items
  only for the tiers whose cadence has those steps.

Not done: targeting still runs off Apollo's UI search — two search endpoints
were blocked at the account's plan level (diagnosis in the spec's `execution_notes`).

## Why generation sits outside Apollo

Apollo's own tool docs describe the per-contact custom-field merge as a
"complete, hand-written" body: a sequence resolves the merge tag to whatever is
already stored, nothing generates live. A Workflow can fire a webhook but can't
wait on its response. So one component owns the whole chain — generate, write
back, enroll — then hands control back to Apollo to send, track and branch.

## The interesting decisions

**The Apollo key never reaches Anthropic.** Generation (Phase A) is a Claude
call with no tools attached — it cannot touch Apollo even if the model tried.
Write-back and enrollment (Phase B) are direct Apollo REST calls from the
Worker, with the key held as a Worker secret. That boundary is structural, not
a prompt instruction.

**Phase B never needed a model.** The original design routed write-back
through Claude with the Apollo MCP connector, allowlisted to two tools. It
failed silently — a 200 with zero tools loaded — while the same request against
a known-good MCP server returned a proper error. Rather than keep debugging
under deadline, the fix was to notice that by the time Phase B runs, the exact
calls and parameters are already known; deterministic code is the more correct
shape. The auth-translating proxy the connector route needed (Apollo's MCP
server wants `x-api-key`; Anthropic's connector only sends `Bearer`) is
verified working and kept at `/apollo-mcp-proxy`.

**Validation is code, not a model grading its own homework.** `validate()` in
[`service/src/generate.ts`](service/src/generate.ts) checks word limits per
touch and tier, a 20-entry banned-word list, generic-CTA phrasing, filler and
placeholder markers, truncation (no terminal punctuation), and LinkedIn's
real 300-character cap. On failure it re-prompts with the specific violation
named, up to three attempts, then fails loudly — a contact silently never
enrolled is the worse failure mode.

**Two peers at one company must not get the same email.** A committee
campaign enrolls several people at one account at once, and each generation
call otherwise has no idea what its siblings got. Before writing Email 1, the
service looks up the subject lines already generated for other contacts at
the same company (capped to the ten most recent) and requires a substantively
different angle. The lookup fails open: a missed duplicate is a better failure
than a stalled webhook.

**Persona CTAs name a concrete artifact.** A Loom recording scoped to what a
Champion, Influencer, or Technical Validator would want to see; a one-page
benchmark for an Executive Sponsor — a number and a document, never a demo.
Email 4 was a static template in the sequence step; at committee scale that
lands byte-identical across peers, so it became a generated touch too.

**Structured output, assembled server-side.** Identical inputs were producing
meaningfully different emails run to run. The fix is a Zod schema forcing four
named fields — hook, mechanism, proof_point, cta — each described by its *form*:
one sentence, never opens with the recipient's name, an empty string rather than
an invented proof point. Paragraph joins and greetings are done in code.

**Found live, kept on the record.** Apollo's webhook merge tag for the contact
email occasionally arrives unresolved (a 422, recovered by Apollo's retry); the
webhook picker exposes no contact ID, so the service resolves the contact from
its email; `max_tokens: 1024` truncated JSON for one contact eight times out of
eight until 2048; an accented name corrupted until the REST calls declared
`charset=utf-8`. Full list in [`service/README.md`](service/README.md).

## Repo layout

```
service/                              Generation & Enrollment Service (TypeScript, Cloudflare Workers)
  src/index.ts                        webhook entry, shared-secret auth, orchestration, MCP auth proxy
  src/generate.ts                     guardrail, retry loop, de-dup lookup, Apollo write-back + enroll
  src/personas.ts                     the four personas and offers, every system prompt, banned words
  src/types.ts                        webhook payload contract
  README.md                           setup, deploy, curl example, full debugging history
spec/signal-to-sequence-engine.yaml   the design: stages, cadences, metrics loop, decision history
screenshots/                          the live Apollo Workflows
```

## Run it

```bash
cd service && npm install
# .dev.vars (gitignored): ANTHROPIC_API_KEY, APOLLO_MCP_TOKEN, WEBHOOK_SHARED_SECRET,
#                         MCP_PROXY_SHARED_SECRET, MCP_PROXY_URL
npm run dev                  # http://localhost:8787
npm run deploy               # after `npx wrangler login`; then `wrangler secret put` each secret
```

POST to `/generate` with the `x-webhook-secret` header; the payload is typed in
[`service/src/types.ts`](service/src/types.ts), with a working curl in
[`service/README.md`](service/README.md). With a real Apollo key a local run
writes to your real Apollo account. Enrollment is reversible; sending is gated
behind the sequence being active and approved.
