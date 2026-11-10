// 1回の読み書きに必要な文脈（誰が・いつ・設定）を作る。AIの「実行」のまとまりもここで決める。

import type { Env } from "../env";
import { getSettings, getValue } from "./settings";
import type { Actor, Ctx } from "./store";
import { localDate } from "./time";

export async function makeCtx(env: Env, actor: Actor): Promise<Ctx> {
  const settings = await getSettings(env.DB);
  const now = new Date();
  return { db: env.DB, actor, settings, now: now.toISOString(), today: localDate(settings.timezone, now), runId: null, proposalId: null };
}

/** AIからの呼び出しがこの時間あいたら、別の実行として数える */
const RUN_GAP_MS = 10 * 60 * 1000;
/** アプリからAIを起動してから、この時間内に始まった実行は「アプリからの入力」によるものとみなす */
const FIRE_WINDOW_MS = 5 * 60 * 1000;

export const AI_PENDING_KEY = "ai_pending_since";
export const AI_FIRED_KEY = "ai_fired_at";
export const AI_ERROR_KEY = "ai_last_error";

/**
 * MCPの呼び出しを「AIの1回の実行」にまとめる。
 * MCPサーバーは状態を持たない方式なので、呼び出しの間隔で区切る（最後の呼び出しから10分以内なら同じ実行）。
 */
export async function resolveRun(db: D1Database, now: string): Promise<string> {
  const t = Date.parse(now);
  const latest = await db.prepare("SELECT id, started_at, last_at FROM runs ORDER BY last_at DESC LIMIT 1").first<{
    id: string;
    started_at: string;
    last_at: string;
  }>();
  const firedAt = await getValue(db, AI_FIRED_KEY);
  const fired = firedAt ? Date.parse(firedAt) : 0;
  // アプリから起動した直後の呼び出しは、会話中の実行と混ざらないよう新しい実行にする
  const firedSinceLatest = fired > 0 && t - fired < FIRE_WINDOW_MS && (!latest || Date.parse(latest.started_at) < fired);
  if (latest && t - Date.parse(latest.last_at) < RUN_GAP_MS && !firedSinceLatest) {
    await db.prepare("UPDATE runs SET last_at = ? WHERE id = ?").bind(now, latest.id).run();
    return latest.id;
  }
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO runs (id, trigger, started_at, last_at) VALUES (?, ?, ?, ?)")
    .bind(id, firedSinceLatest ? "app" : "chat", now, now)
    .run();
  return id;
}
