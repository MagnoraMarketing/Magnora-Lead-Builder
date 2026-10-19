-- ============================================================================
--  Campaigns, AI-drafted outreach messages, and CSV import
--
--  Purely additive: new types, new tables, one nullable column on `leads`, a
--  unique constraint on leads (id, user_id) and new functions. Nothing existing
--  is dropped, renamed or rewritten, so it is safe on a database that already
--  holds leads.
--
--  Ownership is enforced twice, as everywhere else in the schema:
--    1. RLS policies compare auth.uid() to user_id.
--    2. Composite foreign keys — (lead_id, user_id) → leads (id, user_id) and
--       (campaign_id, user_id) → campaigns (id, user_id) — make it impossible
--       for a row to point at another user's lead or campaign, even through
--       the service role, which bypasses RLS.
-- ============================================================================

create type campaign_status as enum ('active', 'paused', 'archived');

create type message_status as enum ('draft', 'approved', 'sent', 'archived');

-- LinkedIn caps a connection-request note at 300 characters; a direct message
-- to a connection can be much longer.
create type message_channel as enum ('connection_request', 'direct_message');

-- Lets child tables reference (id, user_id) so ownership is part of the key.
alter table leads add constraint leads_id_user_id_key unique (id, user_id);

-- ---------------------------------------------------------------------------
--  campaigns — groups leads and holds the context the AI writes from.
--
--  Everything the message generator may say about the sender comes from here,
--  typed in by the user. The generator is never asked to research anything.
-- ---------------------------------------------------------------------------

create table campaigns (
  id              uuid            primary key default uuid_generate_v4(),
  user_id         uuid            not null references auth.users (id) on delete cascade,
  name            text            not null,
  description     text,
  sender_name     text,
  sender_company  text,
  offer           text,
  call_to_action  text,
  tone            text            not null default 'professional',
  language        text            not null default 'da',
  status          campaign_status not null default 'active',
  created_at      timestamptz     not null default now(),
  updated_at      timestamptz     not null default now(),

  constraint campaigns_id_user_id_key unique (id, user_id),
  constraint campaigns_name_not_blank check (length(btrim(name)) between 1 and 120),
  constraint campaigns_tone_valid check (tone in ('professional', 'friendly', 'direct')),
  constraint campaigns_language_valid check (language in ('da', 'en')),
  constraint campaigns_offer_length check (offer is null or char_length(offer) <= 2000),
  constraint campaigns_description_length
    check (description is null or char_length(description) <= 2000),
  constraint campaigns_cta_length
    check (call_to_action is null or char_length(call_to_action) <= 300)
);

create trigger campaigns_set_updated_at
  before update on campaigns
  for each row execute function set_updated_at();

create unique index campaigns_user_name_uniq on campaigns (user_id, lower(btrim(name)));
create index campaigns_user_created_idx on campaigns (user_id, created_at desc);

-- ---------------------------------------------------------------------------
--  leads.campaign_id — optional assignment. Deleting a campaign leaves the
--  leads in place and clears only the column (PostgreSQL 15+ column list).
-- ---------------------------------------------------------------------------

alter table leads add column campaign_id uuid;

alter table leads
  add constraint leads_campaign_fk
  foreign key (campaign_id, user_id) references campaigns (id, user_id)
  on delete set null (campaign_id);

create index leads_user_campaign_idx on leads (user_id, campaign_id);

-- ---------------------------------------------------------------------------
--  outreach_messages — one row per drafted LinkedIn message.
--
--  Lifecycle: draft → approved → sent. `archived` parks a draft or an
--  approved message. The guard trigger below owns every transition, so the
--  rules hold no matter which client writes the row:
--    * a new row always starts as a draft;
--    * editing an approved message's text sends it back to draft — approval
--      belongs to the exact words that were approved;
--    * only an approved message can be marked sent, and only by an explicit
--      status change — copying text to the clipboard never touches the row;
--    * a sent message is a record of what went out and cannot be edited or
--      moved to another status.
-- ---------------------------------------------------------------------------

