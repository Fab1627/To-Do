// Daily task notifications for the To-Do app.
//  - Called every 5 minutes by the database scheduler (x-cron-secret header):
//    at each person's chosen time, sends one push per task due that day.
//  - Called by the app with a signed-in user's token ({ action: "test" }):
//    sends that person's notifications right now, so they can check it works.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let cfg: Record<string, string> | null = null;
async function config() {
  if (cfg) return cfg;
  const { data, error } = await admin.rpc("get_push_config");
  if (error) throw error;
  cfg = Object.fromEntries((data as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
  return cfg;
}

// Today's date and the minute of the day in someone's own time zone.
function localNow(tz: string) {
  let zone = tz;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { zone = "America/New_York"; }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

type Task = { id: string; text: string; priority: string; tag: string | null; time: string | null; at: number | null; created_at: number };
const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const DOT: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };

function messagesFor(tasks: Task[]) {
  const sorted = [...tasks].sort((a, b) =>
    (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) ||
    (a.at ?? Infinity) - (b.at ?? Infinity) ||
    a.created_at - b.created_at
  );
  const MAX = 6;
  const shown = sorted.length > MAX ? sorted.slice(0, MAX - 1) : sorted;
  const msgs = shown.map((t) => ({
    title: `${DOT[t.priority] ?? "🟡"} ${t.text}`,
    body: ["Due today", t.time ? `at ${t.time}` : "", t.tag ? `· ${t.tag}` : ""].filter(Boolean).join(" "),
    tag: "task-" + t.id,
    url: "./",
  }));
  if (sorted.length > MAX) {
    msgs.push({
      title: `+${sorted.length - shown.length} more due today`,
      body: "Open To-Do to see the rest",
      tag: "task-more",
      url: "./",
    });
  }
  return msgs;
}

async function sendToUser(userId: string, msgs: object[]) {
  const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
  let sent = 0;
  for (const s of subs ?? []) {
    for (const m of msgs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(m),
          { TTL: 6 * 3600, urgency: "high" },
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          // That phone/browser turned notifications off or uninstalled the app.
          await admin.from("push_subscriptions").delete().eq("id", s.id);
          break;
        }
        console.error("push failed", code, (e as Error).message);
      }
    }
  }
  return { devices: subs?.length ?? 0, sent };
}

async function dueToday(userId: string, date: string) {
  const { data } = await admin.from("tasks")
    .select("id, text, priority, tag, time, at, created_at")
    .eq("user_id", userId).eq("due", date).eq("done", false);
  return (data ?? []) as Task[];
}

// Is this daily on today's schedule? (weekdays / weekends / every other day / custom days)
type Sched = { schedule?: string | null; days?: number[] | null; start_date?: string | null };
function scheduledOn(h: Sched, date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  switch (h.schedule ?? "daily") {
    case "weekdays": return dow >= 1 && dow <= 5;
    case "weekends": return dow === 0 || dow === 6;
    case "custom": return h.days?.length ? h.days.includes(dow) : true;
    case "alternate": {
      const [sy, sm, sd] = String(h.start_date ?? date).split("-").map(Number);
      const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(sy, sm - 1, sd)) / 86400000);
      return ((diff % 2) + 2) % 2 === 0;
    }
    default: return true;
  }
}

// Dailies: at each daily's own time (or the person's daily reminder time), remind them
// once per day if it isn't checked off yet.
async function dailiesRun() {
  const { data: hs } = await admin.from("habits")
    .select("id, user_id, text, tag, remind_time, last_notified, schedule, days, start_date").eq("remind", true);
  if (!hs?.length) return 0;
  const userIds = [...new Set(hs.map((h) => h.user_id))];
  const { data: prefs } = await admin.from("prefs").select("user_id, notify_time, tz, dailies_enabled, dailies_time").in("user_id", userIds);
  const pref = new Map((prefs ?? []).map((p) => [p.user_id, p]));
  const due = new Map<string, { h: typeof hs[number]; date: string }[]>();
  for (const h of hs) {
    const p = pref.get(h.user_id);
    if (p && p.dailies_enabled === false) continue;   // dailies reminders turned off
    const now = localNow(p?.tz ?? "America/New_York");
    const [hh, mm] = String(h.remind_time || p?.dailies_time || p?.notify_time || "08:00").split(":").map(Number);
    const target = hh * 60 + mm;
    if (h.last_notified === now.date || now.minutes < target || now.minutes >= target + 60) continue;
    if (!scheduledOn(h, now.date)) continue;     // not one of its days
    if (!due.has(h.user_id)) due.set(h.user_id, []);
    due.get(h.user_id)!.push({ h, date: now.date });
  }
  let sent = 0;
  for (const [userId, items] of due) {
    const ids = items.map((x) => x.h.id);
    await admin.from("habits").update({ last_notified: items[0].date }).in("id", ids);
    const { data: checks } = await admin.from("habit_checks").select("habit_id")
      .in("habit_id", ids).eq("day", items[0].date);
    const doneIds = new Set((checks ?? []).map((c) => c.habit_id));
    const msgs = items.filter((x) => !doneIds.has(x.h.id)).map((x) => ({
      title: `🔁 ${x.h.text}`,
      body: ["Daily", x.h.tag ? `· ${x.h.tag}` : "", "· tap to check it off"].filter(Boolean).join(" "),
      tag: `daily-${x.h.id}-${x.date}`,
      url: "./",
    }));
    if (msgs.length) { await sendToUser(userId, msgs); sent += msgs.length; }
  }
  return sent;
}

async function dailyRun() {
  const { data: people } = await admin.from("prefs")
    .select("user_id, notify_time, tz, last_notified").eq("notify_enabled", true);
  let notified = 0;
  for (const p of people ?? []) {
    const now = localNow(p.tz);
    const [h, m] = String(p.notify_time).split(":").map(Number);
    const target = h * 60 + m;
    // Send once per day, in the hour after the chosen time.
    if (p.last_notified === now.date || now.minutes < target || now.minutes >= target + 60) continue;
    await admin.from("prefs").update({ last_notified: now.date }).eq("user_id", p.user_id);
    const tasks = await dueToday(p.user_id, now.date);
    if (!tasks.length) continue;
    await sendToUser(p.user_id, messagesFor(tasks));
    notified++;
  }
  return notified;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const c = await config();
    if (req.headers.get("x-cron-secret") === c.cron_secret) {
      const notified = await dailyRun();
      const dailies = await dailiesRun();
      return json({ ok: true, notified, dailies });
    }
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "Sign in first." }, 401);

    const body = await req.json().catch(() => ({}));
    if (body.action !== "test") return json({ error: "Unknown action." }, 400);
    const { data: pref } = await admin.from("prefs").select("tz").eq("user_id", user.id).maybeSingle();
    const now = localNow(pref?.tz ?? "America/New_York");
    const tasks = await dueToday(user.id, now.date);
    const msgs = tasks.length
      ? messagesFor(tasks)
      : [{ title: "🔔 Notifications are on", body: "Nothing is due today. You'll get your tasks at your daily time.", tag: "test", url: "./" }];
    const result = await sendToUser(user.id, msgs);
    return json({ ok: true, tasks: tasks.length, ...result });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
