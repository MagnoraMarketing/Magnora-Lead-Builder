import { z } from 'zod';
import { COUNTRIES, COMPANY_SIZES, INDUSTRIES, LOCATIONS } from '@/lib/constants/search';
import { LEAD_STATUSES } from '@/lib/constants/leads';
import {
  CAMPAIGN_LANGUAGES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TONES,
  MESSAGE_CHANNELS,
  MESSAGE_MAX_LENGTH,
  MESSAGE_STATUSES,
} from '@/lib/constants/outreach';

const countryCodes = COUNTRIES.map((c) => c.code) as [string, ...string[]];
const companySizes = COMPANY_SIZES.map((c) => c.value) as [string, ...string[]];
const industries = INDUSTRIES.map((i) => i.value) as [string, ...string[]];

/** Free-text location values are allowed, so this validates shape not membership. */
const locationValue = z
  .string()
  .trim()
  .min(1, 'Location cannot be empty')
  .max(80, 'Location is too long');

export const jobTitleSchema = z
  .string()
  .trim()
  .min(2, 'Job title must be at least 2 characters')
  .max(60, 'Job title is too long');

export const createSearchSchema = z.object({
  jobTitles: z
    .array(jobTitleSchema)
    .min(1, 'Select at least one job title')
    .max(10, 'Select at most 10 job titles'),
  country: z.enum(countryCodes),
  location: locationValue.default('all'),
  companySize: z.enum(companySizes).default('any'),
  industry: z.enum(industries).default('all'),
  requestedCount: z
    .number()
    .int('Number of leads must be a whole number')
    .min(1, 'Request at least 1 lead')
    .max(2000, 'Request at most 2000 leads'),
});

export type CreateSearchInput = z.infer<typeof createSearchSchema>;

export const updateLeadSchema = z
  .object({
    full_name: z.string().trim().min(1).max(200),
    first_name: z.string().trim().max(100).nullable(),
    last_name: z.string().trim().max(100).nullable(),
    job_title: z.string().trim().max(200).nullable(),
    company_name: z.string().trim().max(200).nullable(),
    company_website: z.string().trim().url('Must be a valid URL').max(500).nullable(),
    company_linkedin_url: z.string().trim().url('Must be a valid URL').max(500).nullable(),
    linkedin_url: z.string().trim().url('Must be a valid URL').max(500).nullable(),
    location: z.string().trim().max(200).nullable(),
    country: z.string().trim().max(100).nullable(),
    industry: z.string().trim().max(100).nullable(),
    company_size: z.string().trim().max(50).nullable(),
    email: z.string().trim().email('Must be a valid email address').max(320).nullable(),
    phone: z.string().trim().max(50).nullable(),
    mobile_phone: z.string().trim().max(50).nullable(),
    status: z.enum(LEAD_STATUSES),
    notes: z.string().max(10000).nullable(),
    campaign_id: z.string().uuid().nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const bulkLeadActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('delete'),
    leadIds: z.array(z.string().uuid()).min(1, 'Select at least one lead').max(1000),
  }),
  z.object({
    action: z.literal('set_status'),
    leadIds: z.array(z.string().uuid()).min(1, 'Select at least one lead').max(1000),
    status: z.enum(LEAD_STATUSES),
  }),
  z.object({
    action: z.literal('set_campaign'),
    leadIds: z.array(z.string().uuid()).min(1, 'Select at least one lead').max(1000),
    campaignId: z.string().uuid().nullable(),
  }),
]);

