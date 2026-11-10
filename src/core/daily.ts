// システム側の定型処理：デイリーの生成・締め・繰り越し。
// 定期処理（Cron）から呼ぶほか、読み書きのたびにも呼んで、日付が変わっていれば切り替える（定期処理が遅れても困らないように）。

import { M } from "../shared/messages";
import type { QuestRow, RecurringRow, TaskRow } from "../shared/types";
import { getOrCreateDaily } from "./ops";
import { getValue } from "./settings";
import { Tx, type Ctx } from "./store";
import { daysBetween, lastDayOfMonth, weekday } from "./time";

const ROLLOVER_KEY = "last_rollover_date";

export function recurringMatches(def: RecurringRow, date: string): boolean {
  if (!def.active || def.deleted_at) return false;
  if (def.start_date > date) return false;
  if (def.end_date && def.end_date < date) return false;
  switch (def.rule_type) {
    case "daily":
      return true;
    case "weekly":
      return (JSON.parse(def.weekdays ?? "[]") as number[]).includes(weekday(date));
    case "monthly": {
      const day = Number(date.slice(8, 10));
      return day === Math.min(def.day_of_month ?? 1, lastDayOfMonth(date));
    }
    case "interval":
      return daysBetween(def.start_date, date) % (def.interval_days ?? 1) === 0;
    default:
      return false;
  }
}

/** 繰り返しの定義から、今日のデイリーにまだ出ていないタスクを追加する。追加した件数を返す */
async function generateInto(tx: Tx, quest: QuestRow, carried: TaskRow[]): Promise<number> {
  const { db, ctx } = tx;
  const defs = await db.prepare("SELECT * FROM recurring WHERE active = 1 AND deleted_at IS NULL").all<RecurringRow>();
  const todays = await db
    .prepare("SELECT * FROM tasks WHERE recurring_id IS NOT NULL AND (generated_date = ?1 OR (quest_id = ?2 AND status = 'open' AND deleted_at IS NULL))")
    .bind(ctx.today, quest.id)
    .all<TaskRow>();
  // 今日の分が生成済み、または同じ定義の繰り越しがまだ残っているものは、重ねて出さない
  const present = new Set([...todays.results, ...carried].map((t) => t.recurring_id));
  const max = await db
    .prepare("SELECT MAX(sort_order) AS m FROM tasks WHERE quest_id = ? AND deleted_at IS NULL")
    .bind(quest.id)
    .first<{ m: number | null }>();
  let order = (max?.m ?? 0) + 1;
  let count = 0;
  for (const def of defs.results) {
    if (present.has(def.id) || !recurringMatches(def, ctx.today)) continue;
    tx.insert("tasks", {
      quest_id: quest.id,
      title: def.title,
      status: "open",
      requester: def.requester,
      location: def.location,
      required_env: def.required_env,
      sort_order: order++,
      carryover_count: 0,
      recurring_id: def.id,
      generated_date: ctx.today,
    });
    count++;
  }
  return count;
}

export async function generateRecurringForToday(ctx: Ctx): Promise<void> {
  const tx = new Tx({ ...ctx, actor: "system", proposalId: null });
  const quest = await getOrCreateDaily(tx, ctx.today);
  const n = await generateInto(tx, quest, []);
  if (n > 0) await tx.commit("daily_generate", M.summary.dailyGenerate(n), { questId: quest.id });
}

/** 日付が変わっていたら、前日までのデイリーを締めて未完了を繰り越し、今日の分を生成する */
export async function ensureDay(base: Ctx): Promise<void> {
  const last = await getValue(base.db, ROLLOVER_KEY);
  if (last && last >= base.today) return;

  // 同時に2回走らないよう、先に「今日の分は処理した」という印を取りに行く
  const claim = await base.db
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value < excluded.value",
    )
    .bind(ROLLOVER_KEY, base.today)
    .run();
  if (!claim.meta.changes) return;

  const ctx: Ctx = { ...base, actor: "system", runId: null, proposalId: null };
  try {
    const tx = new Tx(ctx);
    const old = await ctx.db
      .prepare("SELECT * FROM quests WHERE kind = 'daily' AND status = 'active' AND daily_date < ? AND deleted_at IS NULL ORDER BY daily_date")
      .bind(ctx.today)
      .all<QuestRow>();
    const today = await getOrCreateDaily(tx, ctx.today);

    const carried: TaskRow[] = [];
    for (const quest of old.results) {
      const open = await ctx.db
        .prepare("SELECT * FROM tasks WHERE quest_id = ? AND status = 'open' AND deleted_at IS NULL ORDER BY sort_order")
        .bind(quest.id)
        .all<TaskRow>();
      carried.push(...open.results);
      tx.update("quests", quest, { status: "completed", completed_at: ctx.now });
    }
    // 繰り越し分は、その日に予約済みのタスクより前に並べる
    const min = await ctx.db
      .prepare("SELECT MIN(sort_order) AS m FROM tasks WHERE quest_id = ? AND deleted_at IS NULL")
      .bind(today.id)
      .first<{ m: number | null }>();
    const start = (min?.m ?? 1) - carried.length;
    carried.forEach((t, i) => {
      tx.update("tasks", t, { quest_id: today.id, sort_order: start + i, carryover_count: t.carryover_count + 1 });
    });
    const generated = await generateInto(tx, today, carried);
    await tx.commit("daily_rollover", M.summary.dailyRollover(ctx.today, carried.length, generated), {
      questId: today.id,
      undoable: false,
    });
  } catch (e) {
    // 失敗したら印を戻して、次の機会にやり直す
    await ctx.db.prepare("UPDATE settings SET value = ?1 WHERE key = ?2 AND value = ?3").bind(last ?? "", ROLLOVER_KEY, ctx.today).run();
    throw e;
  }
}
