import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  PERSONAS,
  BANNED_WORDS,
  WORD_LIMIT,
  SYSTEM_PROMPT,
} from "./personas";
import type { WebhookPayload, GeneratedEmail, ValidationResult } from "./types";

/**
 * Structured output schema — ADDED 2026-08-25 to fix same-input
 * nondeterminism (identical contact/signal produced meaningfully different
 * emails across test runs: different subject lines, different opening
 * rhetorical moves). Forcing 4 named fields, each schema-described with its
 * exact FORM (not just function — see SYSTEM_PROMPT's per-field rules),
 * guarantees structural presence/order/count by the API's own validation,
 * not by hoping the model follows a text instruction. Also removes the
 * body's dependence on the model correctly inserting \n\n itself — the
 * paragraphs are assembled server-side from these 4 discrete fields.
 */
const EmailSchema = z.object({
  subject: z.string().describe("Cold email subject line. Under 9 words, concrete, no clickbait."),
  hook: z.string().describe("Exactly one sentence stating the Pain Point as a direct, factual observation. Never opens with the recipient's name, never a question, never an anecdote."),
  mechanism: z.string().describe("Exactly one sentence stating what Vitally does, grounded only in the persona's Why Now line."),
  proof_point: z.string().describe("Exactly one sentence grounded in a specific real fact from why_now_rationale or company_news_digest. Empty string if no real fact is available — never invented."),
  cta: z.string().describe("Exactly one sentence. A specific, low-friction ask — never a generic 'hop on a call' or bare 'worth a chat?'."),
});

const MAX_GENERATION_RETRIES = 3;
const MODEL = "claude-sonnet-5"; // deliberate right-sizing — see spec: generation_and_enrollment_service.recommended_implementation.model

export interface Env {
  ANTHROPIC_API_KEY: string;
  APOLLO_MCP_TOKEN: string; // Apollo API key — used server-side by the proxy only, never sent to Anthropic
  MCP_PROXY_SHARED_SECRET: string; // Bearer secret the Anthropic MCP connector uses against OUR proxy
  MCP_PROXY_URL: string; // this Worker's own /apollo-mcp-proxy URL — set post-deploy, see index.ts
}

/**
 * Builds the volatile, per-contact half of the prompt. Deliberately kept
 * separate from SYSTEM_PROMPT (which is stable across every call) so the
 * cache prefix — tools -> system -> messages — stays identical call to
 * call. See internal_design.prompt_construction in the spec.
 */
function buildUserTurn(payload: WebhookPayload): string {
  const persona = PERSONAS[payload.tier];
  const lines = [
    `Recipient: ${payload.first_name}, ${payload.title} at ${payload.company_name}`,
    `Persona: ${persona.name}`,
    `Pain Point: ${persona.painPoint}`,
    `Why Now: ${persona.whyNow}`,
    `Word limit: ${WORD_LIMIT[payload.tier]}`,
    `Tone: ${payload.person_tone ?? "data-driven"}`,
    `Account-level Why Now Rationale: ${payload.why_now_rationale}`,
  ];
  if (payload.company_news_digest) {
    lines.push(`Company News Digest: ${payload.company_news_digest}`);
  }
  if (payload.person_linkedin_digest) {
    lines.push(`Person LinkedIn Digest: ${payload.person_linkedin_digest}`);
  }
  if (payload.thought_leadership_digest) {
    lines.push(`Thought Leadership Digest: ${payload.thought_leadership_digest}`);
  }
  if (payload.time_in_role) {
    lines.push(`Time in current role: ${payload.time_in_role}`);
  }
  if (payload.previous_company) {
    lines.push(`Previous company: ${payload.previous_company}`);
  }
  return lines.join("\n");
}

/**
 * Assembles the 4 schema-guaranteed fields into the final body — joined
 * with <br><br> directly (not \n\n), since the destination is body_html
 * (see writeBackAndEnroll); paragraph spacing no longer depends on the
 * model formatting it correctly, it's a server-side join.
 */
function assembleEmail(parsed: z.infer<typeof EmailSchema>): GeneratedEmail {
  const paragraphs = [parsed.hook, parsed.mechanism, parsed.proof_point, parsed.cta].filter(
    (p) => p.trim().length > 0,
  );
  const body = paragraphs.join("<br><br>");
  const wordCount = paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  return { subject: parsed.subject.trim(), body, wordCount };
}

/**
 * The deterministic guardrail described in internal_design.validation_guardrail.
 * Runs on OUR side (not inside the model) before any Apollo tool call fires.
 */
