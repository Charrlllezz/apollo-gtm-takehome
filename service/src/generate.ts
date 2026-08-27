import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  PERSONAS,
  BANNED_WORDS,
  WORD_LIMIT,
  SYSTEM_PROMPT,
  BUMP_SYSTEM_PROMPT,
  NEW_ANGLE_SYSTEM_PROMPT,
  BUMP_WORD_LIMIT,
  NEW_ANGLE_WORD_LIMIT,
  LINKEDIN_CONNECT_SYSTEM_PROMPT,
  LINKEDIN_MESSAGE_SYSTEM_PROMPT,
  LINKEDIN_CONNECT_CHAR_LIMIT,
  LINKEDIN_MESSAGE_WORD_LIMIT,
  CALL_PREP_SYSTEM_PROMPT,
  CALL_PREP_FOLLOWUP_SYSTEM_PROMPT,
  CALL_PREP_WORD_LIMIT,
  BREAKUP_SYSTEM_PROMPT,
  BREAKUP_WORD_LIMIT,
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

/**
 * ADDED 2026-08-26: Email 2 ("bump") and Email 3 ("new angle") follow-up
 * touches. Plain {subject, body} rather than the 4-part hook/mechanism/
 * proof/cta schema — these are short, low-effort-reading follow-ups, not a
 * second full pitch (see personas.ts doc comment on BUMP_SYSTEM_PROMPT).
 */
const FollowUpEmailSchema = z.object({
  subject: z.string().describe("Follow-up subject line, under 8 words."),
  body: z.string().describe("1-2 sentence email body, per the system prompt's rules."),
});

/** LinkedIn touches have no subject line — just body content. */
const LinkedInNoteSchema = z.object({
  body: z.string().describe("The LinkedIn connect note or message content, per the system prompt's rules."),
});

/**
 * ADDED 2026-08-27: greeting variety, per explicit request — a fixed "Hi X,"
 * on every single email in a multi-touch sequence read as templated. Picked
 * server-side (not model-generated) for the same reason paragraph joining
 * is server-side: deterministic, no retry-loop dependency on the model
 * getting formatting right. "Good afternoon" carries a real risk — Apollo
 * doesn't currently pass send-time/timezone data into this service, so it
 * can land at any local hour for the recipient. Flagged, not removed, since
 * it was explicitly requested.
 */
const EMAIL_GREETINGS = ["Hi", "Hello", "Hey", "Good afternoon"];

function pickGreeting(firstName: string): string {
  const salutation = EMAIL_GREETINGS[Math.floor(Math.random() * EMAIL_GREETINGS.length)];
  return `${salutation} ${firstName},`;
}

/** Degenerate-output markers for the validation guardrail — see validate(). */
const FILLER_MARKERS = ["placeholder", "lorem ipsum", "todo:", "[insert", "tbd"];

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
 *
 * ADDED 2026-08-27: optional siblingSubjects — subject/hook lines already
 * generated for OTHER contacts at the same account. See fetchSiblingSubjects
 * doc comment for why this exists: a buying-committee campaign enrolls
 * several people at one company at once, and without this, the model has no
 * way to know (let alone avoid) producing the same angle twice for two
 * people who might compare notes.
 */
