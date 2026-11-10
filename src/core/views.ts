// 読み出し。画面とAI（MCP）に返すデータを組み立てる。保存せず導出するもの（現在の目的・進捗・報告待ち）はここで計算する。

import { M } from "../shared/messages";
import type {
  EventRow, EventView, HomeView, InputRow, JournalView, OperationView, ProposalRow, ProposalView, QuestDetail,
  QuestRow, QuestSummary, RecurringRow, RunView, TaskRow, TaskView,
} from "../shared/types";
import { mustQuest } from "./ops";
import type { Args } from "./schemas";
import type { Ctx } from "./store";
import { addDays, localDate, localDateTime, zonedToUtc } from "./time";

const CHUNK = 80;

/** IN (...) の問い合わせを、D1の引数の上限を超えないよう分割して実行する */
async function selectIn<T>(db: D1Database, sql: (marks: string) => string, ids: string[], extra: unknown[] = []): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const r = await db
      .prepare(sql(part.map(() => "?").join(", ")))
      .bind(...extra, ...part)
      .all<T>();
    out.push(...r.results);
  }
  return out;
}

// ---------- クエスト・タスク ----------

export async function summarize(db: D1Database, quests: QuestRow[]): Promise<QuestSummary[]> {
  const ids = quests.map((q) => q.id);
  const tasks = await selectIn<TaskRow>(
    db,
    (m) => `SELECT id, quest_id, title, status, sort_order FROM tasks WHERE deleted_at IS NULL AND quest_id IN (${m}) ORDER BY sort_order, created_at`,
    ids,
  );
  const proposals = await selectIn<{ quest_id: string; n: number }>(
    db,
    (m) => `SELECT quest_id, COUNT(*) AS n FROM proposals WHERE status = 'pending' AND deleted_at IS NULL AND quest_id IN (${m}) GROUP BY quest_id`,
    ids,
  );
  const byQuest = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    if (!byQuest.has(t.quest_id)) byQuest.set(t.quest_id, []);
    byQuest.get(t.quest_id)!.push(t);
  }
  const pending = new Map(proposals.map((p) => [p.quest_id, p.n]));
  return quests.map((q) => {
    const list = (byQuest.get(q.id) ?? []).filter((t) => t.status !== "dropped");
    const open = list.filter((t) => t.status === "open");
    const first = open[0];
    return {
      id: q.id,
      title: q.title,
      kind: q.kind,
      status: q.status,
      tracked: !!q.tracked,
      completion_condition: q.completion_condition,
      requester: q.requester,
      location: q.location,
      due: q.due,
      required_env: q.required_env,
      resume_on: q.resume_on,
      daily_date: q.daily_date,
      created_at: q.created_at,
      updated_at: q.updated_at,
      completed_at: q.completed_at,
      current_objective: first ? { id: first.id, title: first.title } : null,
      progress: { done: list.length - open.length, total: list.length },
      awaiting_report: q.kind !== "daily" && q.status === "active" && list.length > 0 && open.length === 0,
      pending_proposals: pending.get(q.id) ?? 0,
    };
  });
}

/** タスクを表示用にする。依頼主・場所・期限・必要な環境が空なら、所属クエストの値を引き継ぐ */
async function taskViews(db: D1Database, tasks: TaskRow[], quests: Map<string, QuestRow>): Promise<TaskView[]> {
  const links = await selectIn<{ task_id: string; event_id: string }>(
    db,
    (m) => `SELECT task_id, event_id FROM event_links WHERE task_id IN (${m})`,
    tasks.map((t) => t.id),
  );
  const events = new Map<string, string[]>();
  for (const l of links) events.set(l.task_id, [...(events.get(l.task_id) ?? []), l.event_id]);
  return tasks.map((t) => {
    const q = quests.get(t.quest_id);
    return {
      id: t.id,
      quest_id: t.quest_id,
      title: t.title,
      status: t.status,
      requester: t.requester ?? q?.requester ?? null,
      location: t.location ?? q?.location ?? null,
      due: t.due ?? q?.due ?? null,
      required_env: t.required_env ?? q?.required_env ?? null,
      carryover_count: t.carryover_count,
      from_recurring: !!t.recurring_id,
      updated_at: t.updated_at,
      event_ids: events.get(t.id) ?? [],
    };
  });
}

