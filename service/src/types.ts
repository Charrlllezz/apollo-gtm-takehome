/**
 * Payload shape the Apollo Workflow's webhook action fires once Stage 4
 * (tiering + enrichment) is complete. See the spec:
 * generation_and_enrollment_service.inputs_per_contact
 */
export interface WebhookPayload {
  contact_id: string; // Apollo contact id — target of apollo_contacts_update
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
  sequence_id: string; // champion_influencer_cadence or exec_technical_cadence, per tier
  send_email_from_email_account_id: string; // confirmed live mailbox id, see execution_notes.sending_infra_confirmed_2026-08-25
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
