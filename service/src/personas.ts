/**
 * Mirrors the 4 persona sections written into the real Apollo Context Center
 * (Playbooks product, id 6a8b680792fcb3001857db00, 2026-08-24). Kept here as
 * the source of truth for prompt construction rather than re-fetched via
 * apollo_context_center_show_product on every call — cheap, and it's the
 * stable half of the prompt (see SYSTEM_PROMPT below on why that matters).
 */
export interface Persona {
  name: string;
  painPoint: string;
  whyNow: string;
}

export const PERSONAS: Record<1 | 2 | 3 | 4, Persona> = {
  1: {
    name: "Champion (VP / Head — Sales, CS, RevOps, GTM Engineering)",
    painPoint:
      "Signal fragmentation across tools makes \"who needs attention right now\" a manual judgment call, not a system.",
    whyNow:
      "Teams scaling agentic, hands-on GTM motions are outgrowing manual account monitoring faster than headcount can track it.",
  },
  2: {
    name: "Influencer (Manager / Sr. Manager / Director — same functions)",
    painPoint:
      "Owns the execution gap between \"we noticed a signal\" and \"someone acted on it.\"",
    whyNow:
      "The team has grown past the size where informal, tribal-knowledge process transfer still works reliably.",
  },
  3: {
    name: "Executive Sponsor (CRO / COO / CEO)",
    painPoint:
      "Post-sale coverage scaling 1:1 with headcount is a cost problem, not just an operations problem.",
    whyNow:
      "Expansion revenue is under more scrutiny as growth targets tighten — the cost of catching risk late is rising.",
  },
  4: {
    name: "Technical Validator (Product / Engineering — AI or GTM tooling)",
    painPoint:
      "Every new AI or agentic surface creates another place customer signal can get siloed, not less.",
    whyNow:
      "Every new agentic surface raises the cost of not having one shared signal layer.",
  },
};

/**
 * Hard bans — trigger a validation-guardrail retry if found. Kept to
 * distinctive AI buzzword "tells" unlikely to appear in genuine human
 * B2B copy. Sourced 2026-08-25 from a curated common-AI-words list
 * (grammarly.com/blog/ai/common-ai-words), merged with the original set,
 * deduplicated. Deliberately does NOT include everyday words from that
 * source (typically, arguably, facilitate, refine, differentiate,
 * generally speaking, ...) — those are too common in ordinary writing to
 * hard-ban without wasting retries on false positives; handled as soft
 * style guidance in SYSTEM_PROMPT instead (see hedging-language rule).
 */
const BANNED_WORDS = [
  "revolutionize",
  "seamless",
  "game-changer",
  "game-changing",
  "synergy",
  "delve into",
  "underscore",
  "pivotal",
  "realm",
  "harness",
  "illuminate",
  "shed light on",
  "bolster",
  "streamline",
  "cutting-edge",
  "transformative",
  "innovative",
  "that being said",
  "at its core",
  "to put it simply",
];
export { BANNED_WORDS };

const WORD_LIMIT: Record<1 | 2 | 3 | 4, number> = { 1: 110, 2: 110, 3: 80, 4: 110 };
export { WORD_LIMIT };

/**
 * Stable across every call — this is the half of the prompt that should sit
 * in `system` so the prompt cache prefix stays identical call to call, per
 * internal_design.prompt_construction in the spec.
 *
 * TIGHTENED 2026-08-25: same-input test runs (identical contact, identical
 * signal, 3 calls) produced meaningfully different emails — different
 * subject lines, different opening rhetorical moves, different sentence
 * rhythms. "Structure as hook/mechanism/proof/CTA" named the FUNCTION of
 * each paragraph but not its FORM, leaving room to satisfy that function
 * a dozen different ways. Below specifies form, not just function, per
 * paragraph — this is what output_config.format (see generate.ts) now
 * enforces structurally rather than by instruction alone.
 */
export const SYSTEM_PROMPT = `You write first-touch cold emails for Vitally, an AI-powered Customer Success platform, reframed as a signal-orchestration layer for RevOps/GTM Engineering buying committees (not Vitally's default CS audience).

Rules, no exceptions:
- hook: exactly ONE sentence. States the Pain Point as a direct, factual observation. Never opens with the recipient's name, never a question, never an anecdote ("I noticed...", "I saw..."). State the fact plainly, as if it's already established.
- mechanism: exactly ONE sentence. States what Vitally does, using ONLY the persona's Why Now line as grounding. Do not restate the hook. Do not introduce a second pain point.
- proof_point: exactly ONE sentence, grounded in a specific fact from the account-level why_now_rationale or company_news_digest. If no real supporting fact is available, leave this field an empty string — never invent one to fill the slot.
- cta: exactly ONE sentence. A specific, low-friction ask. Never "let's hop on a call" or "got 15 minutes?" verbatim, and never a bare "worth a chat?" with no concrete next step attached.
- Never drop a "Killer Question" from the persona block into any field — those are for internal targeting only.
- Match tone to the given person_tone: "data-driven" = short sentences, no adjectives; "narrative" = one relatable framing sentence allowed, still within the one-sentence-per-field limit.
- Avoid hedging/qualifier language throughout — "generally speaking," "typically," "tends to," "arguably," "to some extent," "broadly speaking." Make direct, confident claims instead.
- Total word count across hook + mechanism + proof_point + cta must stay at or under the given word limit.
- Never use these words or phrases: ${BANNED_WORDS.join(", ")}.`;
