// Googleカレンダーの読み込み（読み取り専用）。予定の正は外部カレンダーで、ここでは表示用の写しを取り込むだけ。
// 別のカレンダー（CalDAV／iCal）を足すときは、同じ形（connect / sync）の部品を並べる。

import { deleteValue, getValue, setValue } from "../core/settings";
import { addDays, localDate } from "../core/time";
import type { Env } from "../env";
import { decrypt, encrypt, randomToken } from "../web/crypto";

const PROVIDER = "google";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const TOKEN_KEY = "google_refresh_token";
const STATE_KEY = "google_oauth_state";
const SYNC_KEY = "google_last_sync";
const ERROR_KEY = "google_last_error";
/** 取り込む範囲：昨日から90日先まで */
const DAYS_BACK = 1;
const DAYS_AHEAD = 90;

export const googleReady = (env: Env): boolean => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.ENCRYPTION_KEY);

export async function calendarStatus(env: Env): Promise<{ ready: boolean; connected: boolean; last_sync: string | null; last_error: string | null }> {
  return {
    ready: googleReady(env),
    connected: !!(await getValue(env.DB, TOKEN_KEY)),
    last_sync: await getValue(env.DB, SYNC_KEY),
    last_error: await getValue(env.DB, ERROR_KEY),
  };
}

const redirectUri = (origin: string): string => `${origin}/google/callback`;

/** Googleの許可画面のURLを作る */
export async function connectUrl(env: Env, origin: string): Promise<string> {
  const state = randomToken(24);
  await setValue(env.DB, STATE_KEY, JSON.stringify({ state, expires: Date.now() + 10 * 60_000 }));
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** 許可画面から戻ってきたときの処理。更新用トークンを暗号化して保存する */
export async function finishConnect(env: Env, origin: string, code: string, state: string): Promise<void> {
  const saved = JSON.parse((await getValue(env.DB, STATE_KEY)) ?? "{}") as { state?: string; expires?: number };
  await deleteValue(env.DB, STATE_KEY);
  if (!saved.state || saved.state !== state || (saved.expires ?? 0) < Date.now()) throw new Error("state mismatch");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json()) as { refresh_token?: string; error?: string };
  if (!res.ok || !body.refresh_token) throw new Error(`token exchange failed: ${body.error ?? res.status}`);
  await setValue(env.DB, TOKEN_KEY, await encrypt(env.ENCRYPTION_KEY!, body.refresh_token));
  await deleteValue(env.DB, ERROR_KEY);
}

export async function disconnect(env: Env): Promise<void> {
  const boxed = await getValue(env.DB, TOKEN_KEY);
  if (boxed && env.ENCRYPTION_KEY) {
    const token = await decrypt(env.ENCRYPTION_KEY, boxed).catch(() => null);
    if (token) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => null);
    }
  }
  await deleteValue(env.DB, TOKEN_KEY);
  await deleteValue(env.DB, SYNC_KEY);
  await deleteValue(env.DB, ERROR_KEY);
  // 写しは非表示にするだけで行は残す（紐づけが同じ行を指しているので、つなぎ直すと元に戻る）
  await env.DB.prepare("UPDATE calendar_events SET status = 'cancelled' WHERE provider = ?").bind(PROVIDER).run();
}