function buildUserTurn(payload: WebhookPayload, siblingSubjects: string[] = []): string {
  const persona = PERSONAS[payload.tier];
  const lines = [
    `Recipient: ${payload.first_name}, ${payload.title} at ${payload.company_name}`,
    `Persona: ${persona.name}`,
    `Pain Point: ${persona.painPoint}`,
    `Why Now: ${persona.whyNow}`,
    `Offer: ${persona.offerType}`,
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
  if (siblingSubjects.length > 0) {
    lines.push(
      `Already sent to colleagues at this company (must be substantively different from all of these, not just reworded): ${siblingSubjects
        .map((s) => `"${s}"`)
        .join("; ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * ADDED 2026-08-26: shared context builder for the Email 2/3 follow-ups —
 * both need the original email so they can avoid repeating its wording or
 * lead fact (see BUMP_SYSTEM_PROMPT / NEW_ANGLE_SYSTEM_PROMPT).
 */
function buildFollowUpUserTurn(payload: WebhookPayload, original: GeneratedEmail): string {
  const persona = PERSONAS[payload.tier];
  const lines = [
    `Recipient: ${payload.first_name}, ${payload.title} at ${payload.company_name}`,
    `Persona: ${persona.name}`,
    `Offer: ${persona.offerType}`,
    `Account-level Why Now Rationale: ${payload.why_now_rationale}`,
    `Original email subject: ${original.subject}`,
    `Original email body: ${original.body.replace(/\s*\n+\s*/g, " ")}`,
  ];
  if (payload.company_news_digest) {
    lines.push(`Company News Digest: ${payload.company_news_digest}`);
  }
  return lines.join("\n");
}

/**
 * ADDED 2026-08-27: shared context builder for the call-prep notes — both
 * need a summary of every touch already sent so the rep can reference the
 * thread without re-reading it. Distinct from buildFollowUpUserTurn (which
 * only carries the single most recent email, for de-duplication purposes,
 * not summarization) — call notes need the full labeled list, not just the
 * last touch.
 */
function buildTouchSummaryUserTurn(
  payload: WebhookPayload,
  touches: Array<{ label: string; email: GeneratedEmail }>,
): string {
  const persona = PERSONAS[payload.tier];
  const lines = [
    `Recipient: ${payload.first_name}, ${payload.title} at ${payload.company_name}`,
    `Persona: ${persona.name}`,
    `Pain Point: ${persona.painPoint}`,
    `Account-level Why Now Rationale: ${payload.why_now_rationale}`,
  ];
  if (payload.person_linkedin_digest) {
    lines.push(`Person LinkedIn Digest: ${payload.person_linkedin_digest}`);
  }
  for (const { label, email } of touches) {
    const subjectPart = email.subject ? ` (subject: "${email.subject}")` : "";
    lines.push(`${label}${subjectPart}: ${email.body.replace(/\s*\n+\s*/g, " ")}`);
  }
  return lines.join("\n");
}

/**
 * Assembles the 4 schema-guaranteed fields into the final body, plus a
 * server-side greeting line. Joined with real "\n\n", not "<br><br>" —
 * CORRECTED 2026-08-27: the destination is a plain `textarea` custom field,
 * not an HTML body. Apollo's merge-tag substitution treats the field value
 * as plain text, so literal "<br>" tags were showing up as visible
 * characters in the actual rendered email instead of a line break. Real
 * newlines render correctly regardless of whether the downstream template
 * treats the value as HTML or plain text. wordCount excludes the greeting —
 * word limits were tuned against the model's own generated content only.
 */
function assembleEmail(parsed: z.infer<typeof EmailSchema>, firstName: string): GeneratedEmail {
  const paragraphs = [parsed.hook, parsed.mechanism, parsed.proof_point, parsed.cta].filter(
    (p) => p.trim().length > 0,
  );
  const body = [pickGreeting(firstName), ...paragraphs].join("\n\n");
  const wordCount = paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  return { subject: parsed.subject.trim(), body, wordCount };
}

/** Assembler for the plain {subject, body} follow-up schema — greeting prepended, same as assembleEmail. */
function assembleFollowUp(parsed: z.infer<typeof FollowUpEmailSchema>, firstName: string): GeneratedEmail {
  const wordCount = parsed.body.split(/\s+/).filter(Boolean).length;
  const body = `${pickGreeting(firstName)}\n\n${parsed.body}`;
  return { subject: parsed.subject.trim(), body, wordCount };
}

/** Assembler for LinkedIn touches — no subject field exists on LinkedIn. */
function assembleLinkedInNote(parsed: z.infer<typeof LinkedInNoteSchema>): GeneratedEmail {
  const wordCount = parsed.body.split(/\s+/).filter(Boolean).length;
  return { subject: "", body: parsed.body, wordCount };
}

/**
 * The deterministic guardrail described in internal_design.validation_guardrail.
 * Runs on OUR side (not inside the model) before any Apollo tool call fires.
 * Takes an explicit word limit rather than a tier lookup — ADDED 2026-08-26
 * so the same guardrail covers the follow-up emails (fixed limits, not
 * tier-indexed) as well as the primary one. Optional charLimit added the
 * same day for the LinkedIn connect note, which is bound by a real platform
 * character cap rather than a word-count style preference.
 */
function validate(email: GeneratedEmail, wordLimit: number, charLimit?: number): ValidationResult {
  const violations: string[] = [];

  if (!email.subject && email.subject !== "") violations.push("missing subject");
  if (!email.body) violations.push("missing body (hook/mechanism/cta all came back empty)");
  if (email.wordCount > wordLimit) {
    violations.push(`${email.wordCount} words, over the ${wordLimit}-word limit`);
  }
  if (charLimit && email.body.length > charLimit) {
    violations.push(`${email.body.length} characters, over the ${charLimit}-character limit`);
  }
  const lowerBody = email.body.toLowerCase();
  for (const banned of BANNED_WORDS) {
    if (lowerBody.includes(banned)) violations.push(`used banned word "${banned}"`);
  }
  if (/hop on a call|got 15 minutes|15 min/i.test(email.body)) {
    violations.push('used a generic CTA ("hop on a call" / "15 minutes") instead of a specific ask');
  }
  if (/want me to/i.test(email.body)) {
    violations.push('used "want me to" phrasing for the CTA — use "Any interest in..." or "Would it help to see..." instead');
  }
  // ADDED 2026-08-27: caught live — a generation returned literal
  // "placeholder" text for 3 of 4 fields with a truncated hook, and passed
  // every check above (short, no banned words, no generic CTA). Neither
  // check here is specific to that one failure — both are general-purpose
  // guards against degenerate/incomplete output slipping through.
  for (const filler of FILLER_MARKERS) {
    if (lowerBody.includes(filler)) violations.push(`contains filler/placeholder text ("${filler}") — degenerate generation`);
  }
  if (email.body.trim() && !/[.!?"]$/.test(email.body.trim())) {
    violations.push("body does not end in terminal punctuation — looks truncated or incomplete");
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Phase A — generation, with our own retry loop enforcing the guardrail.
 * No Apollo tools are attached here; this call cannot touch Apollo at all,
 * by construction, not just by prompt instruction.
 *
 * REFACTORED 2026-08-26 into a generic helper — generateValidatedEmail,
 * generateBumpEmail, and generateNewAngleEmail all share this same
 * retry-until-valid loop, just parameterized by schema/prompt/word limit/
 * assembler, instead of three copies of the same loop.
 */
async function generateWithGuardrail<Schema extends z.ZodTypeAny>(
  client: Anthropic,
  systemPrompt: string,
  userTurn: string,
  schema: Schema,
  wordLimit: number,
  assemble: (parsed: z.infer<Schema>) => GeneratedEmail,
  charLimit?: number,
): Promise<GeneratedEmail> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userTurn }];

  for (let attempt = 1; attempt <= MAX_GENERATION_RETRIES; attempt++) {
    let response: Awaited<ReturnType<typeof client.messages.parse>>;
    try {
      response = await client.messages.parse({
        model: MODEL,
        // BUMPED 2026-08-27 from 1024 — caught live: a contact with a long
        // job title, a tight tier word limit, and a full sibling avoid-list
        // reproducibly truncated mid-string on every attempt (8/8), while
        // every other contact in the same batch succeeded within a few
        // retries. The output text itself is short (well under the word
        // limit), but the model's internal deliberation to satisfy several
        // simultaneous constraints at once appears to consume enough of the
        // token budget that the actual JSON gets cut off before it closes.
        max_tokens: 2048,
        system: systemPrompt,
        messages,
        output_config: { format: zodOutputFormat(schema) },
      });
    } catch (err) {
      // ADDED 2026-08-27: caught live — a malformed-JSON response threw
      // directly out of client.messages.parse (an unterminated string),
      // bypassing the retry loop entirely on attempt 1 even though this is
      // exactly the kind of transient failure the loop exists to absorb.
      // Treat a parse-level exception the same as any other failed attempt.
      if (attempt === MAX_GENERATION_RETRIES) {
        throw new Error(
          `Generation failed after ${MAX_GENERATION_RETRIES} attempts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      messages.push({ role: "user", content: "Your last response could not be parsed. Try again, same schema." });
      continue;
    }

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
    const email = assemble(parsed);
    const result = validate(email, wordLimit, charLimit);

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
  throw new Error("generateWithGuardrail: exhausted retries without returning");
}

export async function generateValidatedEmail(
  client: Anthropic,
  payload: WebhookPayload,
  siblingSubjects: string[] = [],
): Promise<GeneratedEmail> {
  return generateWithGuardrail(
    client,
    SYSTEM_PROMPT,
    buildUserTurn(payload, siblingSubjects),
    EmailSchema,
    WORD_LIMIT[payload.tier],
    (parsed) => assembleEmail(parsed, payload.first_name),
  );
}

/**
 * ADDED 2026-08-27: account-level de-dup guardrail. Looks up other contacts
 * already generated for at this same company and returns whatever subject
 * lines are already sitting in their Email 1/2/3/4 fields, so
 * generateValidatedEmail can be told explicitly what to avoid.
 *
 * Uses q_keywords against company_name rather than an account_id filter —
 * q_keywords-by-exact-string is the same mechanism already proven reliable
 * in writeBackAndEnroll's contact lookup, so this reuses a known-working
 * pattern instead of an unverified API parameter. Client-side filters the
 * result to exact organization_name matches and excludes the current
 * contact's own email.
 *
 * Fails open: if the lookup errors for any reason, generation proceeds
 * without a dedup list rather than blocking the whole pipeline over a
 * best-effort check.
 */
export async function fetchSiblingSubjects(
  env: Env,
  companyName: string,
  excludeEmail: string,
  subjectFieldIds: string[],
): Promise<string[]> {
  try {
    const resp = await fetch("https://api.apollo.io/api/v1/contacts/search", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "x-api-key": env.APOLLO_MCP_TOKEN },
      body: JSON.stringify({ q_keywords: companyName, per_page: 25 }),
    });
    if (!resp.ok) return [];
    const data: {
      contacts?: Array<{
        email?: string;
        organization_name?: string;
        typed_custom_fields?: Record<string, string>;
      }>;
    } = await resp.json();
    const siblings = (data.contacts ?? []).filter(
      (c) => c.email !== excludeEmail && c.organization_name === companyName,
    );
    const subjects: string[] = [];
    for (const sibling of siblings) {
      for (const fieldId of subjectFieldIds) {
        const value = sibling.typed_custom_fields?.[fieldId];
        if (value) subjects.push(value);
      }
    }
    // CORRECTED 2026-08-27: caught live — this list grows with every contact
    // already processed at the account, so the last few contacts in a large
    // batch faced a much longer, harder differentiation prompt than the
    // first few, correlating with more guardrail retries needed for no
    // reason tied to that contact. Capped to the most recent N — recent
    // siblings are the ones a person is actually likely to compare notes
    // with anyway (enrolled around the same time).
    const MAX_SIBLING_SUBJECTS = 10;
    return subjects.slice(-MAX_SIBLING_SUBJECTS);
  } catch {
    return [];
  }
}

