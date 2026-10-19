-- ============================================================================
--  Follow-up sequences, replies and enrichment (0006)
--
--  Runs after outreach_test.sql on the same database. Every check prints
--  "<name>: true". Any "false" is a failure.
-- ============================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\set u1 '11111111-1111-1111-1111-111111111111'
\set u2 '33333333-3333-3333-3333-333333333333'
\set c '77777777-0000-0000-0000-000000000001'
\set la '88888888-0000-0000-0000-00000000000a'
\set lb '88888888-0000-0000-0000-00000000000b'
\set lc '88888888-0000-0000-0000-00000000000c'

create function pg_temp.raises(p_sql text) returns boolean
language plpgsql as $fn$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end;
$fn$;

grant select, insert, update, delete
  on campaign_steps, lead_replies, follow_up_tasks, enrichment_requests to authenticated;

insert into campaigns (id, user_id, name) values (:'c', :'u1', 'Sequence test');
insert into campaign_steps (user_id, campaign_id, step_number, delay_days, topic)
values (:'u1', :'c', 2, 3, 'Gentle nudge'),
       (:'u1', :'c', 3, 7, 'Share a case');
insert into leads (id, user_id, full_name, company_name, campaign_id) values
  (:'la', :'u1', 'Seq A', 'Seq Co', :'c'),
  (:'lb', :'u1', 'Seq B', 'Seq Co', :'c'),
  (:'lc', :'u1', 'Seq C', 'Seq Co', null);

\echo '--- sequence planning ---'

insert into outreach_messages (id, user_id, lead_id, campaign_id, body)
values ('99999999-0000-0000-0000-00000000000a', :'u1', :'la', :'c', 'First note');
update outreach_messages set status = 'approved' where id = '99999999-0000-0000-0000-00000000000a';

select 'no task before sending:     ' || (count(*) = 0)::text from follow_up_tasks where lead_id = :'la';

update outreach_messages set status = 'sent' where id = '99999999-0000-0000-0000-00000000000a';

select 'sent plans step 2:          ' ||
  (count(*) = 1 and bool_and(step_number = 2 and status = 'pending' and topic = 'Gentle nudge'))::text
from follow_up_tasks where lead_id = :'la';

select 'due 3 days after sending:   ' ||
  (bool_and(t.due_at = m.sent_at + interval '3 days'))::text
from follow_up_tasks t join outreach_messages m on m.id = '99999999-0000-0000-0000-00000000000a'
where t.lead_id = :'la';

-- Draft the follow-up for step 2 and send it: step 2 closes, step 3 is planned.
insert into outreach_messages (id, user_id, lead_id, campaign_id, body, kind, sequence_step)
values ('99999999-0000-0000-0000-0000000000a2', :'u1', :'la', :'c', 'Follow-up', 'follow_up', 2);
update follow_up_tasks set status = 'drafted', message_id = '99999999-0000-0000-0000-0000000000a2'
where lead_id = :'la' and step_number = 2;
update outreach_messages set status = 'approved' where id = '99999999-0000-0000-0000-0000000000a2';
update outreach_messages set status = 'sent' where id = '99999999-0000-0000-0000-0000000000a2';

select 'sending closes its task:    ' || (status = 'done')::text
from follow_up_tasks where lead_id = :'la' and step_number = 2;
select 'and plans step 3:           ' || (count(*) = 1)::text
from follow_up_tasks where lead_id = :'la' and step_number = 3 and status = 'pending';

select 'a step is planned only once:' ||
  pg_temp.raises($$insert into follow_up_tasks (user_id, lead_id, campaign_id, step_number, due_at)
                   values ('11111111-1111-1111-1111-111111111111',
                           '88888888-0000-0000-0000-00000000000a',
                           '77777777-0000-0000-0000-000000000001', 3, now())$$)::text;

\echo '--- stopping a sequence ---'

insert into lead_replies (user_id, lead_id, body) values (:'u1', :'la', 'Thanks, tell me more');
select 'a reply cancels open tasks: ' || (status = 'cancelled')::text
from follow_up_tasks where lead_id = :'la' and step_number = 3;

insert into outreach_messages (id, user_id, lead_id, campaign_id, body)
values ('99999999-0000-0000-0000-00000000000b', :'u1', :'lb', :'c', 'First note');
update outreach_messages set status = 'approved' where id = '99999999-0000-0000-0000-00000000000b';
update outreach_messages set status = 'sent' where id = '99999999-0000-0000-0000-00000000000b';
update leads set status = 'meeting' where id = :'lb';
select 'final status cancels tasks: ' || (bool_and(status = 'cancelled'))::text
from follow_up_tasks where lead_id = :'lb';

insert into outreach_messages (id, user_id, lead_id, body)
values ('99999999-0000-0000-0000-00000000000c', :'u1', :'lc', 'No campaign');
update outreach_messages set status = 'approved' where id = '99999999-0000-0000-0000-00000000000c';
update outreach_messages set status = 'sent' where id = '99999999-0000-0000-0000-00000000000c';
select 'no campaign, no sequence:   ' || (count(*) = 0)::text from follow_up_tasks where lead_id = :'lc';

-- A reply sent back to the lead never starts a sequence step.
insert into outreach_messages (id, user_id, lead_id, campaign_id, body, kind)
values ('99999999-0000-0000-0000-0000000000a3', :'u1', :'la', :'c', 'Answer', 'reply');
update leads set status = 'contacted' where id = :'la';
update outreach_messages set status = 'approved' where id = '99999999-0000-0000-0000-0000000000a3';
update outreach_messages set status = 'sent' where id = '99999999-0000-0000-0000-0000000000a3';
select 'replies plan nothing:       ' ||
  (count(*) = 0)::text from follow_up_tasks where lead_id = :'la' and status = 'pending';

\echo '--- constraints and ownership ---'

select 'step 1 is the first message:' ||
  pg_temp.raises($$insert into campaign_steps (user_id, campaign_id, step_number, delay_days)
                   values ('11111111-1111-1111-1111-111111111111',
                           '77777777-0000-0000-0000-000000000001', 1, 3)$$)::text;

select 'reply to foreign lead:      ' ||
  pg_temp.raises($$insert into lead_replies (user_id, lead_id, body)
                   values ('33333333-3333-3333-3333-333333333333',
                           '88888888-0000-0000-0000-00000000000a', 'x')$$)::text;

select 'task for foreign lead:      ' ||
  pg_temp.raises($$insert into follow_up_tasks (user_id, lead_id, due_at)
                   values ('33333333-3333-3333-3333-333333333333',
                           '88888888-0000-0000-0000-00000000000a', now())$$)::text;

set role authenticated;
select set_config('request.jwt.claim.sub', :'u2', false);
select 'u2 sees no u1 tasks:        ' || (count(*) = 0)::text from follow_up_tasks;
select 'u2 sees no u1 replies:      ' || (count(*) = 0)::text from lead_replies;
select 'u2 sees no u1 steps:        ' || (count(*) = 0)::text from campaign_steps;
with attempt as (
  update follow_up_tasks set status = 'cancelled' where user_id = :'u1' returning 1
)
select 'cross-user task update:     ' || (count(*) = 0)::text from attempt;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'u1', false);
select 'u1 sees its own tasks:      ' || (count(*) >= 3)::text from follow_up_tasks;
reset role;

\echo 'follow-up test finished — every line above must read true'