create table outreach_messages (
  id           uuid            primary key default uuid_generate_v4(),
  user_id      uuid            not null references auth.users (id) on delete cascade,
  lead_id      uuid            not null,
  campaign_id  uuid,
  channel      message_channel not null default 'connection_request',
  body         text            not null,
  status       message_status  not null default 'draft',
  source       text            not null default 'manual',
  ai_model     text,
  edited       boolean         not null default false,
  approved_at  timestamptz,
  sent_at      timestamptz,
  created_at   timestamptz     not null default now(),
  updated_at   timestamptz     not null default now(),

  constraint outreach_messages_lead_fk
    foreign key (lead_id, user_id) references leads (id, user_id) on delete cascade,
  constraint outreach_messages_campaign_fk
    foreign key (campaign_id, user_id) references campaigns (id, user_id)
    on delete set null (campaign_id),

  constraint outreach_messages_body_not_blank check (length(btrim(body)) > 0),
  constraint outreach_messages_body_max check (char_length(body) <= 8000),
  constraint outreach_messages_connection_note_max
    check (channel <> 'connection_request' or char_length(body) <= 300),
  constraint outreach_messages_source_valid check (source in ('ai', 'manual')),
  constraint outreach_messages_approved_stamp
    check (status not in ('approved', 'sent') or approved_at is not null),
  constraint outreach_messages_sent_stamp check ((status = 'sent') = (sent_at is not null))
);

create index outreach_messages_user_status_idx
  on outreach_messages (user_id, status, updated_at desc);
create index outreach_messages_lead_idx on outreach_messages (lead_id, created_at desc);
create index outreach_messages_campaign_idx on outreach_messages (user_id, campaign_id);

create or replace function outreach_messages_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A new message must start as a draft.'
        using errcode = 'check_violation';
    end if;
    new.approved_at := null;
    new.sent_at := null;
    new.edited := false;
    return new;
  end if;

  -- Sent is final: the row is the record of what was actually sent.
  if old.status = 'sent' then
    if new.body is distinct from old.body
       or new.status is distinct from old.status
       or new.channel is distinct from old.channel then
      raise exception 'A sent message cannot be changed.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.body is distinct from old.body then
    if new.source = 'ai' then
      new.edited := true;
    end if;
    -- Approval covers the exact text. New text needs a new approval.
    if old.status = 'approved' and new.status = 'approved' then
      new.status := 'draft';
    end if;
  end if;

  if new.status = 'sent' and old.status <> 'approved' then
    raise exception 'Only an approved message can be marked as sent.'
      using errcode = 'check_violation';
  end if;

  -- Timestamps follow the status; clients cannot set them directly.
  if new.status = 'approved' and old.status <> 'approved' then
    new.approved_at := now();
  elsif new.status = 'sent' then
    new.approved_at := old.approved_at;
    new.sent_at := now();
  elsif new.status = 'draft' then
    new.approved_at := null;
  elsif new.status = 'approved' then
    new.approved_at := old.approved_at;
  end if;

  if new.status <> 'sent' then
    new.sent_at := null;
  end if;

  return new;
end;
$$;

create trigger outreach_messages_guard
  before insert or update on outreach_messages
  for each row execute function outreach_messages_guard();

create trigger outreach_messages_set_updated_at
  before update on outreach_messages
  for each row execute function set_updated_at();

-- Marking a message sent is the user saying "I sent this", so a lead still at
-- `new` or `qualified` moves to `contacted`. Later statuses are left alone —
-- a lead already at `meeting` has not gone backwards.
create or replace function outreach_messages_mark_lead_contacted()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'sent' and old.status <> 'sent' then
    update leads
       set status = 'contacted'
     where id = new.lead_id
       and user_id = new.user_id
       and status in ('new', 'qualified');
  end if;
  return new;
end;
$$;

create trigger outreach_messages_mark_lead_contacted
  after update on outreach_messages
  for each row execute function outreach_messages_mark_lead_contacted();

-- ---------------------------------------------------------------------------
--  Row Level Security
-- ---------------------------------------------------------------------------

alter table campaigns         enable row level security;
alter table outreach_messages enable row level security;

create policy campaigns_select on campaigns
  for select to authenticated using (auth.uid() = user_id);
create policy campaigns_insert on campaigns
  for insert to authenticated with check (auth.uid() = user_id);
create policy campaigns_update on campaigns
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy campaigns_delete on campaigns
  for delete to authenticated using (auth.uid() = user_id);

create policy outreach_messages_select on outreach_messages
  for select to authenticated using (auth.uid() = user_id);
create policy outreach_messages_insert on outreach_messages
  for insert to authenticated with check (auth.uid() = user_id);