async function questTasks(db: D1Database, quest: QuestRow): Promise<TaskView[]> {
  const r = await db
    .prepare("SELECT * FROM tasks WHERE quest_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at")
    .bind(quest.id)
    .all<TaskRow>();
  return taskViews(db, r.results, new Map([[quest.id, quest]]));
}

async function dailyOf(ctx: Ctx): Promise<HomeView["daily"]> {
  const quest = await ctx.db
    .prepare("SELECT * FROM quests WHERE kind = 'daily' AND daily_date = ? AND deleted_at IS NULL")
    .bind(ctx.today)
    .first<QuestRow>();
  return { quest_id: quest?.id ?? null, date: ctx.today, tasks: quest ? await questTasks(ctx.db, quest) : [] };
}

// ---------- 予定 ----------

async function eventViews(ctx: Ctx, rows: EventRow[]): Promise<EventView[]> {
  const tz = ctx.settings.timezone;
  const links = await selectIn<{ event_id: string; quest_id: string | null; task_id: string | null; quest_title: string | null; task_title: string | null }>(
    ctx.db,
    (m) =>
      `SELECT l.event_id, COALESCE(l.quest_id, t.quest_id) AS quest_id, l.task_id, q.title AS quest_title, t.title AS task_title
       FROM event_links l
       LEFT JOIN tasks t ON t.id = l.task_id AND t.deleted_at IS NULL
       LEFT JOIN quests q ON q.id = COALESCE(l.quest_id, t.quest_id) AND q.deleted_at IS NULL
       WHERE l.event_id IN (${m}) AND q.id IS NOT NULL`,
    rows.map((r) => r.id),
  );
  const views = rows.map((r): EventView => {
    const allDay = !!r.all_day;
    const start = allDay ? `${r.starts_at}T00:00` : localDateTime(tz, new Date(r.starts_at));
    const end = allDay ? `${r.ends_at ?? r.starts_at}T00:00` : localDateTime(tz, new Date(r.ends_at ?? r.starts_at));
    return {
      id: r.id,
      title: r.title,
      date: start.slice(0, 10),
      end_date: end.slice(0, 10),
      time: allDay ? null : start.slice(11),
      end_time: allDay ? null : end.slice(11),
      all_day: allDay,
      location: r.location,
      calendar_name: r.calendar_name,
      link: r.link,
      linked: links
        .filter((l) => l.event_id === r.id)
        .map((l) => ({ quest_id: l.quest_id, task_id: l.task_id, quest_title: l.quest_title, task_title: l.task_title })),
    };
  });
  return views.sort((a, b) => `${a.date}T${a.time ?? "00:00"}`.localeCompare(`${b.date}T${b.time ?? "00:00"}`));
}

/** from〜to（どちらも含む、設定のタイムゾーンでの日付）にかかる予定 */
export async function eventsBetween(ctx: Ctx, from: string, to: string, keyword?: string, limit = 200): Promise<EventView[]> {
  const tz = ctx.settings.timezone;
  const fromUtc = zonedToUtc(`${from}T00:00`, tz).toISOString();
  const toUtc = zonedToUtc(`${addDays(to, 1)}T00:00`, tz).toISOString();
  const r = await ctx.db
    .prepare(
      `SELECT * FROM calendar_events
       WHERE status = 'confirmed'
         AND ((all_day = 1 AND starts_at <= ?2 AND COALESCE(ends_at, starts_at) >= ?1)
           OR (all_day = 0 AND starts_at < ?4 AND COALESCE(ends_at, starts_at) >= ?3))
         AND (?5 IS NULL OR title LIKE ?5 OR location LIKE ?5)
       ORDER BY starts_at LIMIT ?6`,
    )
    .bind(from, to, fromUtc, toUtc, keyword ? `%${keyword}%` : null, limit)
    .all<EventRow>();
  return eventViews(ctx, r.results);
}

async function eventsByIds(ctx: Ctx, ids: string[]): Promise<EventView[]> {
  const rows = await selectIn<EventRow>(ctx.db, (m) => `SELECT * FROM calendar_events WHERE id IN (${m})`, ids);
  return eventViews(ctx, rows);
}

