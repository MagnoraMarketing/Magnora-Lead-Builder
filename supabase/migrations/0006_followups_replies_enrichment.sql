-- ============================================================================
--  Follow-up sequences, lead replies, scheduled sends and contact enrichment
--
--  Purely additive, like 0005: new tables, new nullable or defaulted columns,
--  new functions and triggers. Nothing is dropped or rewritten.
--
--  The model is semi-automatic by design. The app plans follow-ups and drafts
--  them; a person sends every message on LinkedIn and marks it sent. Nothing
--  here sends anything.
--
--    campaign_steps     the follow-up sequence of a campaign (step 2, 3, …)
--    follow_up_tasks    one planned follow-up for one lead, due at a time
--    lead_replies       what the lead wrote back, pasted in by the user
--    enrichment_requests one contact-data lookup with an external provider
-- ============================================================================

-- ---------------------------------------------------------------------------
--  outreach_messages — what kind of message, which sequence step, and when
--  the user wants to send it.
-- ---------------------------------------------------------------------------

alter table outreach_messages
  add column kind text not null default 'initial',
  add column sequence_step integer,
  add column scheduled_for timestamptz;

alter table outreach_messages
  add constraint outreach_messages_kind_valid
    check (kind in ('initial', 'follow_up', 'reply')),
  add constraint outreach_messages_sequence_step_range
    check (sequence_step is null or sequence_step between 1 and 10);

create index outreach_messages_user_scheduled_idx
  on outreach_messages (user_id, scheduled_for)
  where scheduled_for is not null and status in ('draft', 'approved');

-- ---------------------------------------------------------------------------
--  campaign_steps — "N days after the previous message, follow up about X".
--  Step 1 is the first message itself, so stored steps start at 2.
-- ---------------------------------------------------------------------------

create table campaign_steps (
  id           uuid            primary key default uuid_generate_v4(),
  user_id      uuid            not null references auth.users (id) on delete cascade,
  campaign_id  uuid            not null,
  step_number  integer         not null,
  delay_days   integer         not null,
  topic        text,
  channel      message_channel not null default 'direct_message',
  created_at   timestamptz     not null default now(),
  updated_at   timestamptz     not null default now(),

  constraint campaign_steps_campaign_fk
    foreign key (campaign_id, user_id) references campaigns (id, user_id) on delete cascade,
  constraint campaign_steps_unique_step unique (campaign_id, step_number),
  constraint campaign_steps_step_range check (step_number between 2 and 10),
  constraint campaign_steps_delay_range check (delay_days between 1 and 90),
  constraint campaign_steps_topic_length check (topic is null or char_length(topic) <= 500)
);

create trigger campaign_steps_set_updated_at
  before update on campaign_steps
  for each row execute function set_updated_at();

create index campaign_steps_user_idx on campaign_steps (user_id);

-- ---------------------------------------------------------------------------
--  lead_replies — the lead's answers, as pasted in by the user. They feed the
--  AI reply drafts and stop the follow-up sequence.
-- ---------------------------------------------------------------------------

create table lead_replies (
  id           uuid        primary key default uuid_generate_v4(),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  lead_id      uuid        not null,
  body         text        not null,
  received_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),

  constraint lead_replies_lead_fk
    foreign key (lead_id, user_id) references leads (id, user_id) on delete cascade,
  constraint lead_replies_body_not_blank check (length(btrim(body)) > 0),
  constraint lead_replies_body_max check (char_length(body) <= 8000)
);

create index lead_replies_lead_idx on lead_replies (lead_id, received_at desc);
create index lead_replies_user_idx on lead_replies (user_id, received_at desc);

-- ---------------------------------------------------------------------------
--  follow_up_tasks — a planned follow-up. Created automatically from the
--  campaign sequence when a message is marked sent, or by hand for any lead.
--
--  pending   due (or not yet), no message drafted
--  drafted   a message has been drafted for it (message_id)
--  done      that message was marked sent
--  cancelled the lead replied, reached a final status, or the user skipped it
-- ---------------------------------------------------------------------------