create policy outreach_messages_update on outreach_messages
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy outreach_messages_delete on outreach_messages
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
--  outreach_stats — dashboard counters. SECURITY INVOKER, so RLS applies.
-- ---------------------------------------------------------------------------

create or replace function outreach_stats()
returns table (
  draft_messages    bigint,
  approved_messages bigint,
  sent_messages     bigint,
  active_campaigns  bigint
)
language sql
stable
as $$
  select
    (select count(*) from outreach_messages where user_id = auth.uid() and status = 'draft'),
    (select count(*) from outreach_messages where user_id = auth.uid() and status = 'approved'),
    (select count(*) from outreach_messages where user_id = auth.uid() and status = 'sent'),
    (select count(*) from campaigns where user_id = auth.uid() and status = 'active');
$$;

-- ---------------------------------------------------------------------------
--  campaign_summaries — per-campaign counts for /campaigns in one round trip.
-- ---------------------------------------------------------------------------

create or replace function campaign_summaries()
returns table (
  campaign_id       uuid,
  lead_count        bigint,
  draft_messages    bigint,
  approved_messages bigint,
  sent_messages     bigint
)
language sql
stable
as $$
  select
    c.id,
    (select count(*) from leads l where l.user_id = auth.uid() and l.campaign_id = c.id),
    (select count(*) from outreach_messages m
      where m.user_id = auth.uid() and m.campaign_id = c.id and m.status = 'draft'),
    (select count(*) from outreach_messages m
      where m.user_id = auth.uid() and m.campaign_id = c.id and m.status = 'approved'),
    (select count(*) from outreach_messages m
      where m.user_id = auth.uid() and m.campaign_id = c.id and m.status = 'sent')
  from campaigns c
  where c.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
--  import_leads — bulk insert from a validated CSV upload.
--
--  SECURITY INVOKER: it runs as the signed-in user, so RLS applies and every
--  row is stamped with auth.uid() — a caller cannot import into another
--  account. `on conflict do nothing` lets the three duplicate-detection
--  indexes decide what already exists, exactly as they do for the scraper;
--  duplicates are skipped, never overwritten.
--
--  The rows are validated in lib/leads/csv-import.ts first. The database
--  constraints are the backstop.
-- ---------------------------------------------------------------------------

create or replace function import_leads(p_rows jsonb, p_campaign_id uuid default null)
returns table (inserted integer, skipped integer)
language plpgsql
as $$
declare
  v_user     uuid := auth.uid();
  v_total    integer;
  v_inserted integer;
begin
  if v_user is null then
    raise exception 'Not authenticated.' using errcode = 'insufficient_privilege';
  end if;

  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array.' using errcode = 'invalid_parameter_value';
  end if;

  v_total := jsonb_array_length(p_rows);
  if v_total > 1000 then
    raise exception 'At most 1000 rows per import.' using errcode = 'program_limit_exceeded';
  end if;

  with ins as (
    insert into leads (
      user_id, full_name, first_name, last_name, job_title, company_name,
      company_website, company_linkedin_url, linkedin_url, location, country,
      industry, company_size, email, phone, mobile_phone, status, notes,
      source, campaign_id
    )
    select
      v_user, r.full_name, r.first_name, r.last_name, r.job_title, r.company_name,
      r.company_website, r.company_linkedin_url, r.linkedin_url, r.location, r.country,
      r.industry, r.company_size, r.email, r.phone, r.mobile_phone,
      coalesce(r.status, 'new')::lead_status, r.notes,
      'csv_import', p_campaign_id
    from jsonb_to_recordset(p_rows) as r (
      full_name text, first_name text, last_name text, job_title text,
      company_name text, company_website text, company_linkedin_url text,
      linkedin_url text, location text, country text, industry text,
      company_size text, email text, phone text, mobile_phone text,
      status text, notes text
    )
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from ins;

  return query select v_inserted, v_total - v_inserted;
end;
$$;

-- Browser sessions (authenticated) may call these; anonymous callers may not.
revoke execute on function outreach_stats() from public, anon;
revoke execute on function campaign_summaries() from public, anon;
revoke execute on function import_leads(jsonb, uuid) from public, anon;
grant execute on function outreach_stats() to authenticated;
grant execute on function campaign_summaries() to authenticated;
grant execute on function import_leads(jsonb, uuid) to authenticated;
