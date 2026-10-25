-- Class slot booking: database schema, access rules and booking logic.
-- Run once in the Supabase SQL editor (or with `supabase db push`).
-- Safe to read top to bottom: tables, helpers, booking functions, access rules.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Types and tables
-- ---------------------------------------------------------------------------

create type public.booking_status as enum ('confirmed', 'waitlisted');
create type public.app_role as enum ('admin', 'staff');

-- Who may open the app. A Google sign-in whose email is not in this table sees nothing.
-- Admin rows can only be created from the SQL editor (see seed), never from the web page.
create table public.allowed_users (
  email        text primary key check (email = lower(email)),
  role         public.app_role not null default 'staff',
  display_name text,
  created_at   timestamptz not null default now()
);

create table public.app_settings (
  key   text primary key,
  value text not null
);

insert into public.app_settings (key, value) values
  ('timezone', 'Europe/Warsaw'),
  ('site_url', ''),
  ('notify_every_booking', 'false');

-- Times are minutes after midnight (07:00 = 420), always on a 15 minute step.
create table public.bookings (
  id          uuid primary key default gen_random_uuid(),
  owner_email text not null check (owner_email = lower(owner_email)),
  name        text not null check (char_length(name) between 1 and 40),
  date        date not null,
  start_min   int  not null check (start_min >= 420 and start_min < 1320 and start_min % 15 = 0),
  end_min     int  not null check (end_min > start_min and end_min <= 1320 and end_min % 15 = 0),
  status      public.booking_status not null default 'confirmed',
  created_at  timestamptz not null default now(),
  promoted_at timestamptz,
  teacher     text not null default '' check (char_length(teacher) <= 60),
  attendance  text not null default '' check (attendance in ('', 'ontime', 'late', 'noshow')),
  remark      text not null default '' check (char_length(remark) <= 200),
  internship  boolean not null default false,
  entered     boolean not null default false,
  -- The rule that makes double booking impossible: two confirmed bookings
  -- on the same day can never overlap, whatever the application does.
  constraint no_double_booking
    exclude using gist (date with =, int4range(start_min, end_min) with &&)
    where (status = 'confirmed')
);
create index bookings_date_idx  on public.bookings (date);
create index bookings_owner_idx on public.bookings (owner_email);

-- Emails waiting to be sent. The "notify" edge function reads this table.
create table public.outbox (
  id         bigserial primary key,
  kind       text not null,
  to_emails  text[] not null,
  subject    text not null,
  body       text not null,
  booking_id uuid,
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  attempts   int not null default 0,
  error      text
);
create index outbox_unsent_idx on public.outbox (id) where sent_at is null;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function public.current_email() returns text
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create function public.is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from allowed_users where email = current_email())
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from allowed_users where email = current_email() and role = 'admin')
$$;

create function public.app_setting(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select value from app_settings where key = p_key
$$;

create function public.admin_emails() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(email order by email), '{}') from allowed_users where role = 'admin'
$$;

create function public.fmt_slot(p_date date, p_start int, p_end int) returns text
language sql stable as $$
  select to_char(p_date, 'Dy DD Mon YYYY') || ', '
      || lpad((p_start / 60)::text, 2, '0') || ':' || lpad((p_start % 60)::text, 2, '0') || '-'
      || lpad((p_end / 60)::text, 2, '0')   || ':' || lpad((p_end % 60)::text, 2, '0')
$$;