create table follow_up_tasks (
  id           uuid            primary key default uuid_generate_v4(),
  user_id      uuid            not null references auth.users (id) on delete cascade,
  lead_id      uuid            not null,
  campaign_id  uuid,
  step_number  integer,
  topic        text,
  channel      message_channel not null default 'direct_message',
  due_at       timestamptz     not null,
  status       text            not null default 'pending',
  message_id   uuid            references outreach_messages (id) on delete set null,
  created_at   timestamptz     not null default now(),
  updated_at   timestamptz     not null default now(),

  constraint follow_up_tasks_lead_fk
    foreign key (lead_id, user_id) references leads (id, user_id) on delete cascade,
  constraint follow_up_tasks_campaign_fk
    foreign key (campaign_id, user_id) references campaigns (id, user_id)
    on delete set null (campaign_id),
  constraint follow_up_tasks_status_valid
    check (status in ('pending', 'drafted', 'done', 'cancelled')),
  constraint follow_up_tasks_step_range
    check (step_number is null or step_number between 2 and 10),
  constraint follow_up_tasks_topic_length check (topic is null or char_length(topic) <= 500)
);

create trigger follow_up_tasks_set_updated_at
  before update on follow_up_tasks
  for each row execute function set_updated_at();

-- One automatic task per lead per campaign step, so a sent message that is
-- re-processed (or two tabs) cannot plan the same step twice.
create unique index follow_up_tasks_auto_step_uniq
  on follow_up_tasks (lead_id, campaign_id, step_number)
  where campaign_id is not null and step_number is not null;

create index follow_up_tasks_due_idx
  on follow_up_tasks (user_id, due_at)
  where status in ('pending', 'drafted');
create index follow_up_tasks_lead_idx on follow_up_tasks (lead_id);
create index follow_up_tasks_message_idx on follow_up_tasks (message_id);

-- ---------------------------------------------------------------------------
--  Sequencing triggers
-- ---------------------------------------------------------------------------

-- Lead statuses that end a sequence: the lead has answered one way or the
-- other, or must not be contacted.
create or replace function lead_status_ends_sequence(p_status lead_status)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_status in ('interested', 'meeting', 'not_interested', 'invalid', 'do_not_contact')
$$;

-- When a message is marked sent: close its task, and plan the next step of
-- the lead's campaign sequence — unless the lead has replied or reached a
-- final status. Replies never start a sequence step.
create or replace function outreach_messages_plan_follow_up()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_lead       leads%rowtype;
  v_next_step  integer;
  v_step       campaign_steps%rowtype;
begin
  if not (new.status = 'sent' and old.status <> 'sent') then
    return new;
  end if;

  update follow_up_tasks
     set status = 'done'
   where message_id = new.id
     and user_id = new.user_id
     and status in ('pending', 'drafted');

  if new.kind = 'reply' then
    return new;
  end if;

  select * into v_lead from leads where id = new.lead_id and user_id = new.user_id;
  if not found or v_lead.campaign_id is null or lead_status_ends_sequence(v_lead.status) then
    return new;
  end if;

  -- A reply received after this message means the conversation has started.
  if exists (
    select 1 from lead_replies
     where lead_id = new.lead_id and user_id = new.user_id and received_at >= new.created_at
  ) then
    return new;
  end if;

  v_next_step := coalesce(new.sequence_step, 1) + 1;

  select * into v_step
    from campaign_steps
   where campaign_id = v_lead.campaign_id
     and user_id = new.user_id
     and step_number = v_next_step;
  if not found then
    return new;
  end if;

  insert into follow_up_tasks (
    user_id, lead_id, campaign_id, step_number, topic, channel, due_at
  ) values (
    new.user_id, new.lead_id, v_lead.campaign_id, v_step.step_number, v_step.topic,
    v_step.channel, new.sent_at + make_interval(days => v_step.delay_days)
  )
  on conflict do nothing;

  return new;
