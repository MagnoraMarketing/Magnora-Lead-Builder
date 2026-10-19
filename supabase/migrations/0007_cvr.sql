-- =============================================================================
--  0007 — Leads from the Danish company register (CVR)
--
--  Additive only: new nullable columns on leads, one partial unique index and
--  one function. Nothing existing is changed or dropped.
--
--  CVR leads are company directors. Their contact details are the company's
--  (CVR holds no personal email or phone), so they get their own columns:
--  putting info@company.dk in `email` would make the email duplicate index
--  treat two directors of the same company as one lead.
-- =============================================================================

alter table leads
  add column cvr_number      text,
  add column cvr_person_id   text,
  add column company_address text,
  add column company_phone   text,
  add column company_email   text;

alter table leads
  add constraint leads_cvr_number_format
    check (cvr_number is null or cvr_number ~ '^[0-9]{8}$');

-- One lead per person per company per user. The name + company index already
-- catches most repeats; this one also holds when CVR changes how a name is
-- spelled.
create unique index leads_user_cvr_person_uniq
  on leads (user_id, cvr_number, cvr_person_id)
  where cvr_number is not null and cvr_person_id is not null;

create index leads_user_cvr_number_idx
  on leads (user_id, cvr_number)
  where cvr_number is not null;

-- ---------------------------------------------------------------------------
--  import_cvr_leads — inserts directors found in CVR.
--
--  SECURITY INVOKER like import_leads: runs as the signed-in user, so RLS
--  applies and every row is stamped with auth.uid(). Existing leads are
--  skipped by the duplicate indexes, never overwritten.
-- ---------------------------------------------------------------------------

create or replace function import_cvr_leads(p_rows jsonb, p_campaign_id uuid default null)
returns table (inserted integer, skipped integer)
language plpgsql
set search_path = public
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
  if v_total > 500 then
    raise exception 'At most 500 rows per import.' using errcode = 'program_limit_exceeded';
  end if;

  with ins as (
    insert into leads (
      user_id, full_name, first_name, last_name, job_title, company_name,
      company_website, location, country, industry, company_size,
      cvr_number, cvr_person_id, company_address, company_phone, company_email,
      source, source_url, campaign_id, enrichment_status, enriched_at
    )
    select
      v_user, r.full_name, r.first_name, r.last_name, r.job_title, r.company_name,
      r.company_website, r.location, 'Denmark', r.industry, r.company_size,
      r.cvr_number, r.cvr_person_id, r.company_address, r.company_phone, r.company_email,
      'cvr', r.source_url, p_campaign_id, 'found', now()
    from jsonb_to_recordset(p_rows) as r (
      full_name text, first_name text, last_name text, job_title text,
      company_name text, company_website text, location text, industry text,
      company_size text, cvr_number text, cvr_person_id text,
      company_address text, company_phone text, company_email text,
      source_url text
    )
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from ins;

  return query select v_inserted, v_total - v_inserted;
end;
$$;

revoke execute on function import_cvr_leads(jsonb, uuid) from public, anon;
grant execute on function import_cvr_leads(jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
--  import_leads — same function as in 0005, now also taking the CVR columns,
--  so a CSV exported from the app imports back without losing them.
-- ---------------------------------------------------------------------------

create or replace function import_leads(p_rows jsonb, p_campaign_id uuid default null)
returns table (inserted integer, skipped integer)
language plpgsql
set search_path = public
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
      cvr_number, company_address, company_phone, company_email,
      source, campaign_id
    )
    select
      v_user, r.full_name, r.first_name, r.last_name, r.job_title, r.company_name,
      r.company_website, r.company_linkedin_url, r.linkedin_url, r.location, r.country,
      r.industry, r.company_size, r.email, r.phone, r.mobile_phone,
      coalesce(r.status, 'new')::lead_status, r.notes,
      r.cvr_number, r.company_address, r.company_phone, r.company_email,
      'csv_import', p_campaign_id
    from jsonb_to_recordset(p_rows) as r (
      full_name text, first_name text, last_name text, job_title text,
      company_name text, company_website text, company_linkedin_url text,
      linkedin_url text, location text, country text, industry text,
      company_size text, email text, phone text, mobile_phone text,
      status text, notes text,
      cvr_number text, company_address text, company_phone text, company_email text
    )
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from ins;

  return query select v_inserted, v_total - v_inserted;
end;
$$;