async function accessToken(env: Env): Promise<string | null> {
  const boxed = await getValue(env.DB, TOKEN_KEY);
  if (!boxed || !googleReady(env)) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: await decrypt(env.ENCRYPTION_KEY!, boxed),
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`token refresh failed: ${body.error ?? res.status}`);
  return body.access_token;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`google api ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** 予定の写しを取り込み直す。接続していなければ何もしない */
export async function syncCalendar(env: Env, timezone: string): Promise<{ synced: boolean; events?: number }> {
  try {
    const token = await accessToken(env);
    if (!token) return { synced: false };
    const db = env.DB;
    const now = new Date();
    const fetchedAt = now.toISOString();
    const today = localDate(timezone, now);
    const timeMin = new Date(now.getTime() - DAYS_BACK * 86400_000).toISOString();
    const timeMax = new Date(now.getTime() + DAYS_AHEAD * 86400_000).toISOString();

    // カレンダーの一覧のうち、Googleカレンダーの画面で表示にしているものを取り込む
    const list = await getJson<{ items?: { id: string; summary?: string; summaryOverride?: string; selected?: boolean }[] }>(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250",
      token,
    );
    const calendars = (list.items ?? []).filter((c) => c.selected);
    let count = 0;
    for (const cal of calendars) {
      const stmts: D1PreparedStatement[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin, timeMax, maxResults: "250" });
        if (pageToken) q.set("pageToken", pageToken);
        const page = await getJson<{ items?: GoogleEvent[]; nextPageToken?: string }>(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${q}`,
          token,
        );
        for (const ev of page.items ?? []) {
          if (ev.status === "cancelled" || !ev.start) continue;
          const allDay = !!ev.start.date;
          // 終日の予定の終了日は「翌日」で届くので、最終日に直す。時刻つきはUTCにそろえる
          const startsAt = allDay ? ev.start.date! : new Date(ev.start.dateTime!).toISOString();
          const endsAt = allDay
            ? ev.end?.date ? addDays(ev.end.date, -1) : ev.start.date!
            : ev.end?.dateTime ? new Date(ev.end.dateTime).toISOString() : startsAt;
          stmts.push(
            db
              .prepare(
                `INSERT INTO calendar_events (id, provider, calendar_id, external_id, calendar_name, title, starts_at, ends_at, all_day, location, link, status, fetched_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)
                 ON CONFLICT(provider, calendar_id, external_id) DO UPDATE SET
                   calendar_name = excluded.calendar_name, title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
                   all_day = excluded.all_day, location = excluded.location, link = excluded.link, status = 'confirmed', fetched_at = excluded.fetched_at`,
              )
              .bind(
                crypto.randomUUID(), PROVIDER, cal.id, ev.id, cal.summaryOverride ?? cal.summary ?? null, ev.summary ?? null,
                startsAt, endsAt, allDay ? 1 : 0, ev.location ?? null, ev.htmlLink ?? null, fetchedAt,
              ),
          );
          count++;
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      // 今回届かなかった今日以降の予定は、消されたか動かされたもの
      stmts.push(
        db
          .prepare(
            "UPDATE calendar_events SET status = 'cancelled' WHERE provider = ? AND calendar_id = ? AND fetched_at < ? AND substr(COALESCE(ends_at, starts_at), 1, 10) >= ?",
          )
          .bind(PROVIDER, cal.id, fetchedAt, today),
      );
      for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    }
    // 表示をやめたカレンダーの予定と、古くなった写しを片づける（紐づけのあるものは残す）
    const keep = calendars.map((c) => c.id);
    await db
      .prepare(
        `UPDATE calendar_events SET status = 'cancelled' WHERE provider = ?1 AND fetched_at < ?2 AND calendar_id NOT IN (SELECT value FROM json_each(?3))`,
      )
      .bind(PROVIDER, fetchedAt, JSON.stringify(keep))
      .run();
    await db
      .prepare(
        "DELETE FROM calendar_events WHERE provider = ? AND substr(COALESCE(ends_at, starts_at), 1, 10) < ? AND id NOT IN (SELECT event_id FROM event_links)",
      )
      .bind(PROVIDER, addDays(today, -30))
      .run();
    await setValue(db, SYNC_KEY, fetchedAt);
    await deleteValue(db, ERROR_KEY);
    return { synced: true, events: count };
  } catch (e) {
    console.error("calendar sync failed", e);
    await setValue(env.DB, ERROR_KEY, String(e instanceof Error ? e.message : e).slice(0, 300));
    return { synced: false };
  }
}
