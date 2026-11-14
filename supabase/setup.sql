-- Badminton Tournament: Supabase setup.
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run again; it won't delete tournaments.
--
-- Security model:
--   * Anyone with the link can READ tournaments (live view for players).
--   * Nobody can write to the table directly. Saves go through
--     save_tournament(), which checks the admin PIN inside the database.
--   * PINs are stored hashed in admin_pins, which the browser cannot read.
--   * After 20 wrong PINs in 10 minutes, PIN checks pause for everyone.

create extension if not exists pgcrypto with schema extensions;

-- ── Tables ──────────────────────────────────────────────────────
create table if not exists public.tournaments (
  id         text primary key,
  state      jsonb not null,
  version    integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.tournaments enable row level security;
drop policy if exists "anyone can read tournaments" on public.tournaments;
create policy "anyone can read tournaments" on public.tournaments for select using (true);
-- No insert/update/delete policies on purpose: writes only via save_tournament().

create table if not exists public.admin_pins (
  role     text primary key check (role in ('admin', 'super_admin')),
  pin_hash text not null
);
alter table public.admin_pins enable row level security; -- no policies: unreadable from the browser

create table if not exists public.pin_failures (at timestamptz not null default now());
alter table public.pin_failures enable row level security;

-- ── Functions ───────────────────────────────────────────────────
-- Returns 'super_admin', 'admin', or null for a wrong PIN.
create or replace function public.check_pin(p_pin text)
returns text
language plpgsql security definer
set search_path = public, extensions
as $$
declare r text;
begin
  if (select count(*) from pin_failures where at > now() - interval '10 minutes') >= 20 then
    raise exception 'Too many wrong PINs. Try again in 10 minutes.';
  end if;
  select role into r from admin_pins
   where pin_hash = crypt(coalesce(p_pin, ''), pin_hash)
   order by (role = 'super_admin') desc
   limit 1;
  if r is null then
    insert into pin_failures default values;
    delete from pin_failures where at < now() - interval '1 day';
  end if;
  return r;
end $$;

-- Saves a tournament if the PIN is right and the caller saw the latest version.
--   p_version = 0 creates the tournament.
-- Returns the new version, null if someone else saved first, or -1 for a wrong PIN.
create or replace function public.save_tournament(p_id text, p_state jsonb, p_version integer, p_pin text)
returns integer
language plpgsql security definer
set search_path = public, extensions
as $$
declare v integer;
begin
  if p_id !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'Bad tournament id'; end if;
  if check_pin(p_pin) is null then return -1; end if;

  if p_version = 0 then
    insert into tournaments (id, state, version) values (p_id, p_state, 1)
    on conflict (id) do nothing;
    if found then return 1; end if;
    return null;
  end if;

  update tournaments
     set state = p_state, version = version + 1, updated_at = now()
   where id = p_id and version = p_version
  returning version into v;
  return v;
end $$;

revoke all on function public.check_pin(text) from public;
revoke all on function public.save_tournament(text, jsonb, integer, text) from public;
grant execute on function public.check_pin(text) to anon, authenticated;
grant execute on function public.save_tournament(text, jsonb, integer, text) to anon, authenticated;

-- ── Live updates ────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tournaments') then
    alter publication supabase_realtime add table public.tournaments;
  end if;
end $$;

-- ── Admin PINs ──────────────────────────────────────────────────
-- Replace both values with your own 4-digit PINs before running.
-- To change PINs later, edit these two values and run just this statement again.
insert into public.admin_pins (role, pin_hash) values
  ('admin',       extensions.crypt('ADMIN-PIN-HERE',  extensions.gen_salt('bf'))),
  ('super_admin', extensions.crypt('SUPER-PIN-HERE', extensions.gen_salt('bf')))
on conflict (role) do update set pin_hash = excluded.pin_hash;
