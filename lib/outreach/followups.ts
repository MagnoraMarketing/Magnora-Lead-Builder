/** Lead columns shown next to each follow-up. */
export const FOLLOW_UP_LEAD_SELECT =
  '*, lead:leads(id, full_name, job_title, company_name, linkedin_url, status)';

/** End of "today" when the browser did not say: the next 24 hours. */
export function defaultUntil(now = new Date()): string {
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}
