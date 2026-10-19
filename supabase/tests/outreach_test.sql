-- ============================================================================
--  Campaigns, outreach messages and CSV import (0005)
--
--  Runs after schema_test.sql on the same database, so the two users and
--  their leads from that file already exist. Every check prints
--  "<name>: true". Any "false" is a failure.
--
--  Checks that must be rejected are wrapped in pg_temp.raises(), which runs
--  the statement and reports whether it raised. That keeps several rejection
--  checks in one file without the first one aborting the rest.
-- ============================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\set u1 '11111111-1111-1111-1111-111111111111'
\set u2 '33333333-3333-3333-3333-333333333333'
\set c1 'cccccccc-0000-0000-0000-000000000001'
\set c2 'cccccccc-0000-0000-0000-000000000002'
\set l1 'dddddddd-0000-0000-0000-000000000001'
\set l2 'dddddddd-0000-0000-0000-000000000002'

create function pg_temp.raises(p_sql text) returns boolean
language plpgsql as $fn$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end;
$fn$;

grant usage on schema public to authenticated;
grant select, insert, update, delete on campaigns, outreach_messages to authenticated;

insert into campaigns (id, user_id, name) values (:'c1', :'u1', 'Nordic CFOs'), (:'c2', :'u2', 'Other user');
insert into leads (id, user_id, full_name, company_name) values
  (:'l1', :'u1', 'Outreach Lead', 'Acme ApS'),
  (:'l2', :'u2', 'Foreign Lead', 'Other ApS');

\echo '--- ownership via composite keys ---'

select 'campaign names unique/user: ' ||
  pg_temp.raises($$insert into campaigns (user_id, name)
                   values ('11111111-1111-1111-1111-111111111111', '  nordic cfos ')$$)::text;

select 'lead -> own campaign ok:    ' ||
  (not pg_temp.raises($$update leads set campaign_id = 'cccccccc-0000-0000-0000-000000000001'
                        where id = 'dddddddd-0000-0000-0000-000000000001'$$))::text;

select 'lead -> foreign campaign:   ' ||
  pg_temp.raises($$update leads set campaign_id = 'cccccccc-0000-0000-0000-000000000002'
                   where id = 'dddddddd-0000-0000-0000-000000000001'$$)::text;

select 'message -> foreign lead:    ' ||
  pg_temp.raises($$insert into outreach_messages (user_id, lead_id, body)
                   values ('11111111-1111-1111-1111-111111111111',
                           'dddddddd-0000-0000-0000-000000000002', 'Hi')$$)::text;

\echo '--- message lifecycle ---'

insert into outreach_messages (id, user_id, lead_id, campaign_id, body, source)
values ('eeeeeeee-0000-0000-0000-000000000001', :'u1', :'l1', :'c1', 'Hej, kort hilsen.', 'ai');

select 'new rows start as draft:    ' ||
  pg_temp.raises($$insert into outreach_messages (user_id, lead_id, body, status)
                   values ('11111111-1111-1111-1111-111111111111',
                           'dddddddd-0000-0000-0000-000000000001', 'x', 'approved')$$)::text;

select 'connection note <= 300:     ' ||
  pg_temp.raises($$insert into outreach_messages (user_id, lead_id, body, channel)
                   values ('11111111-1111-1111-1111-111111111111',
                           'dddddddd-0000-0000-0000-000000000001', repeat('a', 301),
                           'connection_request')$$)::text;

select 'draft cannot jump to sent:  ' ||
  pg_temp.raises($$update outreach_messages set status = 'sent'
                   where id = 'eeeeeeee-0000-0000-0000-000000000001'$$)::text;

update outreach_messages set status = 'approved' where id = 'eeeeeeee-0000-0000-0000-000000000001';
select 'approve stamps approved_at: ' || (approved_at is not null and status = 'approved')::text
from outreach_messages where id = 'eeeeeeee-0000-0000-0000-000000000001';

update outreach_messages set body = 'Hej, ændret tekst.'
where id = 'eeeeeeee-0000-0000-0000-000000000001';
select 'edit resets to draft:       ' ||
  (status = 'draft' and approved_at is null and edited)::text
from outreach_messages where id = 'eeeeeeee-0000-0000-0000-000000000001';

