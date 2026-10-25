// Sends the emails waiting in the `outbox` table, using Resend (https://resend.com).
//
// How it is triggered:
//   1. A Supabase Database Webhook fires on every INSERT into public.outbox and POSTs the
//      new row here. We send that email straight away.
//   2. Calling this function with an empty body (for example from a daily scheduled job)
//      sends anything still unsent, which covers a Resend outage or a missed webhook.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   RESEND_API_KEY, NOTIFY_FROM, WEBHOOK_SECRET
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to the function automatically.
//
// Deploy with:  supabase functions deploy notify --no-verify-jwt
// (--no-verify-jwt because the webhook proves itself with WEBHOOK_SECRET instead.)

type OutboxRow = {
  id: number;
  to_emails: string[];
  subject: string;
  body: string;
  sent_at?: string | null;
  attempts?: number;
};

const env = (k: string) => Deno.env.get(k) ?? "";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function sendOne(row: OutboxRow): Promise<void> {
  let error: string | null = null;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env("RESEND_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env("NOTIFY_FROM"), to: row.to_emails, subject: row.subject, text: row.body }),
    });
    if (!res.ok) error = `Resend ${res.status}: ${(await res.text()).slice(0, 300)}`;
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 300);
  }
  const patch = error
    ? { attempts: (row.attempts ?? 0) + 1, error }
    : { sent_at: new Date().toISOString(), attempts: (row.attempts ?? 0) + 1, error: null };
  await rest(`outbox?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify(patch) });
  if (error) throw new Error(error);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const secret = env("WEBHOOK_SECRET");
  if (!secret || !safeEqual(req.headers.get("x-webhook-secret") ?? "", secret)) {
    return json(401, { error: "unauthorized" });
  }
  if (!env("RESEND_API_KEY") || !env("NOTIFY_FROM")) return json(500, { error: "RESEND_API_KEY or NOTIFY_FROM not set" });

  let payload: { record?: OutboxRow } = {};
  try {
    payload = await req.json();
  } catch (_) { /* empty body means "flush everything unsent" */ }

  let rows: OutboxRow[] = [];
  if (payload.record && payload.record.id) {
    // Re-read the row so a replayed or forged payload can never change what is sent.
    const res = await rest(`outbox?id=eq.${payload.record.id}&sent_at=is.null&select=*`);
    rows = res.ok ? await res.json() : [];
  } else {
    const res = await rest("outbox?sent_at=is.null&attempts=lt.5&order=id.asc&limit=50&select=*");
    rows = res.ok ? await res.json() : [];
  }

  let sent = 0;
  const failures: string[] = [];
  for (const row of rows) {
    try {
      await sendOne(row);
      sent++;
    } catch (e) {
      failures.push(`#${row.id}: ${(e as Error).message}`);
    }
  }
  return json(failures.length ? 502 : 200, { sent, failed: failures.length, failures });
});
