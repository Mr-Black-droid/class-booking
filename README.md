# Class slot booking

A shared weekly timetable where staff reserve 15-minute class slots. If a time is already taken they join a waitlist, and the admins are emailed so they can sort it out. Staff sign in with Google, and only people on an approved list get in.

- **Page:** plain HTML hosted free on GitHub Pages (`web/`).
- **Database, sign-in, live updates:** Supabase, free tier (`supabase/`).
- **Email alerts:** one small Supabase function that sends through Resend (`supabase/functions/notify`).

Nothing private is stored in the code. Every address and key is a placeholder in `.env.example` that the boss (or you, on their behalf) fills in.

## How the rules work

| Rule | Where it is enforced |
| --- | --- |
| Two confirmed bookings can never overlap on the same day | A database constraint, so no bug or race can break it |
| Any length of booking, in 15-minute steps, 07:00 to 22:00 | Database checks and the page's dropdowns |
| Taking a taken time puts you on the waitlist, oldest first | `book_slot` function |
| When a booked person cancels, the first person waiting is confirmed and emailed | `promote_waiting` function |
| Only emails on the list can read or book anything | Database access rules (row level security) |
| Admins can edit, move, remove, swap and add or remove staff | Functions that check the caller is an admin |
| Admins are only the emails you list in step 3 | Set in SQL. The page cannot create admins. |

Emails sent: admins on every clash (and optionally every booking); the booker when they are promoted, moved or removed by an admin.

## Setup (about 45 minutes, once)

You will need: a GitHub account, a Supabase account, a Google account to create the sign-in credentials, and a Resend account for email. All have free plans that are enough here. The boss should own these accounts, or be invited as owner at the end (step 9).

### 1. Fill in the placeholders

Copy `.env.example` to `.env` and replace the placeholder values as you go. `.env` is never committed. Needs Node 18 or newer only for the two helper scripts.

### 2. Create the database

1. Create a project at supabase.com. Note the **Project URL** and the **anon public key** (Project Settings, API). Put them in `.env` as `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
2. Open the SQL editor, paste `supabase/migrations/0001_init.sql` and run it.

### 3. Set who may get in (the three admins)

Put the real addresses in `.env` (`ADMIN_EMAIL_BOSS`, `ADMIN_EMAIL_DEVELOPER`, `ADMIN_EMAIL_HOD`, optionally `STAFF_EMAILS`, `SITE_URL`, `TIMEZONE`). They must be the Google account addresses people sign in with. Then:

```
node scripts/make-seed.mjs
```

It refuses to run while any admin address is still a placeholder. Paste the generated `supabase/seed.generated.sql` into the SQL editor and run it. Staff can also be added later from the **People** tab, but admins can only be changed here.

### 4. Turn on Google sign-in

1. In Google Cloud Console, create an OAuth client (type: Web application). Add this authorised redirect URI: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`.
2. In Supabase, Authentication, Providers, Google: paste the client ID and secret and enable it.
3. In Supabase, Authentication, URL Configuration: set **Site URL** to your page address (step 7) and add the same address to **Redirect URLs**.
4. If the school uses Google Workspace, set the consent screen to **Internal**, and optionally put the domain in `GOOGLE_HOSTED_DOMAIN`. Otherwise use External and publish the app (only basic email and profile access is requested).

Staying signed in: the page keeps the sign-in on the device and refreshes it automatically, so people sign in once. The sign-in screen has a "Keep me signed in on this device" box (on by default); when it is off, the sign-in lasts only until the tab is closed.

### 5. Turn on email alerts

1. At resend.com create an API key and verify a sending domain (without a verified domain Resend only delivers to your own address, which is fine for testing).
2. In Supabase, Edge Functions, Secrets, set `RESEND_API_KEY`, `NOTIFY_FROM` and `WEBHOOK_SECRET` (any long random string) from `.env`.
3. Deploy the function (Supabase CLI: `supabase login`, `supabase link --project-ref YOUR-PROJECT-REF`, then `supabase functions deploy notify --no-verify-jwt`).
4. In Supabase, Database, Webhooks, create a webhook on table `outbox`, event **Insert**, type **Supabase Edge Function** (or HTTP request to `https://YOUR-PROJECT-REF.supabase.co/functions/v1/notify`), method POST, with the header `x-webhook-secret: <your WEBHOOK_SECRET>`.
5. Optional safety net: a daily scheduled call to the same URL with an empty body re-sends any email that failed.

### 6. Check it locally (optional)

```
node scripts/build-config.mjs      # writes dist/ using your .env
npx serve dist                      # open the address it prints
```

### 7. Publish on GitHub Pages

1. Create a GitHub repository and push this folder to the `main` branch.
2. Settings, Pages: set Source to **GitHub Actions**.
3. Settings, Secrets and variables, Actions, **Variables** tab: add `SUPABASE_URL` and `SUPABASE_ANON_KEY` (and optionally `GOOGLE_HOSTED_DOMAIN`, `APP_TITLE`) with the same values as your `.env`.
4. Push again (or run the workflow by hand). The page appears at `https://YOUR-ACCOUNT.github.io/REPO-NAME/`. Use this address for `SITE_URL` and in step 4.3.

The anon key is meant to be public. Safety comes from the database rules, not from hiding that key. Never put the service role key or any secret from step 5 into GitHub variables or into `web/`.

### 8. Try it

Sign in as an admin. Open the People tab and check the list. Book a slot, then book an overlapping one from another account and confirm the admins receive the clash email and the Needs attention tab shows it.

### 9. Hand over to the boss

- Supabase: Organization, Team, invite the boss as **Owner**.
- GitHub: Settings, transfer the repository, or add the boss as owner.
- Resend and Google Cloud: share ownership the same way.
- Give the boss the `.env` file privately (not by email to a group), and delete your copy if you no longer need it.
- To change an admin later, edit the three `ADMIN_EMAIL_*` values, run `node scripts/make-seed.mjs`, and also run `update public.allowed_users set role = 'staff' where email = 'old@address';` for anyone who should lose admin.

## Day-to-day

- **Book:** tap a free cell, or "Book a slot", then choose the day and the from and to times.
- **Clash:** the person is told they are on the waitlist; admins get an email and a red banner.
- **Needs attention (admins):** move a person to a free nearby time, swap them in, edit or remove.
- **Session log (admins):** your sheet's columns (teacher, date, day, hours, quantity, name, remarks, internship, entered) plus attendance. "Save as CSV for Excel" downloads it.
- **People (admins):** add or remove staff by Google email.

## Things to know

- The slot range (07:00 to 22:00, 15-minute steps) is in `0001_init.sql` (`start_min`, `end_min` checks and `valid_times`) and in the page script (`START`, `END`, `STEP`). Change both together.
- The time zone for "already passed" checks is `timezone` in `app_settings`.
- GitHub Pages on a private repository needs a paid GitHub plan. The page has no secrets, so a public repository is fine.
- Everyone on the list can see everyone's bookings and names; only admins see the staff list and the session log.
- Emails are plain text. Delivery depends on Resend and a verified domain.

## Tests

```
# database rules (needs a throwaway local Postgres 15+; never run the stub on Supabase)
PGHOST=/tmp PGPORT=5432 PGUSER=postgres ./supabase/tests/run.sh
# page in a headless browser against an in-memory stand-in for Supabase (needs Playwright)
node tests/ui-smoke.mjs
```

`_earlier-draft/` holds files from an earlier attempt that were in the folder when this version was built. They are not used and can be deleted.
