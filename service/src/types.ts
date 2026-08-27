/**
 * Payload shape the Apollo Workflow's webhook action fires once Stage 4
 * (tiering + enrichment) is complete. See the spec:
 * generation_and_enrollment_service.inputs_per_contact
 */
export interface WebhookPayload {
  email: string; // Apollo's Workflow webhook merge-field picker has no raw contact/person ID option
                  // (confirmed 2026-08-26 via live picker inspection) — resolved server-side to a
                  // real contact id via /v1/contacts/search before write-back
  tier: 1 | 2 | 3 | 4;
  first_name: string;
  title: string;
  company_name: string;

  // Account-level (Stage 2/3)
  why_now_rationale: string;
  company_news_digest?: string;

  // Person-level (Stage 4) — absent fields are simply omitted from the prompt
  person_linkedin_digest?: string;
  thought_leadership_digest?: string; // tiers 1-3 only, per stage_4 gating
  person_tone?: "data-driven" | "narrative";
  time_in_role?: string;
  previous_company?: string;

  // Where the generated body gets written and who gets enrolled
  email_body_field_id: string; // Apollo custom field id (manual_steps_checklist item 3)
  email_subject_field_id?: string; // separate field for the subject line — see 2026-08-25 fix; optional until created
  sequence_id: string; // one dedicated cadence per tier (1-4) — touches/timing/channel mix tailored per persona
  send_email_from_email_account_id: string; // confirmed live mailbox id, see execution_notes.sending_infra_confirmed_2026-08-25

  // ADDED 2026-08-26: Email 2 ("bump") and Email 3 ("new angle") follow-up
  // touches — shared fields across all 4 tiers/personas, not per-persona
  // duplicates. Email 2 is required (every cadence has this touch); Email 3
  // is optional since only Champion/Influencer cadences have that step —
  // Exec Sponsor/Technical Validator webhook bodies simply omit these two.
  email_2_body_field_id: string;
  email_2_subject_field_id: string;
  email_3_body_field_id?: string;
  email_3_subject_field_id?: string;

  // ADDED 2026-08-27: Email 4, the "right person?" breakup email — final
  // step in EVERY cadence (all 4 tiers), so required rather than optional
  // like Email 3. CORRECTED same day: this was previously a static
  // unpersonalized template (see personas.ts doc comment above
  // BREAKUP_SYSTEM_PROMPT for why that broke down at the buying-committee
  // scale) — now generated per-contact like every other touch.
  email_4_body_field_id: string;
  email_4_subject_field_id: string;

  // ADDED 2026-08-26: LinkedIn Connect Note (Day 0, alongside Email 1) and
  // LinkedIn Message (later touch, after the connect is presumably
  // accepted) — Champion/Influencer only, same optional-omit pattern as
  // Email 3. Exec Sponsor/Technical Validator's LinkedIn Connect step stays
  // blank (no note), so these two are never populated for those tiers.
  linkedin_connect_note_field_id?: string;
  linkedin_message_field_id?: string;

  // ADDED 2026-08-26: internal call-prep notes (Champion/Influencer only —
  // the only tiers with call steps). Rep-facing, not customer-facing.
  // Field 1 preps Call 1 (Day 0); field 2 preps Call 2 (after Email 2,
  // LinkedIn Message, and Email 3 have all gone out unanswered).
  call_prep_note_field_id?: string;
  call_prep_note_2_field_id?: string;
}

export interface GeneratedEmail {
  subject: string;
  body: string;
  wordCount: number;
}

export interface ValidationResult {
  valid: boolean;
  violations: string[];
}