function validate(email: GeneratedEmail, tier: 1 | 2 | 3 | 4): ValidationResult {
  const violations: string[] = [];

  if (!email.subject) violations.push("missing subject");
  if (!email.body) violations.push("missing body (hook/mechanism/cta all came back empty)");
  if (email.wordCount > WORD_LIMIT[tier]) {
    violations.push(`${email.wordCount} words, over the ${WORD_LIMIT[tier]}-word limit`);
  }
  const lowerBody = email.body.toLowerCase();
  for (const banned of BANNED_WORDS) {
    if (lowerBody.includes(banned)) violations.push(`used banned word "${banned}"`);
  }
  if (/hop on a call|got 15 minutes|15 min/i.test(email.body)) {
    violations.push('used a generic CTA ("hop on a call" / "15 minutes") instead of a specific ask');
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Phase A — generation, with our own retry loop enforcing the guardrail.
 * No Apollo tools are attached here; this call cannot touch Apollo at all,
 * by construction, not just by prompt instruction.
 */
export async function generateValidatedEmail(
  client: Anthropic,
  payload: WebhookPayload,
): Promise<GeneratedEmail> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildUserTurn(payload) },
  ];

  for (let attempt = 1; attempt <= MAX_GENERATION_RETRIES; attempt++) {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
      output_config: { format: zodOutputFormat(EmailSchema) },
    });

    if (!response.parsed_output) {
      // Schema validation itself failed — not a content-quality issue,
      // retry the same way as any other violation.
      if (attempt === MAX_GENERATION_RETRIES) {
        throw new Error(`Generation failed to produce parseable structured output after ${MAX_GENERATION_RETRIES} attempts`);
      }
      messages.push({ role: "user", content: "Your last response didn't match the required schema. Try again." });
      continue;
    }

    const parsed = response.parsed_output;
    const email = assembleEmail(parsed);
    const result = validate(email, payload.tier);

    if (result.valid) return email;

    if (attempt === MAX_GENERATION_RETRIES) {
      throw new Error(
        `Generation failed validation after ${MAX_GENERATION_RETRIES} attempts: ${result.violations.join("; ")}`,
      );
    }

    // Re-prompt with the specific violation named — not a silent retry.
    messages.push({ role: "assistant", content: JSON.stringify(parsed) });
    messages.push({
      role: "user",
      content: `Your last draft failed: ${result.violations.join("; ")}. Revise and resend, same schema.`,
    });
  }

  // Unreachable — loop always returns or throws — but keeps TS's control-flow analysis happy.
  throw new Error("generateValidatedEmail: exhausted retries without returning");
}

export interface WriteBackResult {
  wroteField: boolean;
  enrolled: boolean;
}

/**
 * Phase B — write-back + enroll, via DIRECT Apollo REST calls, not the
 * Claude+MCP connector.
 *
 * CORRECTED 2026-08-25: originally routed through Claude with the Apollo
 * MCP connector (least-privilege allowlisted to these same 2 tools). That
 * consistently failed silently — Anthropic's API returned 200 with zero
 * tools loaded (no error, no tool-definition tokens), while a known-good
 * public MCP server (Linear) correctly returned an explicit 400 connection
 * error under the same request shape — narrowing it to something in the
 * protocol handshake specific to reaching our proxy, not a request-shape
 * or SDK-version issue (ruled both out first). Root cause remains
 * unresolved; not worth further time against it.
 *
 * The pragmatic fix, not just a workaround: Phase B never needed an LLM's
 * judgment in the first place — by the time we're here, Phase A has
 * already produced validated content and we already know exactly which 2
 * Apollo calls to make with exactly which parameters. Routing a
 * deterministic action through a model was solving a problem that doesn't
 * exist at this step. Direct REST calls are simpler, and arguably the more
 * correct architecture: generation stays AI-driven (the part that actually
 * needs judgment), write-back/enroll is deterministic code.
 *
 * Endpoints + payload shapes verified live via curl on 2026-08-25 before
 * being wired in here — see service/README.md.
 */
export async function writeBackAndEnroll(
  env: Env,
  payload: WebhookPayload,
  email: GeneratedEmail,
): Promise<WriteBackResult> {
  // Body field gets only the body text (subject goes to its own field —
  // email_subject_field_id — so the sequence template can merge it into
  // the actual Subject line). email.body already arrives <br><br>-joined
  // from assembleEmail() in Phase A — no further transform needed here;
  // structured outputs made the paragraph-spacing fix a server-side join
  // instead of hoping the model inserts \n\n correctly.
  const bodyForField = email.body;

  const updateFields: Record<string, string> = {
    [payload.email_body_field_id]: bodyForField,
  };
  if (payload.email_subject_field_id) {
    updateFields[payload.email_subject_field_id] = email.subject;
  }

  const updateResp = await fetch(`https://api.apollo.io/api/v1/contacts/${payload.contact_id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-api-key": env.APOLLO_MCP_TOKEN },
    body: JSON.stringify({
      typed_custom_fields: updateFields,
    }),
  });
  if (!updateResp.ok) {
    throw new Error(
      `apollo contacts update failed: HTTP ${updateResp.status} ${await updateResp.text()}`,
    );
  }

  const enrollResp = await fetch(
    `https://api.apollo.io/api/v1/emailer_campaigns/${payload.sequence_id}/add_contact_ids`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.APOLLO_MCP_TOKEN },
      body: JSON.stringify({
        contact_ids: [payload.contact_id],
        emailer_campaign_id: payload.sequence_id,
        send_email_from_email_account_id: payload.send_email_from_email_account_id,
      }),
    },
  );
  if (!enrollResp.ok) {
    throw new Error(
      `apollo emailer_campaigns add_contact_ids failed: HTTP ${enrollResp.status} ${await enrollResp.text()}`,
    );
  }

  return { wroteField: true, enrolled: true };
}