create function public.queue_mail(p_kind text, p_to text[], p_subject text, p_body text, p_booking uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_site text := coalesce(app_setting('site_url'), '');
begin
  if p_to is null or array_length(p_to, 1) is null then return; end if;
  insert into outbox (kind, to_emails, subject, body, booking_id)
  values (p_kind, p_to, p_subject,
          p_body || case when v_site <> '' then E'\n\nOpen the timetable: ' || v_site else '' end,
          p_booking);
end $$;

create function public.valid_times(p_start int, p_end int) returns boolean
language sql immutable as $$
  select p_start >= 420 and p_end <= 1320 and p_end > p_start
     and p_start % 15 = 0 and p_end % 15 = 0
$$;

-- Confirm waiting bookings, oldest first, whose time has become free on a day.
create function public.promote_waiting(p_date date) returns void
language plpgsql security definer set search_path = public as $$
declare w record;
begin
  for w in
    select * from bookings where date = p_date and status = 'waitlisted' order by created_at, id
  loop
    if not exists (
      select 1 from bookings c
      where c.date = w.date and c.status = 'confirmed' and c.id <> w.id
        and int4range(c.start_min, c.end_min) && int4range(w.start_min, w.end_min)
    ) then
      update bookings set status = 'confirmed', promoted_at = now() where id = w.id;
      perform queue_mail('promoted', array[w.owner_email],
        'Your slot is confirmed: ' || fmt_slot(w.date, w.start_min, w.end_min),
        'Good news, ' || w.name || '. The time you were waiting for is free and your booking is now confirmed.' ||
        E'\n\n' || fmt_slot(w.date, w.start_min, w.end_min), w.id);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Functions the web page calls
-- ---------------------------------------------------------------------------

create function public.whoami() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('email', email, 'role', role, 'display_name', display_name)
  from allowed_users where email = current_email()
$$;

-- Reserve a slot. Confirmed if free, otherwise waitlisted and the admins are emailed.
create function public.book_slot(p_name text, p_date date, p_start int, p_end int)
returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_email  text := current_email();
  v_name   text := left(btrim(coalesce(p_name, '')), 40);
  v_now    timestamp := now() at time zone coalesce(app_setting('timezone'), 'UTC');
  v_today  date := v_now::date;
  v_nowmin int := extract(hour from v_now)::int * 60 + extract(minute from v_now)::int;
  v_status public.booking_status := 'confirmed';
  v_row    public.bookings;
  v_holder text;
begin
  if not is_allowed() then raise exception 'not_allowed'; end if;
  if v_name = '' then raise exception 'name_required'; end if;
  if p_date is null or not valid_times(p_start, p_end) then raise exception 'bad_time'; end if;
  if p_date < v_today or (p_date = v_today and p_start < (v_nowmin / 15) * 15) then
    raise exception 'in_the_past';
  end if;
  if p_date > v_today + 400 then raise exception 'too_far'; end if;

  perform pg_advisory_xact_lock(hashtext('bk:' || p_date::text));

  if exists (
    select 1 from bookings b
    where b.owner_email = v_email and b.date = p_date
      and int4range(b.start_min, b.end_min) && int4range(p_start, p_end)
  ) then raise exception 'own_overlap'; end if;

  if exists (
    select 1 from bookings b
    where b.date = p_date and b.status = 'confirmed'
      and int4range(b.start_min, b.end_min) && int4range(p_start, p_end)
  ) then v_status := 'waitlisted'; end if;

  insert into bookings (owner_email, name, date, start_min, end_min, status)
  values (v_email, v_name, p_date, p_start, p_end, v_status)
  returning * into v_row;

  if v_status = 'waitlisted' then
    select string_agg(b.name, ', ') into v_holder
    from bookings b
    where b.date = p_date and b.status = 'confirmed'
      and int4range(b.start_min, b.end_min) && int4range(p_start, p_end);
    perform queue_mail('waitlist_joined', admin_emails(),
      'Booking clash: ' || v_name || ' wants ' || fmt_slot(p_date, p_start, p_end),
      v_name || ' (' || v_email || ') asked for ' || fmt_slot(p_date, p_start, p_end) ||
      ', which is already taken by ' || coalesce(v_holder, 'someone') || '.' ||
      E'\n\nThey are on the waitlist. Open the Needs attention tab to move them, swap them in or remove them.',
      v_row.id);
  elsif app_setting('notify_every_booking') = 'true' then
    perform queue_mail('booking_created', admin_emails(),
      'New booking: ' || v_name || ', ' || fmt_slot(p_date, p_start, p_end),
      v_name || ' (' || v_email || ') booked ' || fmt_slot(p_date, p_start, p_end) || '.', v_row.id);
  end if;

  return v_row;
end $$;

-- Cancel a booking. Owners can cancel their own upcoming ones; admins can remove any.
create function public.cancel_booking(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_email text := current_email();
  v_admin boolean := is_admin();
  v_today date := (now() at time zone coalesce(app_setting('timezone'), 'UTC'))::date;
  v_date  date;
  b       public.bookings;
begin
  if not is_allowed() then raise exception 'not_allowed'; end if;
  select date into v_date from bookings where id = p_id;
  if v_date is null then raise exception 'not_found'; end if;

  perform pg_advisory_xact_lock(hashtext('bk:' || v_date::text));

  delete from bookings
  where id = p_id and (v_admin or (owner_email = v_email and date >= v_today))
  returning * into b;
  if b.id is null then raise exception 'not_allowed'; end if;

  if b.status = 'confirmed' then perform promote_waiting(b.date); end if;

  if v_admin and b.owner_email <> v_email then
    perform queue_mail('removed_by_admin', array[b.owner_email],
      'Your booking was removed: ' || fmt_slot(b.date, b.start_min, b.end_min),
      'An admin removed your booking for ' || fmt_slot(b.date, b.start_min, b.end_min) ||
      '. Contact them if this is a surprise.', b.id);
  end if;
end $$;

-- Admin: change a booking's name, day, time or status. Returns the clashes instead of failing.
create function public.admin_save_booking(
  p_id uuid, p_name text, p_date date, p_start int, p_end int, p_status text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name   text := left(btrim(coalesce(p_name, '')), 40);
  v_old    public.bookings;
  v_clash  jsonb;
  v_changed boolean;
begin
  if not is_admin() then raise exception 'not_allowed'; end if;
  if v_name = '' then raise exception 'name_required'; end if;
  if p_date is null or not valid_times(p_start, p_end) then raise exception 'bad_time'; end if;
  if p_status not in ('confirmed', 'waitlisted') then raise exception 'bad_status'; end if;

  select * into v_old from bookings where id = p_id;
  if v_old.id is null then raise exception 'not_found'; end if;

  perform pg_advisory_xact_lock(hashtext('bk:' || least(v_old.date, p_date)::text));
  if v_old.date <> p_date then
    perform pg_advisory_xact_lock(hashtext('bk:' || greatest(v_old.date, p_date)::text));
  end if;

  if p_status = 'confirmed' then
    select jsonb_agg(jsonb_build_object('name', c.name, 'start_min', c.start_min, 'end_min', c.end_min))
    into v_clash
    from bookings c
    where c.id <> p_id and c.date = p_date and c.status = 'confirmed'
      and int4range(c.start_min, c.end_min) && int4range(p_start, p_end);
    if v_clash is not null then
      return jsonb_build_object('ok', false, 'conflict', v_clash);
    end if;
  end if;

  update bookings
  set name = v_name, date = p_date, start_min = p_start, end_min = p_end,
      status = p_status::public.booking_status,
      promoted_at = case when p_status = 'confirmed' and v_old.status <> 'confirmed' then now() else promoted_at end
  where id = p_id;

  v_changed := v_old.date <> p_date or v_old.start_min <> p_start or v_old.end_min <> p_end
               or v_old.status::text <> p_status;

  if v_old.status = 'confirmed' and v_changed then perform promote_waiting(v_old.date); end if;

  if v_changed and v_old.owner_email <> current_email() then
    perform queue_mail('changed_by_admin', array[v_old.owner_email],
      'Your booking was changed: ' || fmt_slot(p_date, p_start, p_end),
      'An admin changed your booking.' ||
      E'\n\nBefore: ' || fmt_slot(v_old.date, v_old.start_min, v_old.end_min) || ' (' || v_old.status || ')' ||
      E'\nNow:    ' || fmt_slot(p_date, p_start, p_end) || ' (' || p_status || ')', p_id);
  end if;

  return jsonb_build_object('ok', true);
end $$;

-- Admin: give a waiting person the slot, moving whoever holds it to the waitlist.
create function public.admin_swap_in(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  w public.bookings;
  x record;
begin
  if not is_admin() then raise exception 'not_allowed'; end if;
  select * into w from bookings where id = p_id and status = 'waitlisted';
  if w.id is null then raise exception 'not_found'; end if;

  perform pg_advisory_xact_lock(hashtext('bk:' || w.date::text));

  for x in
    update bookings c set status = 'waitlisted'
    where c.id <> w.id and c.date = w.date and c.status = 'confirmed'
      and int4range(c.start_min, c.end_min) && int4range(w.start_min, w.end_min)
    returning c.id, c.owner_email, c.date, c.start_min, c.end_min
  loop
    perform queue_mail('moved_to_waitlist', array[x.owner_email],
      'Your booking was moved to the waitlist: ' || fmt_slot(x.date, x.start_min, x.end_min),
      'An admin gave your time to someone else, so your booking is now on the waitlist.' ||
      E'\n\n' || fmt_slot(x.date, x.start_min, x.end_min), x.id);
  end loop;

  update bookings set status = 'confirmed', promoted_at = now() where id = w.id;
  perform queue_mail('promoted', array[w.owner_email],
    'Your slot is confirmed: ' || fmt_slot(w.date, w.start_min, w.end_min),
    'An admin confirmed your booking for ' || fmt_slot(w.date, w.start_min, w.end_min) || '.', w.id);
end $$;

-- Admin: edit the session log fields. Only the keys present in the patch change.
create function public.admin_log_patch(p_id uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not_allowed'; end if;
  update bookings set
    teacher    = case when p_patch ? 'teacher'    then left(coalesce(p_patch ->> 'teacher', ''), 60)  else teacher end,
    attendance = case when p_patch ? 'attendance' then coalesce(p_patch ->> 'attendance', '')         else attendance end,
    remark     = case when p_patch ? 'remark'     then left(coalesce(p_patch ->> 'remark', ''), 200)  else remark end,
    internship = case when p_patch ? 'internship' then coalesce((p_patch ->> 'internship')::boolean, false) else internship end,
    entered    = case when p_patch ? 'entered'    then coalesce((p_patch ->> 'entered')::boolean, false)    else entered end
  where id = p_id;
  if not found then raise exception 'not_found'; end if;
end $$;

-- Admin: manage the staff list from the web page. Admins themselves are set in SQL only.
create function public.admin_add_staff(p_email text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not is_admin() then raise exception 'not_allowed'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  insert into allowed_users (email, role, display_name)
  values (v_email, 'staff', nullif(left(btrim(coalesce(p_name, '')), 60), ''))
  on conflict (email) do update
    set display_name = coalesce(excluded.display_name, allowed_users.display_name);
end $$;

create function public.admin_remove_staff(p_email text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not_allowed'; end if;
  delete from allowed_users where email = lower(btrim(coalesce(p_email, ''))) and role = 'staff';
  if not found then raise exception 'not_found'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Access rules
-- ---------------------------------------------------------------------------
-- The page can only read. Every change goes through the functions above.

alter table public.bookings      enable row level security;
alter table public.allowed_users enable row level security;
alter table public.app_settings  enable row level security;
alter table public.outbox        enable row level security;

revoke all on public.bookings, public.allowed_users, public.app_settings, public.outbox
  from anon, authenticated;
grant select on public.bookings, public.allowed_users, public.app_settings to authenticated;

create policy bookings_read on public.bookings
  for select to authenticated using (public.is_allowed());
create policy allowed_users_read on public.allowed_users
  for select to authenticated using (public.is_admin() or email = public.current_email());
create policy app_settings_read on public.app_settings
  for select to authenticated using (public.is_allowed());
-- outbox: no policies, so only the service role (the edge function) can touch it.

-- Functions: nobody may call anything by default, then open up only the page's own.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.whoami(), public.book_slot(text, date, int, int), public.cancel_booking(uuid),
  public.admin_save_booking(uuid, text, date, int, int, text), public.admin_swap_in(uuid),
  public.admin_log_patch(uuid, jsonb), public.admin_add_staff(text, text), public.admin_remove_staff(text),
  public.is_allowed(), public.is_admin(), public.current_email()
to authenticated;

-- Live updates in the page (Supabase only; skipped elsewhere).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.bookings;
  end if;
end $$;
