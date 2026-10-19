export const MESSAGE_STATUSES = ['draft', 'approved', 'sent', 'archived'] as const;

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  sent: 'Sent',
  archived: 'Archived',
};

export const MESSAGE_STATUS_STYLES: Record<MessageStatus, string> = {
  draft: 'bg-slate-100 text-slate-700 ring-slate-200',
  approved: 'bg-blue-50 text-blue-700 ring-blue-200',
  sent: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  archived: 'bg-stone-100 text-stone-600 ring-stone-200',
};

export const MESSAGE_CHANNELS = ['connection_request', 'direct_message'] as const;

export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const MESSAGE_CHANNEL_LABELS: Record<MessageChannel, string> = {
  connection_request: 'Connection request note',
  direct_message: 'Direct message',
};

/**
 * Hard limits, mirrored by CHECK constraints in 0005_campaigns_and_outreach.sql.
 * LinkedIn itself refuses a connection note over 300 characters.
 */
export const MESSAGE_MAX_LENGTH: Record<MessageChannel, number> = {
  connection_request: 300,
  direct_message: 8000,
};

/**
 * What the generator aims for. A direct message can be long, but a cold one
 * that is should not be, so the AI target is far below the hard limit.
 */
export const MESSAGE_TARGET_LENGTH: Record<MessageChannel, number> = {
  connection_request: 280,
  direct_message: 900,
};

export const CAMPAIGN_STATUSES = ['active', 'paused', 'archived'] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

export const CAMPAIGN_STATUS_STYLES: Record<CampaignStatus, string> = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  paused: 'bg-amber-50 text-amber-700 ring-amber-200',
  archived: 'bg-stone-100 text-stone-600 ring-stone-200',
};

export const CAMPAIGN_TONES = ['professional', 'friendly', 'direct'] as const;

export type CampaignTone = (typeof CAMPAIGN_TONES)[number];

export const CAMPAIGN_TONE_LABELS: Record<CampaignTone, string> = {
  professional: 'Professional',
  friendly: 'Friendly',
  direct: 'Direct',
};

export const CAMPAIGN_LANGUAGES = ['da', 'en'] as const;

export type CampaignLanguage = (typeof CAMPAIGN_LANGUAGES)[number];

export const CAMPAIGN_LANGUAGE_LABELS: Record<CampaignLanguage, string> = {
  da: 'Danish',
  en: 'English',
};
