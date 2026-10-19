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
