import Anthropic from "@anthropic-ai/sdk";
import {
  generateValidatedEmail,
  generateBumpEmail,
  generateNewAngleEmail,
  generateBreakupEmail,
  generateLinkedInConnectNote,
  generateLinkedInMessage,
  generateCallPrepNote,
  generateFollowUpCallPrepNote,
  writeBackAndEnroll,
  fetchSiblingSubjects,
  type Env as AnthropicEnv,
} from "./generate";
import type { WebhookPayload } from "./types";

export interface Env extends AnthropicEnv {
  WEBHOOK_SHARED_SECRET: string;
}

const APOLLO_MCP_URL = "https://mcp.apollo.io/mcp";

/**
 * Auth-translating reverse proxy: the Anthropic MCP connector can only send
 * `Authorization: Bearer <token>`, but Apollo's MCP server requires
 * `x-api-key` (verified 2026-08-25 — Bearer gets a 401, x-api-key gets 200).
 * This route is the only place APOLLO_MCP_TOKEN is ever used; it's never
 * sent to Anthropic's infrastructure or embedded in any prompt/request.
 */
async function proxyToApolloMcp(request: Request, env: Env): Promise<Response> {
  const incomingAuth = request.headers.get("authorization");
  if (incomingAuth !== `Bearer ${env.MCP_PROXY_SHARED_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete("authorization");
  forwardHeaders.delete("host");
  forwardHeaders.set("x-api-key", env.APOLLO_MCP_TOKEN);

  return fetch(APOLLO_MCP_URL, {
    method: request.method,
    headers: forwardHeaders,
    body: request.body,
    // @ts-expect-error — Cloudflare Workers-specific duplex requirement for streamed bodies
    duplex: "half",
  });
}

function isValidPayload(body: unknown): body is WebhookPayload {
  if (typeof body !== "object" || body === null) return false;
  const p = body as Record<string, unknown>;
  return (
    typeof p.email === "string" &&
    [1, 2, 3, 4].includes(p.tier as number) &&
    typeof p.first_name === "string" &&
    typeof p.title === "string" &&
    typeof p.company_name === "string" &&
    typeof p.why_now_rationale === "string" &&
    typeof p.email_body_field_id === "string" &&
    typeof p.email_2_body_field_id === "string" &&
    typeof p.email_2_subject_field_id === "string" &&
    typeof p.email_4_body_field_id === "string" &&
    typeof p.email_4_subject_field_id === "string" &&
    typeof p.sequence_id === "string" &&
    typeof p.send_email_from_email_account_id === "string"
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/apollo-mcp-proxy") {
      return proxyToApolloMcp(request, env);
    }

    if (url.pathname !== "/generate" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    // Lightweight shared-secret check — Apollo Workflows don't offer signed
    // webhook payloads, so this is the practical auth boundary for who can
    // trigger generation. Not a substitute for the Apollo/Anthropic
    // credentials themselves, just gates who can spend them.
    const providedSecret = request.headers.get("x-webhook-secret");
    if (providedSecret !== env.WEBHOOK_SHARED_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response("invalid JSON body", { status: 400 });
    }

    if (!isValidPayload(payload)) {
      return new Response("payload missing required fields", { status: 400 });
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    try {
      // ADDED 2026-08-27: account-level de-dup guardrail. Looks up subject
      // lines already generated for OTHER contacts at this same company —
      // buying-committee campaigns enroll several people at once, and
      // without this, two people in the same tier (or even the exec pair)
      // can get the same angle independently since each generation call
      // otherwise has no visibility into its siblings. See
      // fetchSiblingSubjects doc comment in generate.ts.
      const siblingSubjects = await fetchSiblingSubjects(
        env,
        payload.company_name,
        payload.email,
        [payload.email_subject_field_id, payload.email_2_subject_field_id, payload.email_3_subject_field_id, payload.email_4_subject_field_id].filter(
          (id): id is string => Boolean(id),
        ),
      );

      // Phase A: generate + validate. Cannot touch Apollo — no tools attached.
      // Email 2 (bump) always runs — every cadence has that touch. Email 3
      // (new angle) only exists for Champion/Influencer, so it's skipped
      // entirely — no wasted generation spend — when the webhook body didn't
      // include those two field ids (see types.ts doc comment). Email 4
      // (breakup) always runs — every cadence ends on this step.
      const email = await generateValidatedEmail(client, payload, siblingSubjects);
      const bumpEmail = await generateBumpEmail(client, payload, email);
      const newAngleEmail =
        payload.email_3_body_field_id && payload.email_3_subject_field_id
          ? await generateNewAngleEmail(client, payload, email)
          : null;
      const linkedInConnectNote = payload.linkedin_connect_note_field_id
        ? await generateLinkedInConnectNote(client, payload)
        : null;
      const linkedInMessage = payload.linkedin_message_field_id
        ? await generateLinkedInMessage(client, payload, email)
        : null;
      // Call 1 fires same day as Email 1 (and the LinkedIn connect note, if
      // sent) — both are passed in so the note can summarize what's already
      // gone out, not just the day's signal.
      const callPrepNote = payload.call_prep_note_field_id
        ? await generateCallPrepNote(client, payload, email, linkedInConnectNote)
        : null;
      // Call 2 fires after Email 2, LinkedIn Message, and Email 3 in both
      // cadences that have calls (Champion/Influencer) — pass the full
      // labeled thread, not just the most recent touch, so the note can
      // summarize everything sent since Call 1.
      const followUpTouches = [{ label: "Email 2 (bump)", email: bumpEmail }];
      if (linkedInMessage) followUpTouches.push({ label: "LinkedIn message", email: linkedInMessage });
      if (newAngleEmail) followUpTouches.push({ label: "Email 3 (new angle)", email: newAngleEmail });
      const followUpCallPrepNote =
        payload.call_prep_note_2_field_id && newAngleEmail
          ? await generateFollowUpCallPrepNote(client, payload, followUpTouches)
          : null;
      const breakupEmail = await generateBreakupEmail(client, payload);

      // Phase B: write-back + enroll via direct Apollo REST calls — see
      // generate.ts's writeBackAndEnroll doc comment for why this replaced
      // the original Claude+MCP-connector design (2026-08-25).
      const result = await writeBackAndEnroll(
        env,
        payload,
        email,
        bumpEmail,
        newAngleEmail,
        linkedInConnectNote,
        linkedInMessage,
        callPrepNote,
        followUpCallPrepNote,
        breakupEmail,
      );

      return new Response(
        JSON.stringify({
          status: "enrolled",
          contact_id: result.contactId,
          email: payload.email,
          subject: email.subject,
          bumpSubject: bumpEmail.subject,
          newAngleSubject: newAngleEmail?.subject ?? null,
          breakupSubject: breakupEmail.subject,
          siblingSubjectsAvoided: siblingSubjects,
          wroteField: result.wroteField,
          enrolled: result.enrolled,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (err) {
      console.error("Generation/enrollment failed", err);
      return new Response(
        JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
