-- Class slot booking: database schema, access rules and booking logic.
-- Run once in the Supabase SQL editor (or with `supabase db push`).
-- Safe to read top to bottom: tables, helpers, rules, booking functions, triggers.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Settings and people
-- ---------------------------------------------------------------------------

create table if not exists public.settings (
  key   text primary key,
  value text not null
);
insert into public.settings (key, value) values ('timezone', 'Europe/Warsaw')
  on conflict (key) do nothing;

-- Everyone who may open the app. Anyone else who signs in with Google sees
-- "not on the list" and no data. Admins are the rows with is_admin = true.
create table if not exists public.allowed_users (
  email      text primary key check (email = lower(email) and email like '%@%'),
  full_name  text not null default '',
  is_admin   boolean not null default false,
  added_by   text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.jwt_email() returns text
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowed_users where email = public.jwt_email())
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowed_users
                 where email = public.jwt_email() and is_admin)
$$;

create or replace function public.local_now() returns timestamp
language sql stable security definer set search_path = public as $$
  select now() at time zone coalesce((select value from public.settings where key = 'timezone'), 'UTC')
$$;

-- True when a slot starting at p_start (minutes after midnight) on p_date has already begun.
create or replace function public.slot_is_past(p_date date, p_start int) returns boolean
language sql stable as $$
  select p_date < public.local_now()::date
      or (p_date = public.local_now()::date
          and p_start < (extract(hour from public.local_now())::int * 60
                       + extract(minute from public.local_now())::int) / 15 * 15)
$$;

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------

create table if not exists public.bookings (
  id          uuid primary key default gen_random_uuid(),
  user_email  text not null check (user_email = lower(user_email)),
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  date        date not null,
  start_min   smallint not null,
  end_min     smallint not null,
  status      text not null default 'confirmed' check (status in ('confirmed', 'waitlisted')),
  created_at  timestamptz not null default now(),
  promoted_at timestamptz,
  -- Session log fields (admins only)
  teacher     text    not null default '' check (char_length(teacher) <= 60),
  attendance  text    not null default '' check (attendance in ('', 'ontime', 'late', 'noshow')),
  remark      text    not null default '' check (char_length(remark) <= 200),
  internship  boolean not null default false,
  entered     boolean not null default false,

  -- 07:00 to 22:00 in 15-minute steps.
  constraint bookings_time_ok check (
    start_min >= 420 and end_min <= 1320 and start_min < end_min
    and start_min % 15 = 0 and end_min % 15 = 0),

  -- The double-booking guard. The database itself refuses two confirmed
  -- bookings that overlap on the same day, however they are written.
  constraint bookings_no_double_booking exclude using gist (
    date with =, int4range(start_min::int, end_min::int) with &&)
    where (status = 'confirmed')
);
create index if not exists bookings_date_idx on public.bookings (date);
create index if not exists bookings_owner_idx on public.bookings (user_email);

-- Outbox of email events. Only the database writes it; an Edge Function sends the mail.
create table if not exists public.outbox (
  id         bigint generated always as identity primary key,
  event      text  not null,
  booking_id uuid,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  error      text
);

-- ---------------------------------------------------------------------------
-- Access rules (row level security)
-- ---------------------------------------------------------------------------

alter table public.settings      enable row level security;
alter table public.allowed_users enable row level security;
alter table public.bookings      enable row level security;
alter table public.outbox        enable row level security;

revoke all on public.settings, public.allowed_users, public.bookings, public.outbox from anon, authenticated;
grant select on public.allowed_users to authenticated;
grant insert (email, full_name, is_admin, added_by) on public.allowed_users to authenticated;
grant delete on public.allowed_users to authenticated;
grant select, update, delete on public.bookings to authenticated;

drop policy if exists users_read on public.allowed_users;
create policy users_read on public.allowed_users for select to authenticated
  using (email = public.jwt_email() or public.is_admin());

-- Admins can add and remove ordinary staff. Admin rights themselves can only be
-- granted from the SQL editor (see scripts/setup.mjs), never from the app.
drop policy if exists users_add on public.allowed_users;
create policy users_add on public.allowed_users for insert to authenticated
  with check (public.is_admin() and is_admin = false);

drop policy if exists users_remove on public.allowed_users;
create policy users_remove on public.allowed_users for delete to authenticated
  using (public.is_admin() and is_admin = false);

drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings for select to authenticated
  using (public.is_allowed());

drop policy if exists bookings_admin_update on public.bookings;
create policy bookings_admin_update on public.bookings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists bookings_admin_delete on public.bookings;
create policy bookings_admin_delete on public.bookings for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Booking logic
-- ---------------------------------------------------------------------------

create or replace function public.day_lock(p_date date) returns void
language sql as $$
  select pg_advisory_xact_lock(hashtext('bookings:' || p_date::text))
$$;

-- Confirms the earliest waiting people whose time has become free.
create or replace function public.promote_waitlist(p_date date) returns void
language plpgsql security definer set search_path = public as $$
declare w record;
begin
  if p_date < public.local_now()::date then return; end if;
  perform public.day_lock(p_date);
  for w in select id, start_min, end_min from public.bookings
            where date = p_date and status = 'waitlisted'
            order by created_at, id
  loop
    if not exists (select 1 from public.bookings c
                    where c.date = p_date and c.status = 'confirmed'
                      and int4range(c.start_min::int, c.end_min::int) && int4range(w.start_min::int, w.end_min::int))
    then
      update public.bookings set status = 'confirmed', promoted_at = now() where id = w.id;
    end if;
  end loop;
end $$;