/** Email 2 — always generated, all 4 tiers use it. */
export async function generateBumpEmail(
  client: Anthropic,
  payload: WebhookPayload,
  original: GeneratedEmail,
): Promise<GeneratedEmail> {
  return generateWithGuardrail(
    client,
    BUMP_SYSTEM_PROMPT,
    buildFollowUpUserTurn(payload, original),
    FollowUpEmailSchema,
    BUMP_WORD_LIMIT,
    (parsed) => assembleFollowUp(parsed, payload.first_name),
  );
}

/** Email 3 — only Champion/Influencer cadences have this touch; caller skips it otherwise. */
export async function generateNewAngleEmail(
  client: Anthropic,
  payload: WebhookPayload,
  original: GeneratedEmail,
): Promise<GeneratedEmail> {
  return generateWithGuardrail(
    client,
    NEW_ANGLE_SYSTEM_PROMPT,
    buildFollowUpUserTurn(payload, original),
    FollowUpEmailSchema,
    NEW_ANGLE_WORD_LIMIT,
    (parsed) => assembleFollowUp(parsed, payload.first_name),
  );
}

/**
 * Email 4 — the "right person?" breakup email. ADDED 2026-08-27, all 4
 * tiers (every cadence ends on this step) — see personas.ts doc comment on
 * BREAKUP_SYSTEM_PROMPT for why this replaced a static template. Reuses
 * buildUserTurn rather than buildFollowUpUserTurn: this touch isn't
 * differentiating itself from one specific prior email's wording (like bump/
 * new-angle are), it just needs the base persona/company context to write a
 * generic, genre-typical close-out.
 */