// ---------- 提案 ----------

async function actionText(db: D1Database, action: { op: string; args: Record<string, unknown> }): Promise<string> {
  const a = action.args;
  switch (action.op) {
    case "set_quest_status":
      return M.action.set_quest_status(
        M.questStatus[a.status as keyof typeof M.questStatus] ?? String(a.status),
        a.resume_on as string | null,
      );
    case "set_task_status":
      return M.action.set_task_status(M.taskStatus[a.status as keyof typeof M.taskStatus] ?? String(a.status));
    case "move_tasks": {
      if (a.to_daily_date) return M.action.move_tasks(M.dailyTitle(String(a.to_daily_date)));
      const q = a.to_quest_id
        ? await db.prepare("SELECT title FROM quests WHERE id = ?").bind(a.to_quest_id).first<{ title: string }>()
        : null;
      return M.action.move_tasks(q?.title ?? "");
    }
    case "add_tasks":
      return M.action.add_tasks(((a.tasks as { title: string }[]) ?? []).map((t) => t.title));
    case "update_quest":
      return M.action.update_quest;
    case "update_task":
      return M.action.update_task;
    case "append_journal":
      return M.action.append_journal;
    case "set_recurring":
      return M.action.set_recurring;
    default:
      return action.op;
  }
}

async function proposalViews(db: D1Database, rows: ProposalRow[]): Promise<ProposalView[]> {
  const out: ProposalView[] = [];
  for (const p of rows) {
    const action = JSON.parse(p.action) as { op: string; args: Record<string, unknown> };
    const quest = p.quest_id
      ? await db.prepare("SELECT title FROM quests WHERE id = ?").bind(p.quest_id).first<{ title: string }>()
      : null;
    const target =
      p.target_type === "task"
        ? await db.prepare("SELECT title FROM tasks WHERE id = ?").bind(p.target_id).first<{ title: string }>()
        : quest;
    out.push({
      id: p.id,
      kind: p.kind,
      target_type: p.target_type,
      target_id: p.target_id,
      target_title: target?.title ?? null,
      quest_id: p.quest_id,
      quest_title: quest?.title ?? null,
      action,
      action_text: await actionText(db, action),
      reason: p.reason,
      status: p.status,
      created_at: p.created_at,
      resolved_at: p.resolved_at,
    });
  }
  return out;
}

