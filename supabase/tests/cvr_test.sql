-- ============================================================================
--  Leads from CVR (0007)
--
--  Runs after followup_test.sql on the same database. Every check prints
--  "<name>: true". Any "false" is a failure.
-- ============================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\set u1 '11111111-1111-1111-1111-111111111111'
\set u2 '33333333-3333-3333-3333-333333333333'

create function pg_temp.raises(p_sql text) returns boolean
language plpgsql as $fn$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end;
$fn$;

\echo '--- import_cvr_leads ---'

set role authenticated;
select set_config('request.jwt.claim.sub', :'u1', false);

select 'two directors inserted:     ' || (inserted = 2 and skipped = 0)::text
from import_cvr_leads($j$[
  {"full_name":"Mette Sørensen","first_name":"Mette","last_name":"Sørensen","job_title":"Adm. direktør",
   "company_name":"Nordlys ApS","cvr_number":"12345678","cvr_person_id":"4001",
   "company_email":"info@nordlys.dk","company_phone":"70203040","company_address":"Søndergade 12, 8000 Aarhus C",
   "source_url":"https://datacvr.virk.dk/enhed/virksomhed/12345678"},
  {"full_name":"Lars Jensen","job_title":"Direktør","company_name":"Nordlys ApS",
   "cvr_number":"12345678","cvr_person_id":"4002","company_email":"info@nordlys.dk"}
]$j$::jsonb);

select 'shared company email ok:    ' || (count(*) = 2)::text
from leads where cvr_number = '12345678' and company_email = 'info@nordlys.dk' and email is null;

select 'stamped as cvr, found:      ' ||
  bool_and(source = 'cvr' and country = 'Denmark' and enrichment_status = 'found' and user_id = :'u1')::text
from leads where cvr_number = '12345678';

-- Same person again, name spelled differently: the CVR person index skips it.
select 'repeat person skipped:      ' || (inserted = 0 and skipped = 1)::text
from import_cvr_leads($j$[
  {"full_name":"Mette K. Sørensen","company_name":"Nordlys ApS","cvr_number":"12345678","cvr_person_id":"4001"}
]$j$::jsonb);

select 'bad cvr number rejected:    ' || pg_temp.raises($q$
  select * from import_cvr_leads('[{"full_name":"X","cvr_number":"1234","cvr_person_id":"1"}]'::jsonb)
$q$)::text;

reset role;

\echo '--- other users ---'

set role authenticated;
select set_config('request.jwt.claim.sub', :'u2', false);

select 'other user may hold same:   ' || (inserted = 1)::text
from import_cvr_leads($j$[
  {"full_name":"Mette Sørensen","company_name":"Nordlys ApS","cvr_number":"12345678","cvr_person_id":"4001"}
]$j$::jsonb);

select 'sees only own cvr leads:    ' || (count(*) = 1)::text from leads where cvr_number = '12345678';

reset role;

select set_config('request.jwt.claim.sub', '', false);
set role anon;
select 'anon cannot import:         ' || pg_temp.raises($q$
  select * from import_cvr_leads('[]'::jsonb)
$q$)::text;
reset role;

\echo '--- CSV import keeps CVR columns ---'

set role authenticated;
select set_config('request.jwt.claim.sub', :'u1', false);

select 'csv row with cvr inserted:  ' || (inserted = 1)::text
from import_leads($j$[
  {"full_name":"Ida Holm","company_name":"Fjord A/S","cvr_number":"87654321",
   "company_address":"Havnegade 1, 5000 Odense C","company_phone":"66112233","company_email":"kontakt@fjord.dk"}
]$j$::jsonb);

select 'cvr columns stored:         ' ||
  (count(*) = 1 and bool_and(source = 'csv_import' and company_phone = '66112233'))::text
from leads where cvr_number = '87654321';

reset role;