end;
$$;

create trigger outreach_messages_plan_follow_up
  after update on outreach_messages
  for each row execute function outreach_messages_plan_follow_up();

-- A reply stops the sequence: open follow-ups for that lead are cancelled.
-- Drafts already written stay as drafts for the user to keep or archive.
create or replace function lead_replies_stop_sequence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update follow_up_tasks
     set status = 'cancelled'
   where lead_id = new.lead_id
     and user_id = new.user_id
     and status in ('pending', 'drafted');
  return new;
end;
$$;

create trigger lead_replies_stop_sequence
  after insert on lead_replies
  for each row execute function lead_replies_stop_sequence();

-- So does a final lead status (interested, meeting, not interested, …).
create or replace function leads_stop_sequence_on_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from old.status and lead_status_ends_sequence(new.status) then
    update follow_up_tasks
       set status = 'cancelled'
     where lead_id = new.id
       and user_id = new.user_id
       and status in ('pending', 'drafted');
  end if;
  return new;
end;
$$;

create trigger leads_stop_sequence_on_status
  after update of status on leads
  for each row execute function leads_stop_sequence_on_status();

-- ---------------------------------------------------------------------------
--  Contact enrichment
--
--  leads gains a small record of the last lookup. enrichment_requests keeps
--  each lookup, including the raw webhook payload for asynchronous phone
--  numbers, so a result can always be traced to what the provider sent.
-- ---------------------------------------------------------------------------

alter table leads
  add column enrichment_status text,
  add column enriched_at timestamptz;

alter table leads
  add constraint leads_enrichment_status_valid
    check (enrichment_status is null
           or enrichment_status in ('pending', 'found', 'not_found', 'failed'));

create table enrichment_requests (
  id               uuid        primary key default uuid_generate_v4(),
  user_id          uuid        not null references auth.users (id) on delete cascade,
  lead_id          uuid        not null,
  provider         text        not null,
  status           text        not null default 'pending',
  -- Unguessable token in the webhook URL. The provider calls back with it;
  -- the webhook route only ever touches the one lead this row names.
  webhook_token    text        unique,
  phone_requested  boolean     not null default false,
  response         jsonb,
  webhook_payload  jsonb,
  error_message    text,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,

  constraint enrichment_requests_lead_fk
    foreign key (lead_id, user_id) references leads (id, user_id) on delete cascade,
  constraint enrichment_requests_status_valid
    check (status in ('pending', 'completed', 'failed'))
);

create index enrichment_requests_lead_idx on enrichment_requests (lead_id, created_at desc);
create index enrichment_requests_user_idx on enrichment_requests (user_id);

-- ---------------------------------------------------------------------------
--  Row Level Security
-- ---------------------------------------------------------------------------

alter table campaign_steps      enable row level security;
alter table lead_replies        enable row level security;
alter table follow_up_tasks     enable row level security;
alter table enrichment_requests enable row level security;

create policy campaign_steps_select on campaign_steps
  for select to authenticated using ((select auth.uid()) = user_id);
create policy campaign_steps_insert on campaign_steps
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy campaign_steps_update on campaign_steps
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy campaign_steps_delete on campaign_steps
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy lead_replies_select on lead_replies
  for select to authenticated using ((select auth.uid()) = user_id);
create policy lead_replies_insert on lead_replies
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy lead_replies_update on lead_replies
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy lead_replies_delete on lead_replies
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy follow_up_tasks_select on follow_up_tasks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy follow_up_tasks_insert on follow_up_tasks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy follow_up_tasks_update on follow_up_tasks
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy follow_up_tasks_delete on follow_up_tasks
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Users can read and start their own lookups. Completing them from the
-- provider's webhook happens server-side with the service role.
create policy enrichment_requests_select on enrichment_requests
  for select to authenticated using ((select auth.uid()) = user_id);
create policy enrichment_requests_insert on enrichment_requests
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy enrichment_requests_update on enrichment_requests
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
