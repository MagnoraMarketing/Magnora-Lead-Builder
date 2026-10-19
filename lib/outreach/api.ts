import type { AiErrorCode } from '@/lib/ai/outreach';
import { fail } from '@/lib/api/response';

/** Lead columns shown next to each message in the queue. */
export const MESSAGE_LEAD_SELECT =
  '*, lead:leads(id, full_name, job_title, company_name, linkedin_url)';

/** Drafting to a lead marked "Do not contact" is refused, by hand or by AI. */
export function doNotContact() {
  return fail(
    'do_not_contact',
    'This lead is marked "Do not contact". Change the status first if that is no longer right.',
    409,
  );
}

/** HTTP status for each AI failure, shared by every route that drafts with AI. */
export const AI_ERROR_STATUS: Record<AiErrorCode, number> = {
  ai_not_configured: 503,
  ai_auth_failed: 502,
  ai_rate_limited: 503,
  ai_unavailable: 502,
  ai_refused: 422,
  ai_invalid_output: 502,
  ai_request_rejected: 502,
};

export function aiNotConfigured() {
  return fail(
    'ai_not_configured',
    'AI drafting is not set up on this deployment. Add ANTHROPIC_API_KEY to the server environment.',
    503,
  );
}
