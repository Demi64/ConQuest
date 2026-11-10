// 画面のログイン。利用者は1人なので、パスワード（secret の OWNER_PASSWORD）だけで確認する。

import type { Env } from "../env";
import { M } from "../shared/messages";
import { OpError } from "../core/store";
import { randomToken, safeEqual, sha256Hex } from "./crypto";

const COOKIE = "cq_session";
const SESSION_DAYS = 90;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

/** パスワードを確かめる。総当たりを防ぐため、失敗が続いたらしばらく受け付けない */
export async function checkPassword(env: Env, password: string): Promise<void> {
  if (!env.OWNER_PASSWORD) throw new OpError(M.error.notConfigured(M.ui.login.password), 503);
  const since = new Date(Date.now() - FAILURE_WINDOW_MS).toISOString();
  const failures = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE at > ?").bind(since).first<{ n: number }>();
  if ((failures?.n ?? 0) >= MAX_FAILURES) throw new OpError(M.error.tooManyAttempts, 429);
  if (!(await safeEqual(password, env.OWNER_PASSWORD))) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO login_attempts (at) VALUES (?)").bind(new Date().toISOString()),
      env.DB.prepare("DELETE FROM login_attempts WHERE at <= ?").bind(since),
    ]);
    throw new OpError(M.error.badPassword, 401);
  }
}

export async function createSession(env: Env): Promise<string> {
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)").bind(
      await sha256Hex(token), now.toISOString(), expires.toISOString(),
    ),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now.toISOString()),
  ]);
  return sessionCookie(token, SESSION_DAYS * 86400);
}

function sessionCookie(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readToken(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

export async function hasSession(env: Env, request: Request): Promise<boolean> {
  const token = readToken(request);
  if (!token) return false;
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).first<{
    expires_at: string;
  }>();
  return !!row && row.expires_at > new Date().toISOString();
}

export async function destroySession(env: Env, request: Request): Promise<string> {
  const token = readToken(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return sessionCookie("", 0);
}
