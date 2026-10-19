/**
 * Database schema types.
 *
 * Hand-written to match supabase/migrations/. Keeping this in sync with the
 * SQL is what makes every query in the app type-checked — a renamed column
 * becomes a build error rather than a runtime surprise.
 *
 * Regenerate with:
 *   npx supabase gen types typescript --project-id <ref> > types/supabase.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type JobStatusEnum = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type LeadStatusEnum =
  | 'new'
  | 'qualified'
  | 'contacted'
  | 'interested'
  | 'meeting'
  | 'not_interested'
  | 'invalid'
  | 'do_not_contact';

export type LogLevelEnum = 'info' | 'warn' | 'error';

export type CampaignStatusEnum = 'active' | 'paused' | 'archived';

export type MessageStatusEnum = 'draft' | 'approved' | 'sent' | 'archived';

export type MessageChannelEnum = 'connection_request' | 'direct_message';

type LeadRow = {
  id: string;
  user_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  company_name: string | null;
  company_website: string | null;
  company_linkedin_url: string | null;
  linkedin_url: string | null;
  location: string | null;
  country: string | null;
  industry: string | null;
  company_size: string | null;
  email: string | null;
  phone: string | null;
  mobile_phone: string | null;
  source: string;
  source_url: string | null;
  status: LeadStatusEnum;
  notes: string | null;
  job_id: string | null;
  campaign_id: string | null;
  enrichment_status: 'pending' | 'found' | 'not_found' | 'failed' | null;
  enriched_at: string | null;
  cvr_number: string | null;
  cvr_person_id: string | null;
  company_address: string | null;
  company_phone: string | null;
  company_email: string | null;
  created_at: string;
  updated_at: string;
};

type CampaignRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  sender_name: string | null;
  sender_company: string | null;
  offer: string | null;
  call_to_action: string | null;
  tone: 'professional' | 'friendly' | 'direct';
  language: 'da' | 'en';
  status: CampaignStatusEnum;
  created_at: string;
  updated_at: string;
};

type OutreachMessageRow = {
  id: string;
  user_id: string;
  lead_id: string;
  campaign_id: string | null;
  channel: MessageChannelEnum;
  body: string;
  status: MessageStatusEnum;
  source: 'ai' | 'manual';
  ai_model: string | null;
  edited: boolean;
  approved_at: string | null;
  sent_at: string | null;
  kind: 'initial' | 'follow_up' | 'reply';
  sequence_step: number | null;
  scheduled_for: string | null;
  created_at: string;
  updated_at: string;
};

type CampaignStepRow = {
  id: string;
  user_id: string;
  campaign_id: string;
  step_number: number;
  delay_days: number;
  topic: string | null;
  channel: MessageChannelEnum;
  created_at: string;
  updated_at: string;
};

type LeadReplyRow = {
  id: string;
  user_id: string;
  lead_id: string;
  body: string;
  received_at: string;
  created_at: string;
};

export type FollowUpStatusEnum = 'pending' | 'drafted' | 'done' | 'cancelled';

type FollowUpTaskRow = {
  id: string;
  user_id: string;
  lead_id: string;
  campaign_id: string | null;
  step_number: number | null;
  topic: string | null;
  channel: MessageChannelEnum;
  due_at: string;
  status: FollowUpStatusEnum;
  message_id: string | null;
  created_at: string;
  updated_at: string;
};

type EnrichmentRequestRow = {
  id: string;
  user_id: string;
  lead_id: string;
  provider: string;
  status: 'pending' | 'completed' | 'failed';
  webhook_token: string | null;
  phone_requested: boolean;
  response: Json | null;
  webhook_payload: Json | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

type ScrapingJobRow = {
  id: string;
  user_id: string;
  status: JobStatusEnum;
  job_titles: string[];
  country: string;
  location: string | null;
  company_size: string | null;
  industry: string | null;
  requested_count: number;
  found_count: number;
  duplicate_count: number;
  processed_count: number;
  cancel_requested: boolean;
  error_message: string | null;
  error_code: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  worker_id: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
};

type JobLogRow = {
  id: number;
  job_id: string;
  user_id: string;
  level: LogLevelEnum;
  event: string;
  message: string | null;
  created_at: string;
};

type UserSettingsRow = {
  user_id: string;
  default_country: string;
  default_job_titles: string[];
  default_location: string;
  default_lead_limit: number;
  max_lead_limit: number;
  linkedin_account_email: string | null;
  created_at: string;
  updated_at: string;
};

/** Columns the client is allowed to set; generated and server-managed ones are omitted. */
type Insertable<T, Required extends keyof T> = Partial<Omit<T, Required>> & Pick<T, Required>;

