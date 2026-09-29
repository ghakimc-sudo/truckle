-- Truckle backend schema.
-- Run once in the Supabase SQL editor (Project "Truckle" -> SQL -> New query -> paste -> Run).
-- Safe to re-run: everything is "if not exists" / "or replace".

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Workspaces: one per removal company (plus one per customer/worker who signs
-- up without an invite). Everyone who works together shares a workspace.
-- ---------------------------------------------------------------------------
create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default '',
  owner       uuid references auth.users(id) on delete set null,
  join_code   text not null unique default encode(gen_random_bytes(6), 'hex'),
  created_at  timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('company', 'crew', 'customer')),
  display_name  text not null default '',
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on public.workspace_members(user_id);

-- ---------------------------------------------------------------------------
-- Docs: the app's collections (jobs, crew, invoices, cinvoices, chats, notes…)
-- stored as JSON, one row per document. Mirrors the app's existing data model
-- so the front end works unchanged.
-- ---------------------------------------------------------------------------
create table if not exists public.docs (
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  coll          text not null,
  id            text not null,
  data          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid(),
  primary key (workspace_id, coll, id)
);

-- ---------------------------------------------------------------------------
-- Stripe Connect accounts for companies and crew (written by the API only).
-- ---------------------------------------------------------------------------
create table if not exists public.connect_accounts (
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  party_kind         text not null check (party_kind in ('company', 'crew')),
  party_id           text not null,
  stripe_account_id  text not null unique,
  charges_enabled    boolean not null default false,
  payouts_enabled    boolean not null default false,
  details_submitted  boolean not null default false,
  livemode           boolean not null default false,
  updated_at         timestamptz not null default now(),
  primary key (workspace_id, party_kind, party_id)
);

-- Every Truckle Pay checkout (written by the API only).
create table if not exists public.payments (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,
  kind                   text not null check (kind in ('invoice', 'cinvoice')),
  invoice_id             text not null,
  checkout_session_id    text unique,
  payment_intent_id      text,
  method                 text not null,
  amount_cents           integer not null,
  application_fee_cents  integer not null,
  destination            text not null,
  status                 text not null default 'open',
  livemode               boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists payments_invoice_idx on public.payments(workspace_id, kind, invoice_id);

-- Stripe webhook de-duplication.
create table if not exists public.stripe_events (
  id           text primary key,
  type         text not null,
  received_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid());
$$;

-- Recursive JSON merge that matches the app's deepMerge(): objects merge key by
-- key, everything else (arrays, strings, null) replaces.
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb)
returns jsonb language sql immutable as $$
  select case
    when jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then
      coalesce((
        select jsonb_object_agg(
          k,
          case
            when jsonb_typeof(a -> k) = 'object' and jsonb_typeof(b -> k) = 'object'
              then public.jsonb_deep_merge(a -> k, b -> k)
            when b ? k then b -> k
            else a -> k
          end)
        from (select jsonb_object_keys(a) as k union select jsonb_object_keys(b)) keys
      ), '{}'::jsonb)
    else b
  end;
$$;

-- Atomic partial update of one doc. Runs as the caller, so RLS applies.
create or replace function public.doc_patch(p_ws uuid, p_coll text, p_id text, p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  out jsonb;
begin
  update public.docs
     set data = public.jsonb_deep_merge(data, p_patch), updated_at = now(), updated_by = auth.uid()
   where workspace_id = p_ws and coll = p_coll and id = p_id
  returning data into out;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.docs              enable row level security;
alter table public.connect_accounts  enable row level security;
alter table public.payments          enable row level security;
alter table public.stripe_events     enable row level security;

drop policy if exists "members read workspace" on public.workspaces;
create policy "members read workspace" on public.workspaces
  for select to authenticated using (public.is_member(id));

drop policy if exists "members read members" on public.workspace_members;
create policy "members read members" on public.workspace_members
  for select to authenticated using (public.is_member(workspace_id));

drop policy if exists "members read docs" on public.docs;
create policy "members read docs" on public.docs
  for select to authenticated using (public.is_member(workspace_id));
drop policy if exists "members insert docs" on public.docs;
create policy "members insert docs" on public.docs
  for insert to authenticated with check (public.is_member(workspace_id));
drop policy if exists "members update docs" on public.docs;
create policy "members update docs" on public.docs
  for update to authenticated using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
drop policy if exists "members delete docs" on public.docs;
create policy "members delete docs" on public.docs
  for delete to authenticated using (public.is_member(workspace_id));

drop policy if exists "members read connect accounts" on public.connect_accounts;
create policy "members read connect accounts" on public.connect_accounts
  for select to authenticated using (public.is_member(workspace_id));

drop policy if exists "members read payments" on public.payments;
create policy "members read payments" on public.payments
  for select to authenticated using (public.is_member(workspace_id));

-- workspaces / workspace_members / connect_accounts / payments / stripe_events
-- are only written by the API with the service role key, so no write policies.

-- ---------------------------------------------------------------------------
-- Realtime: push doc changes to every open app in the workspace.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs'
  ) then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;