export const leadListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  country: z.string().trim().max(100).optional(),
  industry: z.string().trim().max(100).optional(),
  jobId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  sort: z
    .enum(['created_at', 'full_name', 'company_name', 'job_title', 'status'])
    .default('created_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

export const exportLeadsSchema = z.object({
  mode: z.enum(['all', 'selected', 'filtered']),
  leadIds: z.array(z.string().uuid()).max(5000).optional(),
  filters: leadListQuerySchema.partial().optional(),
});

export const exportToDialerSchema = z.object({
  leadIds: z.array(z.string().uuid()).min(1, 'Select at least one lead').max(1000),
});

export const updateSettingsSchema = z.object({
  default_country: z.enum(countryCodes).optional(),
  default_job_titles: z.array(jobTitleSchema).max(10).optional(),
  default_location: locationValue.optional(),
  default_lead_limit: z.number().int().min(1).max(2000).optional(),
  max_lead_limit: z.number().int().min(1).max(2000).optional(),
  linkedin_account_email: z.string().trim().email().max(320).nullable().optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

/** Location value must belong to the selected country, or be free text. */
export function isKnownLocation(country: string, location: string): boolean {
  return LOCATIONS.some((l) => l.country === country && l.value === location);
}

// ---------------------------------------------------------------------------
//  Campaigns
// ---------------------------------------------------------------------------

/** Optional free text: blank means "not set" and is stored as null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .nullable()
    .transform((v) => (v === null || v === '' ? null : v));

const campaignFields = {
  name: z.string().trim().min(1, 'Give the campaign a name').max(120, 'Name is too long'),
  description: optionalText(2000),
  sender_name: optionalText(120),
  sender_company: optionalText(200),
  offer: optionalText(2000),
  call_to_action: optionalText(300),
  tone: z.enum(CAMPAIGN_TONES),
  language: z.enum(CAMPAIGN_LANGUAGES),
  status: z.enum(CAMPAIGN_STATUSES),
};

export const createCampaignSchema = z.object({
  ...campaignFields,
  description: campaignFields.description.optional(),
  sender_name: campaignFields.sender_name.optional(),
  sender_company: campaignFields.sender_company.optional(),
  offer: campaignFields.offer.optional(),
  call_to_action: campaignFields.call_to_action.optional(),
  tone: campaignFields.tone.default('professional'),
  language: campaignFields.language.default('da'),
  status: campaignFields.status.default('active'),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = z
  .object(campaignFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

// ---------------------------------------------------------------------------
//  Outreach messages
// ---------------------------------------------------------------------------

const messageChannel = z.enum(MESSAGE_CHANNELS);

const messageBody = z
  .string()
  .trim()
  .min(1, 'The message cannot be empty')
  .max(MESSAGE_MAX_LENGTH.direct_message, 'The message is too long');

/** A connection note has a much lower ceiling than a direct message. */
function fitsChannel(v: { channel?: string; body?: string }) {
  return !(
    v.channel === 'connection_request' &&
    v.body !== undefined &&
    v.body.length > MESSAGE_MAX_LENGTH.connection_request
  );
}

const connectionNoteTooLong = {
  message: `A connection request note can be at most ${MESSAGE_MAX_LENGTH.connection_request} characters.`,
  path: ['body'],
};

export const createMessageSchema = z
  .object({
    leadId: z.string().uuid(),
    campaignId: z.string().uuid().nullable().optional(),
    channel: messageChannel.default('connection_request'),
    body: messageBody,
  })
  .refine(fitsChannel, connectionNoteTooLong);

export const generateMessageSchema = z.object({
  leadId: z.string().uuid(),
  campaignId: z.string().uuid().nullable().optional(),
  channel: messageChannel.default('connection_request'),
  /** One-off guidance for this draft, e.g. "mention we are both in Aarhus". */
  instructions: z.string().trim().max(500, 'Keep instructions under 500 characters').optional(),
});

export type GenerateMessageInput = z.infer<typeof generateMessageSchema>;

/**
 * PATCH /api/messages/[id]. Either new text, or one explicit lifecycle action.
 * "mark_sent" is only ever sent by the "Mark as sent" button — copying the
 * text to the clipboard does not call the API at all.
 */
export const updateMessageSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('edit'), body: messageBody }),
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('unapprove') }),
  z.object({ action: z.literal('mark_sent') }),
  z.object({ action: z.literal('archive') }),
  z.object({ action: z.literal('restore') }),
]);

export type UpdateMessageInput = z.infer<typeof updateMessageSchema>;

export const messageListQuerySchema = z.object({
  status: z.enum(MESSAGE_STATUSES).optional(),
  campaignId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  /** `created` lists newest first by creation, as the Lead Builder table does. */
  sort: z.enum(['updated', 'created']).default('updated'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
//  CSV import
// ---------------------------------------------------------------------------

export const importLeadsSchema = z.object({
  /** Raw CSV text. Parsed and validated on the server, never trusted. */
  csv: z.string().min(1, 'The file is empty').max(2_000_000, 'The file is larger than 2 MB'),
  campaignId: z.string().uuid().nullable().optional(),
});

// ---------------------------------------------------------------------------
//  AI Lead Builder (the one-page flow: lead form → generate → review → save)
// ---------------------------------------------------------------------------

/** Treats a blank optional input as "not given" rather than as an invalid value. */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const builderLeadFields = {
  name: z.string().trim().min(1, 'Name is required').max(200, 'Name is too long'),
  role: z.string().trim().min(1, 'Role is required').max(200, 'Role is too long'),
  company: z.string().trim().min(1, 'Company is required').max(200, 'Company is too long'),
  linkedinUrl: z.preprocess(
    blankToUndefined,
    z.string().trim().url('Must be a valid URL').max(500).optional(),
  ),
  campaignId: z.string().uuid().nullable().optional(),
  channel: messageChannel.default('connection_request'),
};

/** POST /api/generate-message — drafts text for a lead that is not saved yet. */
export const builderGenerateSchema = z.object({
  ...builderLeadFields,
  instructions: z.preprocess(
    blankToUndefined,
    z.string().trim().max(500, 'Keep instructions under 500 characters').optional(),
  ),
});

export type BuilderGenerateInput = z.infer<typeof builderGenerateSchema>;

/** POST /api/builder — saves the lead and its reviewed message together, as a draft. */
export const builderSaveSchema = z
  .object({
    ...builderLeadFields,
    body: messageBody,
    source: z.enum(['ai', 'manual']),
    aiModel: z.string().trim().max(100).optional(),
  })
  .refine(fitsChannel, connectionNoteTooLong);

export type BuilderSaveInput = z.infer<typeof builderSaveSchema>;