export type Database = {
  public: {
    Tables: {
      leads: {
        Row: LeadRow;
        Insert: Insertable<LeadRow, 'user_id' | 'full_name'>;
        Update: Partial<Omit<LeadRow, 'id' | 'user_id'>>;
        Relationships: [];
      };
      scraping_jobs: {
        Row: ScrapingJobRow;
        Insert: Insertable<
          ScrapingJobRow,
          'user_id' | 'job_titles' | 'country' | 'requested_count'
        >;
        Update: Partial<Omit<ScrapingJobRow, 'id' | 'user_id'>>;
        Relationships: [];
      };
      job_logs: {
        Row: JobLogRow;
        Insert: Insertable<JobLogRow, 'job_id' | 'user_id' | 'event'>;
        Update: Partial<Omit<JobLogRow, 'id'>>;
        Relationships: [];
      };
      user_settings: {
        Row: UserSettingsRow;
        Insert: Insertable<UserSettingsRow, 'user_id'>;
        Update: Partial<Omit<UserSettingsRow, 'user_id'>>;
        Relationships: [];
      };
      campaigns: {
        Row: CampaignRow;
        Insert: Insertable<CampaignRow, 'user_id' | 'name'>;
        Update: Partial<Omit<CampaignRow, 'id' | 'user_id'>>;
        Relationships: [];
      };
      campaign_steps: {
        Row: CampaignStepRow;
        Insert: Insertable<CampaignStepRow, 'user_id' | 'campaign_id' | 'step_number' | 'delay_days'>;
        Update: Partial<Omit<CampaignStepRow, 'id' | 'user_id'>>;
        Relationships: [];
      };
      lead_replies: {
        Row: LeadReplyRow;
        Insert: Insertable<LeadReplyRow, 'user_id' | 'lead_id' | 'body'>;
        Update: Partial<Omit<LeadReplyRow, 'id' | 'user_id' | 'lead_id'>>;
        Relationships: [
          {
            foreignKeyName: 'lead_replies_lead_fk';
            columns: ['lead_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'leads';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      follow_up_tasks: {
        Row: FollowUpTaskRow;
        Insert: Insertable<FollowUpTaskRow, 'user_id' | 'lead_id' | 'due_at'>;
        Update: Partial<Omit<FollowUpTaskRow, 'id' | 'user_id' | 'lead_id'>>;
        Relationships: [
          {
            foreignKeyName: 'follow_up_tasks_lead_fk';
            columns: ['lead_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'leads';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      enrichment_requests: {
        Row: EnrichmentRequestRow;
        Insert: Insertable<EnrichmentRequestRow, 'user_id' | 'lead_id' | 'provider'>;
        Update: Partial<Omit<EnrichmentRequestRow, 'id' | 'user_id' | 'lead_id'>>;
        Relationships: [];
      };
      outreach_messages: {
        Row: OutreachMessageRow;
        Insert: Insertable<OutreachMessageRow, 'user_id' | 'lead_id' | 'body'>;
        Update: Partial<Omit<OutreachMessageRow, 'id' | 'user_id' | 'lead_id'>>;
        Relationships: [
          {
            foreignKeyName: 'outreach_messages_lead_fk';
            columns: ['lead_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'leads';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      dashboard_stats: {
        Args: Record<string, never>;
        Returns: {
          total_leads: number;
          new_leads: number;
          qualified_leads: number;
          contacted_leads: number;
          meeting_leads: number;
          interested_leads: number;
          running_jobs: number;
        }[];
      };
      outreach_stats: {
        Args: Record<string, never>;
        Returns: {
          draft_messages: number;
          approved_messages: number;
          sent_messages: number;
          active_campaigns: number;
        }[];
      };
      campaign_summaries: {
        Args: Record<string, never>;
        Returns: {
          campaign_id: string;
          lead_count: number;
          draft_messages: number;
          approved_messages: number;
          sent_messages: number;
        }[];
      };
      import_leads: {
        Args: { p_rows: Json; p_campaign_id?: string | null };
        Returns: { inserted: number; skipped: number }[];
      };
      import_cvr_leads: {
        Args: { p_rows: Json; p_campaign_id?: string | null };
        Returns: { inserted: number; skipped: number }[];
      };
      check_rate_limit: {
        Args: {
          p_user_id: string;
          p_bucket: string;
          p_limit: number;
          p_window_seconds: number;
        };
        Returns: boolean;
      };
    };
    Enums: {
      job_status: JobStatusEnum;
      lead_status: LeadStatusEnum;
      log_level: LogLevelEnum;
      campaign_status: CampaignStatusEnum;
      message_status: MessageStatusEnum;
      message_channel: MessageChannelEnum;
    };
    CompositeTypes: Record<string, never>;
  };
};