export async function generateBreakupEmail(
  client: Anthropic,
  payload: WebhookPayload,
): Promise<GeneratedEmail> {
  return generateWithGuardrail(
    client,
    BREAKUP_SYSTEM_PROMPT,
    buildUserTurn(payload),
    FollowUpEmailSchema,
    BREAKUP_WORD_LIMIT,
    (parsed) => assembleFollowUp(parsed, payload.first_name),
  );
}

/**
 * LinkedIn Connect note — Champion/Influencer only, fires same day as Email 1.
 * Doesn't need the original email as context (no de-duplication concern —
 * the prompt already forbids pitching or naming the product), just persona
 * + signal context via buildUserTurn.
 */
export async function generateLinkedInConnectNote(
  client: Anthropic,
  payload: WebhookPayload,
): Promise<GeneratedEmail> {
  return generateWithGuardrail(
    client,
    LINKEDIN_CONNECT_SYSTEM_PROMPT,
    buildUserTurn(payload),
    LinkedInNoteSchema,
    50, // generous word cap — the real constraint is the character limit below
    assembleLinkedInNote,
    LINKEDIN_CONNECT_CHAR_LIMIT,
  );
}

/** LinkedIn Message — Champion/Influencer only, sent after the connect is presumably accepted. */
export async function generateLinkedInMessage(
  client: Anthropic,
  payload: WebhookPayload,
  original: GeneratedEmail,
): Promise<GeneratedEmail> {
  return generateWithGuardrail(
    client,
    LINKEDIN_MESSAGE_SYSTEM_PROMPT,
    buildFollowUpUserTurn(payload, original),
    LinkedInNoteSchema,
    LINKEDIN_MESSAGE_WORD_LIMIT,
    assembleLinkedInNote,
  );
}

