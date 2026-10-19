import type { Database } from './supabase';

export type Lead = Database['public']['Tables']['leads']['Row'];
export type LeadInsert = Database['public']['Tables']['leads']['Insert'];
export type LeadUpdate = Database['public']['Tables']['leads']['Update'];

export type ScrapingJob = Database['public']['Tables']['scraping_jobs']['Row'];
export type ScrapingJobInsert = Database['public']['Tables']['scraping_jobs']['Insert'];

export type JobLog = Database['public']['Tables']['job_logs']['Row'];
export type UserSettings = Database['public']['Tables']['user_settings']['Row'];

export type Campaign = Database['public']['Tables']['campaigns']['Row'];
export type OutreachMessage = Database['public']['Tables']['outreach_messages']['Row'];

/** A message with the lead fields the outreach queue shows next to it. */
export type OutreachMessageWithLead = OutreachMessage & {
  lead: Pick<Lead, 'id' | 'full_name' | 'job_title' | 'company_name' | 'linkedin_url'> | null;
};

export type CampaignSummary =
  Database['public']['Functions']['campaign_summaries']['Returns'][number];
export type OutreachStats = Database['public']['Functions']['outreach_stats']['Returns'][number];

export type DashboardStats = Database['public']['Functions']['dashboard_stats']['Returns'][number];

export type {
  JobStatusEnum as JobStatus,
  LeadStatusEnum as LeadStatus,
  MessageChannelEnum as MessageChannel,
  MessageStatusEnum as MessageStatus,
} from './supabase';