-- Reserve a slot. A free time is confirmed; a taken time joins the waitlist.
create or replace function public.book_slot(p_name text, p_date date, p_start int, p_end int)
returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  me text := public.jwt_email();
  new_status text;
  r public.bookings;
begin
  if not public.is_allowed() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_start < 420 or p_end > 1320 or p_start >= p_end or p_start % 15 <> 0 or p_end % 15 <> 0 then
    raise exception 'bad_time' using errcode = '22023';
  end if;
  if public.slot_is_past(p_date, p_start) then
    raise exception 'in_the_past' using errcode = '22023';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'name_required' using errcode = '22023';
  end if;

  perform public.day_lock(p_date);

  if exists (select 1 from public.bookings
              where user_email = me and date = p_date and status = 'confirmed'
                and int4range(start_min::int, end_min::int) && int4range(p_start, p_end)) then
    raise exception 'already_yours' using errcode = '22023';
  end if;

  new_status := case when exists (select 1 from public.bookings
                                   where date = p_date and status = 'confirmed'
                                     and int4range(start_min::int, end_min::int) && int4range(p_start, p_end))
                     then 'waitlisted' else 'confirmed' end;

  insert into public.bookings (user_email, name, date, start_min, end_min, status)
  values (me, left(btrim(p_name), 40), p_date, p_start, p_end, new_status)
  returning * into r;
  return r;
end $$;

-- People cancel their own future booking or waitlist place. Admins can cancel any.
create or replace function public.cancel_booking(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  select * into b from public.bookings where id = p_id;
  if not found then return; end if;
  if not (public.is_admin() or (b.user_email = public.jwt_email() and public.is_allowed())) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if b.date < public.local_now()::date and not public.is_admin() then
    raise exception 'in_the_past' using errcode = '22023';
  end if;
  perform public.day_lock(b.date);
  delete from public.bookings where id = p_id;   -- the trigger promotes the waitlist
end $$;

-- Admin: put a waiting person into a taken time and push the holder(s) to the waitlist.
create or replace function public.swap_in(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare w public.bookings;
begin
  if not public.is_admin() then raise exception 'not_allowed' using errcode = '42501'; end if;
  select * into w from public.bookings where id = p_id and status = 'waitlisted';
  if not found then raise exception 'not_waiting' using errcode = '22023'; end if;
  perform public.day_lock(w.date);
  perform set_config('app.skip_promote', '1', true);
  update public.bookings set status = 'waitlisted'
   where date = w.date and status = 'confirmed' and id <> w.id
     and int4range(start_min::int, end_min::int) && int4range(w.start_min::int, w.end_min::int);
  update public.bookings set status = 'confirmed', promoted_at = now() where id = w.id;
  perform set_config('app.skip_promote', '0', true);
  perform public.promote_waitlist(w.date);
end $$;

grant execute on function public.book_slot(text, date, int, int) to authenticated;
grant execute on function public.cancel_booking(uuid) to authenticated;
grant execute on function public.swap_in(uuid) to authenticated;
revoke execute on function public.promote_waitlist(date) from public, anon, authenticated;
grant execute on function public.jwt_email(), public.is_allowed(), public.is_admin() to authenticated;
revoke execute on function public.book_slot(text, date, int, int), public.cancel_booking(uuid), public.swap_in(uuid) from anon;

-- ---------------------------------------------------------------------------
-- Triggers: waitlist promotion and email events
-- ---------------------------------------------------------------------------

create or replace function public.bookings_after_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  freed boolean := false;
  actor text := public.jwt_email();
  ev text;
begin
  -- 1. Free a time? Then promote the waitlist.
  if tg_op = 'DELETE' then
    freed := old.status = 'confirmed';
  elsif tg_op = 'UPDATE' then
    freed := old.status = 'confirmed'
         and (new.status <> 'confirmed'
              or (old.date, old.start_min, old.end_min) is distinct from (new.date, new.start_min, new.end_min));
  end if;

  -- 2. Queue an email event.
  if tg_op = 'INSERT' then
    ev := case when new.status = 'waitlisted' then 'waitlisted' else 'booked' end;
    insert into public.outbox (event, booking_id, payload)
    values (ev, new.id, jsonb_build_object('actor', actor, 'booking', to_jsonb(new)));
  elsif tg_op = 'UPDATE' then
    if old.status = 'waitlisted' and new.status = 'confirmed' then ev := 'promoted';
    elsif old.status = 'confirmed' and new.status = 'waitlisted' then ev := 'demoted';
    elsif (old.date, old.start_min, old.end_min) is distinct from (new.date, new.start_min, new.end_min) then ev := 'moved';
    end if;
    if ev is not null then
      insert into public.outbox (event, booking_id, payload)
      values (ev, new.id, jsonb_build_object('actor', actor, 'booking', to_jsonb(new), 'previous', to_jsonb(old)));
    end if;
  else
    insert into public.outbox (event, booking_id, payload)
    values (case when actor = old.user_email then 'cancelled' else 'removed' end,
            old.id, jsonb_build_object('actor', actor, 'booking', to_jsonb(old)));
  end if;

  if freed and coalesce(current_setting('app.skip_promote', true), '0') <> '1' then
    perform public.promote_waitlist(old.date);
    if tg_op = 'UPDATE' and new.date <> old.date then
      perform public.promote_waitlist(new.date);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists bookings_after_change on public.bookings;
create trigger bookings_after_change
  after insert or update or delete on public.bookings
  for each row execute function public.bookings_after_change();

-- ---------------------------------------------------------------------------
-- Live updates for the timetable (ignored where the publication does not exist)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.bookings;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
