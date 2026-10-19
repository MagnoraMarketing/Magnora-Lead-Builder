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

export type CampaignStep = Database['public']['Tables']['campaign_steps']['Row'];
export type LeadReply = Database['public']['Tables']['lead_replies']['Row'];
export type FollowUpTask = Database['public']['Tables']['follow_up_tasks']['Row'];
export type EnrichmentRequest = Database['public']['Tables']['enrichment_requests']['Row'];

/** A follow-up task with the lead fields the Today list shows. */
export type FollowUpTaskWithLead = FollowUpTask & {
  lead: Pick<
    Lead,
    'id' | 'full_name' | 'job_title' | 'company_name' | 'linkedin_url' | 'status'
  > | null;
};

/** A reply with the lead it came from, for the Today list. */
export type LeadReplyWithLead = LeadReply & {
  lead: Pick<Lead, 'id' | 'full_name' | 'job_title' | 'company_name' | 'linkedin_url' | 'status'> | null;
};

/** Everything that needs the user today, from GET /api/today. */
export interface TodayOverview {
  followUps: (FollowUpTaskWithLead & { message: OutreachMessage | null })[];
  readyToSend: OutreachMessageWithLead[];
  awaitingAnswer: LeadReplyWithLead[];
}

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
