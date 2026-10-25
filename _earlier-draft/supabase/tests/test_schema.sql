\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\set d1 `date -d '+30 days' +%F`
\set d2 `date -d '+31 days' +%F`
\set dpast `date -d '-3 days' +%F`

create or replace function pg_temp.ok(c boolean, msg text) returns void language plpgsql as
$$ begin if not coalesce(c,false) then raise exception 'FAILED: %', msg; end if; raise notice 'ok  - %', msg; end $$;

-- helper: expect an error containing text
create or replace function pg_temp.fails(q text, expect text, msg text) returns void language plpgsql as
$$ begin
  begin execute q; exception when others then
    if sqlerrm like '%'||expect||'%' or sqlstate = expect then raise notice 'ok  - % (%)', msg, sqlerrm; return; end if;
    raise exception 'FAILED: % - wrong error: % [%]', msg, sqlerrm, sqlstate;
  end;
  raise exception 'FAILED: % - no error raised', msg;
end $$;

insert into public.allowed_users (email, full_name, is_admin) values
  ('boss@example.com','Boss',true), ('hod@example.com','HoD',true),
  ('a@example.com','A',false), ('b@example.com','B',false), ('c@example.com','C',false);

grant execute on all functions in schema pg_temp to public;

-- ---- as staff A: book a free slot
set role authenticated; select set_config('request.jwt.claims','{"email":"a@example.com"}',false);
select pg_temp.ok((select status from public.book_slot('Anna', :'d1', 540, 600)) = 'confirmed', 'A books 09:00-10:00 and is confirmed');
select pg_temp.fails($$select public.book_slot('Anna', '$$||:'d1'||$$', 570, 600)$$, 'already_yours', 'A cannot overlap own booking');
select pg_temp.fails($$select public.book_slot('Anna', '$$||:'dpast'||$$', 540, 600)$$, 'in_the_past', 'cannot book in the past');
select pg_temp.fails($$select public.book_slot('Anna', '$$||:'d1'||$$', 400, 600)$$, 'bad_time', 'cannot book before 07:00 or off the 15-minute grid');
select pg_temp.fails($$insert into public.bookings(user_email,name,date,start_min,end_min) values ('a@example.com','x','$$||:'d1'||$$',700,720)$$, 'permission denied', 'staff cannot insert straight into the table');
select pg_temp.fails($$select * from public.outbox$$, 'permission denied', 'staff cannot read the email outbox');

-- ---- B and C collide
select set_config('request.jwt.claims','{"email":"b@example.com"}',false);
select pg_temp.ok((select status from public.book_slot('Bea', :'d1', 570, 630)) = 'waitlisted', 'B books an overlapping time and is waitlisted');
select set_config('request.jwt.claims','{"email":"c@example.com"}',false);
select pg_temp.ok((select status from public.book_slot('Cy', :'d1', 585, 615)) = 'waitlisted', 'C books an overlapping time and is waitlisted');
select pg_temp.ok((select count(*) from public.bookings) = 3, 'staff can see all three bookings on the timetable');
with x as (update public.bookings set name='Hacked' returning 1) select pg_temp.ok((select count(*) from x) = 0, 'staff cannot edit bookings');
with x as (delete from public.bookings returning 1) select pg_temp.ok((select count(*) from x) = 0, 'staff cannot delete bookings directly');
select pg_temp.fails($$select public.cancel_booking((select id from public.bookings where name='Anna'))$$, 'not_allowed', 'C cannot cancel A''s booking');
select pg_temp.ok((select count(*) from public.allowed_users) = 1, 'staff only see their own row in the people list');
select pg_temp.fails($$insert into public.allowed_users(email) values ('x@example.com')$$, 'row-level security', 'staff cannot add people');

-- ---- outsider (signed in with Google but not on the list)
select set_config('request.jwt.claims','{"email":"stranger@example.com"}',false);
select pg_temp.ok((select count(*) from public.bookings) = 0, 'a signed-in stranger sees no bookings');
select pg_temp.fails($$select public.book_slot('Eve', '$$||:'d1'||$$', 700, 720)$$, 'not_allowed', 'a signed-in stranger cannot book');
select pg_temp.ok((select count(*) from public.allowed_users) = 0, 'a stranger sees no people');
select set_config('request.jwt.claims','{}',false);
reset role;
set role anon;
select pg_temp.fails($$select * from public.bookings$$, 'permission denied', 'a signed-out visitor cannot read bookings');
reset role;

-- ---- A cancels: B (earliest waiting) is promoted; C stays waiting
set role authenticated; select set_config('request.jwt.claims','{"email":"a@example.com"}',false);
select public.cancel_booking((select id from public.bookings where name='Anna'));
reset role;
select pg_temp.ok((select status from public.bookings where name='Bea') = 'confirmed', 'cancelling promotes the first person waiting');
select pg_temp.ok((select status from public.bookings where name='Cy') = 'waitlisted', 'the next person stays waiting while the time is taken');
select pg_temp.ok((select count(*) from public.outbox where event='promoted') = 1, 'a promotion email is queued');
select pg_temp.ok((select count(*) from public.outbox where event='waitlisted') = 2, 'two waitlist emails are queued');

-- ---- admin powers
set role authenticated; select set_config('request.jwt.claims','{"email":"boss@example.com"}',false);
select pg_temp.fails($$update public.bookings set status='confirmed' where name='Cy'$$, 'bookings_no_double_booking', 'database refuses a second confirmed booking at the same time');
select public.swap_in((select id from public.bookings where name='Cy'));
select pg_temp.ok((select status from public.bookings where name='Cy') = 'confirmed' and (select status from public.bookings where name='Bea') = 'waitlisted', 'admin swap puts C in and B on the waitlist');
update public.bookings set start_min = 720, end_min = 780 where name='Cy';
select pg_temp.ok((select status from public.bookings where name='Bea') = 'confirmed', 'admin moving C away promotes B automatically');
select pg_temp.ok((select count(*) from public.allowed_users) = 5, 'admin sees everyone');
insert into public.allowed_users(email, full_name) values ('new@example.com','New');
select pg_temp.fails($$insert into public.allowed_users(email,is_admin) values ('sneaky@example.com', true)$$, 'row-level security', 'admin cannot grant admin from the app');
with x as (delete from public.allowed_users where email='hod@example.com' returning 1) select pg_temp.ok((select count(*) from x) = 0, 'admin cannot remove another admin from the app');
with x as (delete from public.allowed_users where email='new@example.com' returning 1) select pg_temp.ok((select count(*) from x) = 1, 'admin can remove ordinary staff');
update public.bookings set attendance='late', remark='10 min late', teacher='T', entered=true where name='Bea';
select pg_temp.ok((select attendance from public.bookings where name='Bea') = 'late', 'admin can fill in the session log fields');
reset role;
select pg_temp.ok((select count(*) from public.outbox where event='demoted') = 1 and (select count(*) from public.outbox where event='moved') = 1, 'demotion and move emails are queued');