/**
 * Internal call-prep note for Call 1 (Day 0) — Champion/Influencer only.
 * CORRECTED 2026-08-27: previously used buildUserTurn's bare context, with
 * no visibility into Email 1 or the LinkedIn connect note even though both
 * fire earlier the same day, ahead of the call — the rep had no summary of
 * what the prospect had already received. Now takes both as context.
 */
export async function generateCallPrepNote(
  client: Anthropic,
  payload: WebhookPayload,
  email: GeneratedEmail,
  linkedInConnectNote: GeneratedEmail | null,
): Promise<GeneratedEmail> {
  const touches = [{ label: "Email 1", email }];
  if (linkedInConnectNote) {
    touches.push({ label: "LinkedIn connect note", email: linkedInConnectNote });
  }
  return generateWithGuardrail(
    client,
    CALL_PREP_SYSTEM_PROMPT,
    buildTouchSummaryUserTurn(payload, touches),
    LinkedInNoteSchema,
    CALL_PREP_WORD_LIMIT,
    assembleLinkedInNote,
  );
}

/**
 * Internal call-prep note for Call 2 — Champion/Influencer only. CORRECTED
 * 2026-08-27: this call happens because Call 1 went unanswered specifically
 * (a second attempt on the same channel), not because every touch went
 * silent generically — Email 2, LinkedIn Message, and Email 3 have also
 * gone out unanswered by this point, but that's supporting context, not the
 * reason for the call. ADDED 2026-08-27: takes the full labeled list of
 * touches sent since Call 1 (bump, LinkedIn message, follow-up email — not
 * just the most recent one) so the note can summarize the whole thread, not
 * only the last touch.
 */
export async function generateFollowUpCallPrepNote(
  client: Anthropic,
  payload: WebhookPayload,
  touches: Array<{ label: string; email: GeneratedEmail }>,
): Promise<GeneratedEmail> {
  return generateWithGuardrail(
    client,
    CALL_PREP_FOLLOWUP_SYSTEM_PROMPT,
    buildTouchSummaryUserTurn(payload, touches),
    LinkedInNoteSchema,
    CALL_PREP_WORD_LIMIT,
    assembleLinkedInNote,
  );
}