async function pendingProposals(db: D1Database, questId?: string): Promise<ProposalView[]> {
  const r = await db
    .prepare(
      `SELECT * FROM proposals WHERE status = 'pending' AND deleted_at IS NULL AND (?1 IS NULL OR quest_id = ?1) ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(questId ?? null)
    .all<ProposalRow>();
  return proposalViews(db, r.results);
}

// ---------- 画面：ホーム ----------

async function pendingInputs(db: D1Database): Promise<HomeView["pending_inputs"]> {
  const r = await db
    .prepare("SELECT id, body, created_at FROM inputs WHERE status = 'pending' AND deleted_at IS NULL ORDER BY created_at LIMIT 100")
    .all<InputRow>();
  return r.results.map((i) => ({ id: i.id, body: i.body, created_at: i.created_at }));
}

async function trackedQuests(db: D1Database): Promise<QuestSummary[]> {
  const r = await db
    .prepare("SELECT * FROM quests WHERE status = 'active' AND tracked = 1 AND kind != 'daily' AND deleted_at IS NULL")
    .all<QuestRow>();
  const list = await summarize(db, r.results);
  // 報告待ちを上に。あとは期限の近い順、期限なしは更新の新しい順
  const far = "9999";
  return list.sort(
    (a, b) =>
      Number(b.awaiting_report) - Number(a.awaiting_report) ||
      (a.due ?? far).localeCompare(b.due ?? far) ||
      b.updated_at.localeCompare(a.updated_at),
  );
}

export async function homeView(ctx: Ctx, ai: HomeView["ai"], calendarConnected: boolean): Promise<HomeView> {
  const { db } = ctx;
  const board = await db
    .prepare("SELECT COUNT(*) AS n FROM quests WHERE status = 'board' AND deleted_at IS NULL")
    .first<{ n: number }>();
  return {
    today: ctx.today,
    ai,
    settings: ctx.settings,
    pending_inputs: await pendingInputs(db),
    daily: await dailyOf(ctx),
    tracker: await trackedQuests(db),
    proposals: await pendingProposals(db),
    events: await eventsBetween(ctx, ctx.today, addDays(ctx.today, 7)),
    calendar_connected: calendarConnected,
    board_count: board?.n ?? 0,
  };
}

// ---------- クエスト詳細 ----------

export async function questDetail(ctx: Ctx, questId: string): Promise<QuestDetail> {
  const { db } = ctx;
  const quest = await mustQuest(db, questId);
  const [summary] = await summarize(db, [quest]);
  const tasks = await questTasks(db, quest);
  const journal = await db
    .prepare("SELECT id, body, author, created_at FROM journal WHERE quest_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid")
    .bind(quest.id)
    .all<JournalView>();
  const prereqs = await db
    .prepare(
      "SELECT q.id, q.title, q.status FROM quest_prereqs p JOIN quests q ON q.id = p.prereq_id WHERE p.quest_id = ? AND q.deleted_at IS NULL",
    )
    .bind(quest.id)
    .all<QuestDetail["prerequisites"][number]>();
  const links = await db
    .prepare("SELECT DISTINCT event_id FROM event_links WHERE quest_id = ?1 OR task_id IN (SELECT id FROM tasks WHERE quest_id = ?1)")
    .bind(quest.id)
    .all<{ event_id: string }>();
  return {
    ...summary,
    tasks,
    journal: journal.results,
    prerequisites: prereqs.results,
    events: await eventsByIds(ctx, links.results.map((l) => l.event_id)),
    proposals: await pendingProposals(db, quest.id),
  };
}

// ---------- 検索 ----------

export async function search(ctx: Ctx, a: Args<"search">): Promise<unknown> {
  const { db } = ctx;
  const like = a.keyword ? `%${a.keyword}%` : null;

  if (a.target === "events") {
    const from = a.from ?? ctx.today;
    const to = a.to ?? addDays(from, 30);
    const events = await eventsBetween(ctx, from, to, a.keyword, a.limit + a.offset);
    return { events: events.slice(a.offset), from, to };
  }

  const where: string[] = ["x.deleted_at IS NULL"];
  const params: unknown[] = [];
  const add = (sql: string, ...p: unknown[]) => {
    where.push(sql);
    params.push(...p);
  };
  if (a.status?.length) add(`x.status IN (${a.status.map(() => "?").join(", ")})`, ...a.status);
  if (a.updated_before) add("x.updated_at < ?", zonedToUtc(`${a.updated_before}T00:00`, ctx.settings.timezone).toISOString());

  if (a.target === "tasks") {
    // 依頼主・期限・必要な環境は、空なら所属クエストの値で判定する
    if (like) add("x.title LIKE ?", like);
    if (a.required_env) add("COALESCE(x.required_env, q.required_env) LIKE ?", `%${a.required_env}%`);
    if (a.requester) add("COALESCE(x.requester, q.requester) LIKE ?", `%${a.requester}%`);
    if (a.due_from) add("COALESCE(x.due, q.due) >= ?", a.due_from);
    if (a.due_to) add("substr(COALESCE(x.due, q.due), 1, 10) <= ?", a.due_to);
    if (a.min_carryover) add("x.carryover_count >= ?", a.min_carryover);
    if (a.kind) add("q.kind = ?", a.kind);
    const sql = `FROM tasks x JOIN quests q ON q.id = x.quest_id AND q.deleted_at IS NULL WHERE ${where.join(" AND ")}`;
    const total = await db.prepare(`SELECT COUNT(*) AS n ${sql}`).bind(...params).first<{ n: number }>();
    const rows = await db
      .prepare(`SELECT x.* ${sql} ORDER BY x.updated_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, a.limit, a.offset)
      .all<TaskRow>();
    const quests = await selectIn<QuestRow>(db, (m) => `SELECT * FROM quests WHERE id IN (${m})`, [
      ...new Set(rows.results.map((t) => t.quest_id)),
    ]);
    const qmap = new Map(quests.map((q) => [q.id, q]));
    const views = await taskViews(db, rows.results, qmap);
    return {
      total: total?.n ?? 0,
      tasks: views.map((t) => ({ ...t, quest_title: qmap.get(t.quest_id)?.title, quest_status: qmap.get(t.quest_id)?.status })),
    };
  }

  if (like) add("(x.title LIKE ? OR x.completion_condition LIKE ?)", like, like);
  if (a.kind) add("x.kind = ?", a.kind);
  if (a.required_env) add("x.required_env LIKE ?", `%${a.required_env}%`);
  if (a.requester) add("x.requester LIKE ?", `%${a.requester}%`);
  if (a.due_from) add("x.due >= ?", a.due_from);
  if (a.due_to) add("substr(x.due, 1, 10) <= ?", a.due_to);
  const sql = `FROM quests x WHERE ${where.join(" AND ")}`;
  const total = await db.prepare(`SELECT COUNT(*) AS n ${sql}`).bind(...params).first<{ n: number }>();
  const rows = await db
    .prepare(`SELECT x.* ${sql} ORDER BY x.updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...params, a.limit, a.offset)
    .all<QuestRow>();
  return { total: total?.n ?? 0, quests: await summarize(db, rows.results) };
}

// ---------- AI向け：全体の概要 ----------

export async function overview(ctx: Ctx): Promise<unknown> {
  const { db, settings } = ctx;
  const LIMIT = 100;
  const staleBefore = new Date(Date.parse(ctx.now) - settings.stale_days * 86400000).toISOString();

  const active = await db
    .prepare("SELECT * FROM quests WHERE status = 'active' AND kind != 'daily' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?")
    .bind(LIMIT)
    .all<QuestRow>();
  const onHold = await db
    .prepare("SELECT * FROM quests WHERE status = 'on_hold' AND deleted_at IS NULL ORDER BY COALESCE(resume_on, '9999'), updated_at LIMIT 50")
    .all<QuestRow>();
  const counts = await db
    .prepare("SELECT status, COUNT(*) AS n FROM quests WHERE kind != 'daily' AND deleted_at IS NULL GROUP BY status")
    .all<{ status: string; n: number }>();
  const count = (s: string) => counts.results.find((c) => c.status === s)?.n ?? 0;

  const activeList = await summarize(db, active.results);
  const holdList = await summarize(db, onHold.results);
  const daily = await dailyOf(ctx);

  const staleQuests = activeList.filter((q) => !q.awaiting_report && q.updated_at < staleBefore);
  const staleHolds = holdList.filter((q) => !q.resume_on && q.updated_at < staleBefore);
  const stuckTasks = daily.tasks.filter((t) => t.status === "open" && t.carryover_count >= settings.stalled_carryover_count);
  const oldBoard = await db
    .prepare("SELECT COUNT(*) AS n FROM quests WHERE status = 'board' AND deleted_at IS NULL AND updated_at < ?")
    .bind(staleBefore)
    .first<{ n: number }>();

  const rejectedSince = new Date(Date.parse(ctx.now) - 30 * 86400000).toISOString();
  const rejected = await db
    .prepare("SELECT * FROM proposals WHERE status = 'rejected' AND deleted_at IS NULL AND resolved_at > ? ORDER BY resolved_at DESC LIMIT 30")
    .bind(rejectedSince)
    .all<ProposalRow>();
  const recurring = await db
    .prepare("SELECT * FROM recurring WHERE deleted_at IS NULL ORDER BY active DESC, created_at LIMIT 100")
    .all<RecurringRow>();

  return {
    now: localDateTime(settings.timezone, new Date(ctx.now)),
    today: ctx.today,
    timezone: settings.timezone,
    settings: {
      followup_mode: settings.followup_mode,
      stalled_carryover_count: settings.stalled_carryover_count,
      stale_days: settings.stale_days,
    },
    unprocessed_inputs: await pendingInputs(db),
    todays_daily: daily,
    active_quests: { total: count("active"), shown: activeList.length, items: activeList },
    awaiting_report_quest_ids: activeList.filter((q) => q.awaiting_report).map((q) => q.id),
    on_hold_quests: {
      total: count("on_hold"),
      items: holdList,
      resume_date_reached_ids: holdList.filter((q) => q.resume_on && q.resume_on <= ctx.today).map((q) => q.id),
    },
    quest_board_count: count("board"),
    stalled: {
      stale_active_quest_ids: staleQuests.map((q) => q.id),
      stale_on_hold_quest_ids: staleHolds.map((q) => q.id),
      carried_over_task_ids: stuckTasks.map((t) => t.id),
      old_board_quests: oldBoard?.n ?? 0,
    },
    events_next_7_days: await eventsBetween(ctx, ctx.today, addDays(ctx.today, 7)),
    proposals: {
      pending: await pendingProposals(db),
      recently_rejected: await proposalViews(db, rejected.results),
    },
    recurring: recurring.results.map((r) => ({
      id: r.id,
      title: r.title,
      rule_type: r.rule_type,
      weekdays: r.weekdays ? (JSON.parse(r.weekdays) as number[]) : undefined,
      day_of_month: r.day_of_month ?? undefined,
      interval_days: r.interval_days ?? undefined,
      active: !!r.active,
      start_date: r.start_date,
      end_date: r.end_date,
    })),
  };
}

// ---------- 履歴 ----------

interface OperationRecord {
  id: string;
  at: string;
  actor: OperationView["actor"];
  op: string;
  summary: string;
  run_id: string | null;
  proposal_id: string | null;
  quest_id: string | null;
  undo_of: string | null;
  undone_at: string | null;
  undoable: number;
}

function toUtcBound(ctx: Ctx, s: string): string {
  return s.length === 10 ? zonedToUtc(`${s}T00:00`, ctx.settings.timezone).toISOString() : new Date(s).toISOString();
}

export async function history(ctx: Ctx, a: Args<"get_history">): Promise<{ operations: OperationView[]; has_more: boolean }> {
  const where: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (a.quest_id) (where.push("quest_id = ?"), params.push(a.quest_id));
  if (a.run_id) (where.push("run_id = ?"), params.push(a.run_id));
  if (a.since) (where.push("at >= ?"), params.push(toUtcBound(ctx, a.since)));
  if (a.until) (where.push("at <= ?"), params.push(toUtcBound(ctx, a.until)));
  const r = await ctx.db
    .prepare(`SELECT * FROM operations WHERE ${where.join(" AND ")} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .bind(...params, a.limit + 1, a.offset)
    .all<OperationRecord>();
  return {
    operations: r.results.slice(0, a.limit).map((o) => ({
      id: o.id,
      at: o.at,
      actor: o.actor,
      op: o.op,
      summary: o.summary,
      run_id: o.run_id,
      proposal_id: o.proposal_id,
      quest_id: o.quest_id,
      undo_of: o.undo_of,
      undone: !!o.undone_at,
      undoable: !!o.undoable,
    })),
    has_more: r.results.length > a.limit,
  };
}

export async function runs(db: D1Database, limit: number, offset: number): Promise<{ runs: RunView[]; has_more: boolean }> {
  const r = await db
    .prepare(
      `SELECT r.id, r.trigger, r.started_at, r.last_at,
        (SELECT COUNT(*) FROM operations o WHERE o.run_id = r.id AND o.undo_of IS NULL AND o.op != 'propose') AS operations,
        (SELECT COUNT(*) FROM operations o WHERE o.run_id = r.id AND o.undo_of IS NULL AND o.undone_at IS NOT NULL) AS undone,
        (SELECT COUNT(*) FROM proposals p WHERE p.run_id = r.id AND p.deleted_at IS NULL) AS proposals
       FROM runs r ORDER BY r.started_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(limit + 1, offset)
    .all<RunView>();
  return { runs: r.results.slice(0, limit), has_more: r.results.length > limit };
}

export async function recurringList(db: D1Database): Promise<RecurringRow[]> {
  const r = await db.prepare("SELECT * FROM recurring WHERE deleted_at IS NULL ORDER BY active DESC, created_at").all<RecurringRow>();
  return r.results;
}

export { localDate };
