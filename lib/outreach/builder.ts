import { splitName } from '@/lib/leads/dedupe';
import type { LeadFacts } from '@/lib/outreach/prompt';

/** The lead fields the AI Lead Builder form collects. */
export interface BuilderLead {
  name: string;
  role: string;
  company: string;
  linkedinUrl?: string;
}

/**
 * Turns the form into the facts the generator may use. Only what the user
 * typed is passed on — the LinkedIn URL is kept for reference but not given to
 * the model, since it cannot open it and must not pretend it did.
 */
export function builderLeadToFacts(lead: BuilderLead): LeadFacts {
  const { firstName } = splitName(lead.name);
  return {
    full_name: lead.name,
    first_name: firstName,
    job_title: lead.role,
    company_name: lead.company,
    company_website: null,
    location: null,
    country: null,
    industry: null,
    company_size: null,
    notes: null,
  };
}