update outreach_messages set status = 'approved' where id = 'eeeeeeee-0000-0000-0000-000000000001';
update outreach_messages set status = 'sent' where id = 'eeeeeeee-0000-0000-0000-000000000001';
select 'sent stamps sent_at:        ' ||
  (status = 'sent' and sent_at is not null and approved_at is not null)::text
from outreach_messages where id = 'eeeeeeee-0000-0000-0000-000000000001';

select 'sending marks contacted:    ' || (status = 'contacted')::text
from leads where id = :'l1';

select 'sent body is immutable:     ' ||
  pg_temp.raises($$update outreach_messages set body = 'rewritten'
                   where id = 'eeeeeeee-0000-0000-0000-000000000001'$$)::text;

select 'sent status is final:       ' ||
  pg_temp.raises($$update outreach_messages set status = 'archived'
                   where id = 'eeeeeeee-0000-0000-0000-000000000001'$$)::text;

update leads set status = 'meeting' where id = :'l1';
insert into outreach_messages (id, user_id, lead_id, body)
values ('eeeeeeee-0000-0000-0000-000000000002', :'u1', :'l1', 'Follow-up');
update outreach_messages set status = 'approved' where id = 'eeeeeeee-0000-0000-0000-000000000002';
update outreach_messages set status = 'sent' where id = 'eeeeeeee-0000-0000-0000-000000000002';
select 'later status not regressed: ' || (status = 'meeting')::text from leads where id = :'l1';

\echo '--- deletes ---'

delete from campaigns where id = :'c1';
select 'campaign delete keeps lead: ' || (count(*) = 1 and bool_and(campaign_id is null))::text
from leads where id = :'l1';
select 'and keeps its messages:     ' || (count(*) = 2 and bool_and(campaign_id is null))::text
from outreach_messages where lead_id = :'l1';

\echo '--- csv import ---'

-- Supabase grants this out of the box; the local auth stub does not.
grant usage on schema auth to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub', :'u1', false);

select 'import inserts + dedupes:   ' || (inserted = 2 and skipped = 2)::text
from import_leads($$[
  {"full_name": "Import One", "company_name": "Imp A/S", "email": "one@imp.dk"},
  {"full_name": "Import Two", "linkedin_url": "https://www.linkedin.com/in/import-two"},
  {"full_name": "Import One Again", "email": "ONE@imp.dk"},
  {"full_name": "Import Two Copy", "linkedin_url": "https://linkedin.com/in/import-two/"}
]$$::jsonb);

select 'import owned by caller:     ' ||
  (count(*) = 2 and bool_and(user_id = '11111111-1111-1111-1111-111111111111'
                             and source = 'csv_import'))::text
from leads where full_name like 'Import%';

select 'import into foreign camp.:  ' ||
  pg_temp.raises($$select * from import_leads('[{"full_name": "Sneaky"}]'::jsonb,
                                              'cccccccc-0000-0000-0000-000000000002')$$)::text;

reset role;

select 'anon cannot import:         ' ||
  (not has_function_privilege('anon', 'import_leads(jsonb, uuid)', 'execute'))::text;

\echo '--- row level security ---'

set role authenticated;
select set_config('request.jwt.claim.sub', :'u2', false);

select 'u2 sees no u1 messages:     ' || (count(*) = 0)::text from outreach_messages;
select 'u2 sees only own campaign:  ' || (count(*) = 1)::text from campaigns;

with attempt as (
  update outreach_messages set body = 'hijack' where user_id = :'u1' returning 1
)
select 'cross-user msg update:      ' || (count(*) = 0)::text from attempt;

select 'cross-user msg insert:      ' ||
  pg_temp.raises($$insert into outreach_messages (user_id, lead_id, body)
                   values ('11111111-1111-1111-1111-111111111111',
                           'dddddddd-0000-0000-0000-000000000001', 'x')$$)::text;

select 'stats scoped to caller:     ' || (sent_messages = 0)::text from outreach_stats();
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', :'u1', false);
select 'u1 stats count its sends:   ' || (sent_messages = 2)::text from outreach_stats();
reset role;

\echo 'outreach test finished — every line above must read true'
