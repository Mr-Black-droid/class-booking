-- Behaviour tests. Run after 00_stub_supabase.sql and the migration.
\set ON_ERROR_STOP on
\set d '(now() at time zone ''Europe/Warsaw'')::date'

insert into allowed_users (email, role, display_name) values
  ('boss@t.test','admin','Boss'), ('dev@t.test','admin','Dev'), ('hod@t.test','admin','HoD'),
  ('a@t.test','staff','Anna'), ('b@t.test','staff','Ben'), ('c@t.test','staff','Cara');

create or replace function t_login(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, true);
  execute 'set local role authenticated';
end $$;

create or replace function t_expect_error(p_sql text, p_msg text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm like '%' || p_msg || '%' then return; end if;
    raise exception 'wrong error for [%]: got [%], wanted [%]', p_sql, sqlerrm, p_msg;
  end;
  raise exception 'expected error [%] but none for [%]', p_msg, p_sql;
end $$;

create or replace function t_assert(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok  - %', p_what;
end $$;

-- 1. free slot is confirmed
begin;
select t_login('a@t.test');
select t_assert((select status from book_slot('Anna', (:d)+3, 540, 600)) = 'confirmed', 'free slot is confirmed');
reset role;
commit;

-- 2. overlapping slot is waitlisted and admins are emailed
begin;
select t_login('b@t.test');
select t_assert((select status from book_slot('Ben', (:d)+3, 570, 630)) = 'waitlisted', 'taken slot goes to waitlist');
reset role;
select t_assert((select count(*) from outbox where kind='waitlist_joined') = 1, 'one waitlist email queued');
select t_assert((select to_emails from outbox where kind='waitlist_joined') = array['boss@t.test','dev@t.test','hod@t.test'], 'email goes to all three admins and nobody else');
commit;

-- 3. adjacent slot (touching, not overlapping) is fine
begin;
select t_login('c@t.test');
select t_assert((select status from book_slot('Cara', (:d)+3, 480, 540)) = 'confirmed', 'back-to-back slot is confirmed');
reset role;
commit;

-- 4. people not on the list are blocked everywhere
begin;
select t_login('stranger@t.test');
select t_expect_error($q$select book_slot('X', (now() at time zone 'Europe/Warsaw')::date + 5, 540, 600)$q$, 'not_allowed');
select t_assert((select count(*) from bookings) = 0, 'stranger sees no bookings');
select t_assert((select count(*) from allowed_users) = 0, 'stranger sees no staff list');
select t_assert((select whoami()) is null, 'stranger whoami is null');
reset role;
commit;

-- 5. direct table writes are impossible, even for an admin
begin;
select t_login('boss@t.test');
select t_expect_error($q$insert into bookings (owner_email,name,date,start_min,end_min) values ('x@t.test','x',current_date+9,540,600)$q$, 'permission denied');
select t_expect_error($q$delete from bookings$q$, 'permission denied');
select t_expect_error($q$select * from outbox$q$, 'permission denied');
reset role;
commit;

-- 6. own overlap, past, bad times
begin;
select t_login('a@t.test');
select t_expect_error($q$select book_slot('Anna', (now() at time zone 'Europe/Warsaw')::date + 3, 570, 630)$q$, 'own_overlap');
select t_expect_error($q$select book_slot('Anna', (now() at time zone 'Europe/Warsaw')::date - 1, 540, 600)$q$, 'in_the_past');
select t_expect_error($q$select book_slot('Anna', (now() at time zone 'Europe/Warsaw')::date + 4, 545, 600)$q$, 'bad_time');
select t_expect_error($q$select book_slot('Anna', (now() at time zone 'Europe/Warsaw')::date + 4, 400, 600)$q$, 'bad_time');
select t_expect_error($q$select book_slot('  ', (now() at time zone 'Europe/Warsaw')::date + 4, 540, 600)$q$, 'name_required');
reset role;
commit;

-- 7. the database itself refuses two overlapping confirmed bookings
select t_expect_error(
  $q$insert into bookings (owner_email,name,date,start_min,end_min,status) values ('z@t.test','Z',(now() at time zone 'Europe/Warsaw')::date+3,540,555,'confirmed')$q$,
  'no_double_booking');

-- 8. staff cannot touch other people's bookings or admin functions
begin;
select t_login('b@t.test');
select t_expect_error(format($q$select cancel_booking(%L)$q$, (select id from bookings where owner_email='a@t.test')), 'not_allowed');
select t_expect_error($q$select admin_swap_in(gen_random_uuid())$q$, 'not_allowed');
select t_expect_error($q$select admin_add_staff('new@t.test','N')$q$, 'not_allowed');
select t_expect_error($q$select admin_log_patch(gen_random_uuid(), '{}')$q$, 'not_allowed');
reset role;
commit;

-- 9. cancelling a confirmed booking promotes the first person waiting
begin;
select t_login('a@t.test');
select cancel_booking((select id from bookings where owner_email='a@t.test'));
reset role;
select t_assert((select status from bookings where owner_email='b@t.test') = 'confirmed', 'waitlisted person promoted automatically');
select t_assert((select to_emails from outbox where kind='promoted') = array['b@t.test'], 'promotion email goes to the promoted person');
commit;

-- 10. admin swap-in moves the holder to the waitlist and emails both
begin;
select t_login('a@t.test');
select t_assert((select status from book_slot('Anna', (:d)+3, 570, 600)) = 'waitlisted', 'second clash waitlisted');
reset role;
select t_login('dev@t.test');
select admin_swap_in((select id from bookings where owner_email='a@t.test' and status='waitlisted'));
reset role;
select t_assert((select status from bookings where owner_email='a@t.test') = 'confirmed', 'swap-in confirms the waiting person');
select t_assert((select status from bookings where owner_email='b@t.test') = 'waitlisted', 'swap-in moves the holder to the waitlist');
select t_assert((select count(*) from outbox where kind='moved_to_waitlist' and to_emails = array['b@t.test']) = 1, 'moved person is emailed');
commit;

-- 11. admin save reports clashes instead of failing, and can save as waitlisted
begin;
select t_login('boss@t.test');
select t_assert((select (admin_save_booking((select id from bookings where owner_email='c@t.test'), 'Cara', (:d)+3, 540, 600, 'confirmed') ->> 'ok')::boolean) = false, 'admin move into taken time returns a conflict');
select t_assert((select jsonb_array_length(admin_save_booking((select id from bookings where owner_email='c@t.test'), 'Cara', (:d)+3, 540, 600, 'confirmed') -> 'conflict')) = 1, 'conflict names the holder');
select t_assert((select (admin_save_booking((select id from bookings where owner_email='c@t.test'), 'Cara', (:d)+4, 540, 600, 'confirmed') ->> 'ok')::boolean) = true, 'admin can move a booking to a free day');
reset role;
select t_assert((select count(*) from outbox where kind='changed_by_admin' and to_emails = array['c@t.test']) = 1, 'owner is emailed about the admin change');
commit;

-- 12. admins can edit the log; staff list works; admins cannot be removed from the page
begin;
select t_login('hod@t.test');
select admin_log_patch((select id from bookings where owner_email='c@t.test'), '{"attendance":"late","remark":"10 min late","internship":true}');
select admin_add_staff('  NEW@T.test ', 'Newbie');
select t_assert((select count(*) from allowed_users where email='new@t.test') = 1, 'staff added with lower-cased email');
select t_expect_error($q$select admin_add_staff('not an email','x')$q$, 'bad_email');
select t_expect_error($q$select admin_remove_staff('boss@t.test')$q$, 'not_found');
select admin_remove_staff('new@t.test');
select t_assert((select count(*) from allowed_users) = 6, 'staff removed, admins untouched');
select t_assert((select attendance||remark||internship::text from bookings where owner_email='c@t.test') = 'late10 min latetrue', 'log patch changes only given fields');
reset role;
commit;

-- 13. admin removing someone else's booking emails the owner
begin;
select t_login('boss@t.test');
select cancel_booking((select id from bookings where owner_email='c@t.test'));
reset role;
select t_assert((select count(*) from outbox where kind='removed_by_admin') = 1, 'removal email queued');
commit;

-- 14. whoami
begin;
select t_login('hod@t.test');
select t_assert((select whoami() ->> 'role') = 'admin', 'whoami reports admin');
select t_login('a@t.test');
select t_assert((select whoami() ->> 'role') = 'staff', 'whoami reports staff');
reset role;
commit;
\echo ALL SCENARIOS PASSED
