// 「30秒まとめてからAIを1回だけ起動する」待ち合わせ。Durable Object のアラームを使う。
// きっかけ（入力・提案の却下・更新ボタン）が来るたびにアラームを30秒後へ延ばし、静かになったら起動する。

import { DurableObject } from "cloudflare:workers";
import { AI_ERROR_KEY, AI_FIRED_KEY, AI_PENDING_KEY } from "../core/context";
import { deleteValue, getValue, setValue } from "../core/settings";
import type { Env } from "../env";
import type { AiState } from "../shared/types";
import { createLauncher } from "./launcher";

const DEBOUNCE_MS = 30_000;
const RETRY_MS = 5 * 60_000;
const MAX_RETRIES = 3;
/** 起動APIの上限は1タスクあたり1時間30回。余裕を見て手前で止める */
const MAX_FIRES_PER_HOUR = 25;

export class AiQueue extends DurableObject<Env> {
  async trigger(): Promise<void> {
    await this.ctx.storage.put("retries", 0);
    await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
    if (!(await getValue(this.env.DB, AI_PENDING_KEY))) {
      await setValue(this.env.DB, AI_PENDING_KEY, new Date().toISOString());
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const fires = ((await this.ctx.storage.get<number[]>("fires")) ?? []).filter((t) => now - t < 3600_000);
    if (fires.length >= MAX_FIRES_PER_HOUR) {
      await this.ctx.storage.setAlarm(fires[0] + 3600_000 + 1000);
      return;
    }
    const db = this.env.DB;
    const result = await createLauncher(this.env)
      .launch()
      .catch((e: unknown) => ({ ok: false, retryable: true, detail: String(e) }));
    if (result.ok) {
      fires.push(now);
      await this.ctx.storage.put("fires", fires);
      await setValue(db, AI_FIRED_KEY, new Date().toISOString());
      await deleteValue(db, AI_ERROR_KEY);
      await deleteValue(db, AI_PENDING_KEY);
      return;
    }
    const retries = (await this.ctx.storage.get<number>("retries")) ?? 0;
    if (result.retryable && retries < MAX_RETRIES) {
      await this.ctx.storage.put("retries", retries + 1);
      await this.ctx.storage.setAlarm(now + RETRY_MS);
      return;
    }
    await setValue(db, AI_ERROR_KEY, result.detail ?? "error");
    await deleteValue(db, AI_PENDING_KEY);
  }
}

/** AIの起動を予約する。起動先が未設定なら何もしない（入力は保存済みなので、後でClaudeとの会話からも整理できる） */
export async function requestAi(env: Env): Promise<void> {
  if (!createLauncher(env).configured) return;
  const stub = env.AI_QUEUE.get(env.AI_QUEUE.idFromName("main")) as unknown as { trigger(): Promise<void> };
  await stub.trigger();
}

/** 画面に出す「整理中」の印 */
export async function aiState(env: Env): Promise<AiState> {
  const db = env.DB;
  const now = Date.now();
  const configured = createLauncher(env).configured;
  const pending = await getValue(db, AI_PENDING_KEY);
  const firedAt = await getValue(db, AI_FIRED_KEY);
  const lastError = await getValue(db, AI_ERROR_KEY);
  const run = await db.prepare("SELECT started_at, last_at FROM runs ORDER BY last_at DESC LIMIT 1").first<{
    started_at: string;
    last_at: string;
  }>();
  const fired = firedAt ? Date.parse(firedAt) : 0;
  const runStartedAfterFire = !!run && Date.parse(run.started_at) >= fired;
  // 起動してからAIが動き出すまで（最長5分待つ）と、AIが最後に動いてから1分間は「整理中」
  const waitingForStart = fired > 0 && now - fired < 5 * 60_000 && !runStartedAfterFire;
  const recentlyActive = !!run && now - Date.parse(run.last_at) < 60_000;
  return { organizing: !!pending || waitingForStart || recentlyActive, configured, last_error: lastError };
}