export interface WriteBackResult {
  contactId: string;
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
 *
 * ADDED 2026-08-26: Apollo Workflows' Send Webhook merge-field picker has no
 * raw contact/person ID option (confirmed via live picker inspection) — only
 * named fields like first_name, title, account.name. So the payload now
 * carries email instead of contact_id, and this function resolves the real
 * id itself before the two calls below that need it.
 *
 * CORRECTED 2026-08-26: first attempt used /v1/people/match — confirmed
 * BLOCKED on this account (API_INACCESSIBLE, "not included in your
 * Organization (Trial) plan"), same restriction tier as the other blocked
 * search endpoints. /v1/contacts/search IS accessible (verified live,
 * clean empty result rather than a plan error) — makes sense, since anyone
 * this webhook fires for was already pulled into Apollo as a contact by the
 * Workflow, not looked up fresh against Apollo's global people database.
 * q_keywords is a general keyword search, not a strict equality filter, but
 * an exact email string is distinctive enough in practice to trust the top
 * result.
 */
export async function writeBackAndEnroll(
  env: Env,
  payload: WebhookPayload,
  email: GeneratedEmail,
  bumpEmail: GeneratedEmail,
  newAngleEmail: GeneratedEmail | null,
  linkedInConnectNote: GeneratedEmail | null,
  linkedInMessage: GeneratedEmail | null,
  callPrepNote: GeneratedEmail | null,
  followUpCallPrepNote: GeneratedEmail | null,
  breakupEmail: GeneratedEmail,
): Promise<WriteBackResult> {
  const matchResp = await fetch("https://api.apollo.io/api/v1/contacts/search", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", "x-api-key": env.APOLLO_MCP_TOKEN },
    body: JSON.stringify({ q_keywords: payload.email, per_page: 1 }),
  });
  if (!matchResp.ok) {
    throw new Error(
      `apollo contacts/search failed for ${payload.email}: HTTP ${matchResp.status} ${await matchResp.text()}`,
    );
  }
  const matchData: { contacts?: Array<{ id?: string }> } = await matchResp.json();
  const contactId = matchData.contacts?.[0]?.id;
  if (!contactId) {
    throw new Error(`apollo contacts/search returned no match for ${payload.email}`);
  }

  // Body field gets only the body text (subject goes to its own field —
  // email_subject_field_id — so the sequence template can merge it into
  // the actual Subject line). email.body already arrives greeting-prefixed
  // and "\n\n"-joined from assembleEmail() in Phase A — no further
  // transform needed here.
  const bodyForField = email.body;

  const updateFields: Record<string, string> = {
    [payload.email_body_field_id]: bodyForField,
    [payload.email_2_body_field_id]: bumpEmail.body,
    [payload.email_2_subject_field_id]: bumpEmail.subject,
    [payload.email_4_body_field_id]: breakupEmail.body,
    [payload.email_4_subject_field_id]: breakupEmail.subject,
  };
  if (payload.email_subject_field_id) {
    updateFields[payload.email_subject_field_id] = email.subject;
  }
  // Email 3, LinkedIn Connect Note, and LinkedIn Message only exist for
  // tiers whose cadence has those touches (Champion/Influencer) — caller
  // passes null when the payload didn't include those field ids, so nothing
  // gets written for tiers that don't need them.
  if (newAngleEmail && payload.email_3_body_field_id && payload.email_3_subject_field_id) {
    updateFields[payload.email_3_body_field_id] = newAngleEmail.body;
    updateFields[payload.email_3_subject_field_id] = newAngleEmail.subject;
  }
  if (linkedInConnectNote && payload.linkedin_connect_note_field_id) {
    updateFields[payload.linkedin_connect_note_field_id] = linkedInConnectNote.body;
  }
  if (linkedInMessage && payload.linkedin_message_field_id) {
    updateFields[payload.linkedin_message_field_id] = linkedInMessage.body;
  }
  if (callPrepNote && payload.call_prep_note_field_id) {
    updateFields[payload.call_prep_note_field_id] = callPrepNote.body;
  }
  if (followUpCallPrepNote && payload.call_prep_note_2_field_id) {
    updateFields[payload.call_prep_note_2_field_id] = followUpCallPrepNote.body;
  }

  const updateResp = await fetch(`https://api.apollo.io/api/v1/contacts/${contactId}`, {
    method: "PUT",
    headers: { "content-type": "application/json; charset=utf-8", "x-api-key": env.APOLLO_MCP_TOKEN },
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
        contact_ids: [contactId],
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

  return { contactId, wroteField: true, enrolled: true };
}
