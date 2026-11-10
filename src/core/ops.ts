// 書き込みの操作。MCP（AI）・画面（人）・提案の承認（システムが実行）のどこから来ても、必ずここを通る。

import { M } from "../shared/messages";
import type { InputRow, ProposalRow, QuestRow, QuestStatus, RecurringRow, TaskRow } from "../shared/types";
import { generateRecurringForToday } from "./daily";
import { PROPOSABLE_OPS, schemas, type Args, type OpName } from "./schemas";
import { getSettings, settingsStatement } from "./settings";
import { OpError, Tx, findRow, type Ctx, type Row } from "./store";
import { isTimeZone, isValidDate } from "./time";
import { undo } from "./undo";

// ---------- 読み出しの小道具 ----------

export async function mustQuest(db: D1Database, id: string): Promise<QuestRow> {
  const row = await findRow<QuestRow>(db, "quests", id);
  if (!row || row.deleted_at) throw new OpError(M.error.notFound(M.error.quest), 404);
  return row;
}

export async function mustTask(db: D1Database, id: string): Promise<TaskRow> {
  const row = await findRow<TaskRow>(db, "tasks", id);
  if (!row || row.deleted_at) throw new OpError(M.error.notFound(M.error.task), 404);
  return row;
}

async function tasksOf(db: D1Database, questId: string): Promise<TaskRow[]> {
  const r = await db
    .prepare("SELECT * FROM tasks WHERE quest_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at")
    .bind(questId)
    .all<TaskRow>();
  return r.results;
}

function assertOpen(q: QuestRow): void {
  if (q.status === "completed" || q.status === "discarded") {
    throw new OpError(M.error.closedQuest(M.questStatus[q.status]));
  }
}

function assertDate(d: string | null | undefined): void {
  if (d && !isValidDate(d.slice(0, 10))) throw new OpError(M.error.badDate);
}

// ---------- 共通の部品 ----------

/** 元になった入力を処理済みにする */
async function markInputs(tx: Tx, ids: string[] | undefined): Promise<void> {
  for (const id of new Set(ids ?? [])) {
    const input = await findRow<InputRow>(tx.db, "inputs", id);
    if (!input || input.deleted_at) throw new OpError(M.error.notFound(M.error.input), 404);
    if (input.status !== "pending") continue;
    tx.update("inputs", input, { status: "processed", processed_run_id: tx.ctx.runId ?? null, processed_at: tx.ctx.now });
  }
}

async function linkEvents(tx: Tx, eventIds: string[] | undefined, target: { questId?: string; taskId?: string }): Promise<void> {
  for (const eventId of new Set(eventIds ?? [])) {
    const ev = await tx.db.prepare("SELECT id FROM calendar_events WHERE id = ?").bind(eventId).first();
    if (!ev) throw new OpError(M.error.notFound(M.error.event), 404);
    const col = target.taskId ? "task_id" : "quest_id";
    const exists = await tx.db
      .prepare(`SELECT id FROM event_links WHERE event_id = ? AND ${col} = ?`)
      .bind(eventId, target.taskId ?? target.questId)
      .first();
    if (exists) continue;
    tx.insert("event_links", { event_id: eventId, quest_id: target.questId ?? null, task_id: target.taskId ?? null });
  }
}

async function unlinkEvents(tx: Tx, eventIds: string[] | undefined, target: { questId?: string; taskId?: string }): Promise<void> {
  for (const eventId of new Set(eventIds ?? [])) {
    const col = target.taskId ? "task_id" : "quest_id";
    const rows = await tx.db
      .prepare(`SELECT * FROM event_links WHERE event_id = ? AND ${col} = ?`)
      .bind(eventId, target.taskId ?? target.questId)
      .all<Row>();
    for (const r of rows.results) tx.remove("event_links", r);
  }
}

/** その日付のデイリークエストを取得する。なければ作る */
export async function getOrCreateDaily(tx: Tx, date: string): Promise<QuestRow> {
  const existing = await tx.db
    .prepare("SELECT * FROM quests WHERE kind = 'daily' AND daily_date = ?")
    .bind(date)
    .first<QuestRow>();
  if (existing) {
    // 取り消しなどで消えていた場合は戻して使う
    return existing.deleted_at ? tx.update("quests", existing, { deleted_at: null, status: "active" }) : existing;
  }
  return tx.insert("quests", {
    title: M.dailyTitle(date),
    kind: "daily",
    status: "active",
    tracked: 0,
    daily_date: date,
  }) as unknown as QuestRow;
}

/** 追加・移動するタスクの並び順を決める */
function sortOrders(
  existing: TaskRow[],
  count: number,
  position: "start" | "end" | "after" | undefined,
  afterTaskId: string | undefined,
): number[] {
  const orders = existing.map((t) => t.sort_order);
  if (position === "start") {
    const min = orders.length ? Math.min(...orders) : 0;
    return Array.from({ length: count }, (_, i) => min - count + i);
  }
  if (position === "after") {
    if (!afterTaskId) throw new OpError(M.error.afterTaskMissing);
    const idx = existing.findIndex((t) => t.id === afterTaskId);
    if (idx < 0) throw new OpError(M.error.notFound(M.error.task), 404);
    const lo = existing[idx].sort_order;
    const hi = idx + 1 < existing.length ? existing[idx + 1].sort_order : lo + count + 1;
    const step = (hi - lo) / (count + 1);
    return Array.from({ length: count }, (_, i) => lo + step * (i + 1));
  }
  const max = orders.length ? Math.max(...orders) : 0;
  return Array.from({ length: count }, (_, i) => max + 1 + i);
}

/** 対象が先に変わって意味がなくなった承認待ちの提案を、期限切れにする */
async function expireProposals(tx: Tx, where: { questId?: string; targetId?: string }): Promise<void> {
  const col = where.questId ? "quest_id" : "target_id";
  const rows = await tx.db
    .prepare(`SELECT * FROM proposals WHERE ${col} = ? AND status = 'pending' AND deleted_at IS NULL`)
    .bind(where.questId ?? where.targetId)
    .all<ProposalRow>();
  for (const p of rows.results) {
    if (p.id === tx.ctx.proposalId) continue;
    tx.update("proposals", p, { status: "expired", resolved_at: tx.ctx.now });
  }
}

const emptyToNull = (v: string | null | undefined): string | null | undefined => (v === "" ? null : v);

// ---------- 操作 ----------

type Handler<K extends OpName> = (ctx: Ctx, args: Args<K>) => Promise<unknown>;

const addInput: Handler<"add_input"> = async (ctx, a) => {
  const tx = new Tx(ctx);
  const row = tx.insert("inputs", { body: a.body, source: a.source, status: "pending" });
  await tx.commit("add_input", M.summary.addInput);
  return { input_id: row.id };
};

export async function acknowledgeInputs(ctx: Ctx, ids: string[]): Promise<void> {
  const tx = new Tx(ctx);
  await markInputs(tx, ids);
  await tx.commit("acknowledge_inputs", M.summary.ackInputs(ids.length));
}

const createQuest: Handler<"create_quest"> = async (ctx, a) => {
  const isEvent = a.kind === "event";
  if (isEvent && !a.due) throw new OpError(M.error.eventNeedsDue);
  assertDate(a.due);
  const status: QuestStatus = isEvent ? "active" : a.placement;
  const tx = new Tx(ctx);
  const quest = tx.insert("quests", {
    title: a.title,
    kind: a.kind,
    completion_condition: a.completion_condition,
    status,
    tracked: (a.tracked ?? status === "active") ? 1 : 0,
    requester: emptyToNull(a.requester) ?? null,
    location: emptyToNull(a.location) ?? null,
    due: a.due ?? null,
    required_env: emptyToNull(a.required_env) ?? null,
  });
  const taskIds: string[] = [];
  for (const [i, t] of (a.tasks ?? []).entries()) {
    assertDate(t.due);
    const task = tx.insert("tasks", {
      quest_id: quest.id,
      title: t.title,
      status: "open",
      requester: emptyToNull(t.requester) ?? null,
      location: emptyToNull(t.location) ?? null,
      due: t.due ?? null,
      required_env: emptyToNull(t.required_env) ?? null,
      sort_order: i + 1,
      carryover_count: 0,
    });
    taskIds.push(task.id);
    await linkEvents(tx, t.event_ids, { taskId: task.id });
  }
  await linkEvents(tx, a.event_ids, { questId: quest.id });
  for (const pid of new Set(a.prerequisite_ids ?? [])) {
    await mustQuest(ctx.db, pid);
    tx.insert("quest_prereqs", { quest_id: quest.id, prereq_id: pid });
  }
  await markInputs(tx, a.source_input_ids);
  await tx.commit("create_quest", M.summary.createQuest(a.title, M.questStatus[status]), { questId: quest.id });
  return { quest_id: quest.id, status, task_ids: taskIds };
};

const updateQuest: Handler<"update_quest"> = async (ctx, a) => {
  const quest = await mustQuest(ctx.db, a.quest_id);
  if (quest.kind === "daily") throw new OpError(M.error.dailyIsSystem);
  assertDate(a.due);
  const tx = new Tx(ctx);
  tx.update("quests", quest, {
    completion_condition: a.completion_condition,
    requester: emptyToNull(a.requester),
    location: emptyToNull(a.location),
    due: a.due,
    required_env: emptyToNull(a.required_env),
    tracked: a.tracked === undefined ? undefined : a.tracked ? 1 : 0,
  });
  await linkEvents(tx, a.add_event_ids, { questId: quest.id });
  await unlinkEvents(tx, a.remove_event_ids, { questId: quest.id });
  if (a.prerequisite_ids) {
    const wanted = new Set(a.prerequisite_ids);
    if (wanted.has(quest.id)) throw new OpError(M.error.selfPrereq);
    const current = await ctx.db.prepare("SELECT * FROM quest_prereqs WHERE quest_id = ?").bind(quest.id).all<Row>();
    for (const r of current.results) {
      if (wanted.has(r.prereq_id as string)) wanted.delete(r.prereq_id as string);
      else tx.remove("quest_prereqs", r);
    }
    for (const pid of wanted) {
      await mustQuest(ctx.db, pid);
      tx.insert("quest_prereqs", { quest_id: quest.id, prereq_id: pid });
    }
  }
  await markInputs(tx, a.source_input_ids);
  if (!tx.isEmpty) tx.touchQuest(quest.id);
  await tx.commit("update_quest", M.summary.updateQuest(quest.title), { questId: quest.id });
  return { quest_id: quest.id };
};

const setQuestStatus: Handler<"set_quest_status"> = async (ctx, a) => {
  const quest = await mustQuest(ctx.db, a.quest_id);
  if (quest.kind === "daily") throw new OpError(M.error.dailyIsSystem);
  if (quest.status === "completed" || (quest.status === "discarded" && ctx.actor === "ai")) {
    // 完了を取り消す・破棄から戻すのは人の操作（reopen_quest）に限る
    throw new OpError(M.error.completedNeedsHuman);
  }
  assertDate(a.resume_on);
  const resumeOn = a.status === "on_hold" ? (a.resume_on ?? null) : null;
  if (quest.status === a.status && (quest.resume_on ?? null) === resumeOn) {
    throw new OpError(M.error.sameStatus(M.questStatus[a.status]));
  }
  const tx = new Tx(ctx);
  tx.update("quests", quest, {
    status: a.status,
    resume_on: resumeOn,
    // 受注したら追跡を始め、受注中でなくなったらトラッカーから外す
    tracked: a.status === "active" ? (quest.status === "active" ? quest.tracked : 1) : 0,
  });
  tx.insert("journal", {
    quest_id: quest.id,
    body: M.journal.status(M.questStatus[a.status], a.reason, resumeOn),
    author: ctx.actor,
  });
  if (a.status === "discarded") await expireProposals(tx, { questId: quest.id });
  else await expireProposals(tx, { targetId: quest.id });
  await markInputs(tx, a.source_input_ids);
  tx.touchQuest(quest.id);
  await tx.commit("set_quest_status", M.summary.setQuestStatus(quest.title, M.questStatus[a.status]), { questId: quest.id });
  return { quest_id: quest.id, status: a.status };
};

const completeQuest: Handler<"complete_quest"> = async (ctx, a) => {
  if (ctx.actor !== "human") throw new OpError(M.error.humanOnly, 403);
  const quest = await mustQuest(ctx.db, a.quest_id);
  if (quest.kind === "daily") throw new OpError(M.error.dailyIsSystem);
  assertOpen(quest);
  const tx = new Tx(ctx);
  tx.update("quests", quest, { status: "completed", completed_at: ctx.now, tracked: 0, resume_on: null });
  tx.insert("journal", { quest_id: quest.id, body: M.journal.completed, author: "human" });
  await expireProposals(tx, { questId: quest.id });
  await tx.commit("complete_quest", M.summary.completeQuest(quest.title), { questId: quest.id });
  return { quest_id: quest.id, status: "completed" };
};

const reopenQuest: Handler<"reopen_quest"> = async (ctx, a) => {
  if (ctx.actor !== "human") throw new OpError(M.error.humanOnly, 403);
  const quest = await mustQuest(ctx.db, a.quest_id);
  if (quest.kind === "daily") throw new OpError(M.error.dailyIsSystem);
  if (quest.status !== "completed" && quest.status !== "discarded") {
    throw new OpError(M.error.sameStatus(M.questStatus[quest.status]));
  }
  const tx = new Tx(ctx);
  tx.update("quests", quest, { status: "active", completed_at: null, tracked: 1 });
  tx.insert("journal", { quest_id: quest.id, body: M.journal.reopened, author: "human" });
  await tx.commit("reopen_quest", M.summary.reopenQuest(quest.title), { questId: quest.id });
  return { quest_id: quest.id, status: "active" };
};

/** 完全削除。人が画面から、破棄済みのクエストに対してだけ行える。履歴からも中身を消す */
const purgeQuest: Handler<"purge_quest"> = async (ctx, a) => {
  if (ctx.actor !== "human") throw new OpError(M.error.humanOnly, 403);
  const quest = await mustQuest(ctx.db, a.quest_id);
  if (quest.status !== "discarded") throw new OpError(M.error.purgeNeedsDiscard);
  const db = ctx.db;
  const tx = new Tx(ctx);
  const sub = "SELECT id FROM tasks WHERE quest_id = ?1";
  for (const sql of [
    `DELETE FROM changes WHERE entity_id = ?1 OR entity_id IN (${sub}) OR entity_id IN (SELECT id FROM journal WHERE quest_id = ?1) OR entity_id IN (SELECT id FROM proposals WHERE quest_id = ?1)`,
    `DELETE FROM event_links WHERE quest_id = ?1 OR task_id IN (${sub})`,
    "DELETE FROM proposals WHERE quest_id = ?1",
    "DELETE FROM journal WHERE quest_id = ?1",
    "DELETE FROM quest_prereqs WHERE quest_id = ?1 OR prereq_id = ?1",
    "DELETE FROM tasks WHERE quest_id = ?1",
    "UPDATE operations SET undoable = 0, quest_id = NULL WHERE quest_id = ?1",
    "DELETE FROM quests WHERE id = ?1",
  ]) {
    tx.raw(db.prepare(sql).bind(quest.id));
  }
  await tx.commit("purge_quest", M.summary.purgeQuest(quest.title), { undoable: false, force: true });
  return { purged: true };
};

const appendJournal: Handler<"append_journal"> = async (ctx, a) => {
  const quest = await mustQuest(ctx.db, a.quest_id);
  const tx = new Tx(ctx);
  const entry = tx.insert("journal", { quest_id: quest.id, body: a.body, author: ctx.actor });
  await markInputs(tx, a.source_input_ids);
  tx.touchQuest(quest.id);
  await tx.commit("append_journal", M.summary.appendJournal(quest.title), { questId: quest.id });
  return { journal_id: entry.id };
};

/** 追加・移動先のクエストを決める（クエスト指定か、デイリーの日付指定） */
async function resolveDestination(tx: Tx, questId: string | undefined, dailyDate: string | undefined): Promise<QuestRow> {
  if ((questId ? 1 : 0) + (dailyDate ? 1 : 0) !== 1) throw new OpError(M.error.needTarget);
  if (dailyDate) {
    if (!isValidDate(dailyDate)) throw new OpError(M.error.badDate);
    if (dailyDate < tx.ctx.today) throw new OpError(M.error.pastDaily);
    return getOrCreateDaily(tx, dailyDate);
  }
  const quest = await mustQuest(tx.db, questId!);
  assertOpen(quest);
  return quest;
}

const addTasks: Handler<"add_tasks"> = async (ctx, a) => {
  const tx = new Tx(ctx);
  const quest = await resolveDestination(tx, a.quest_id, a.daily_date);
  const existing = await tasksOf(ctx.db, quest.id);
  const orders = sortOrders(existing, a.tasks.length, a.position, a.after_task_id);
  const taskIds: string[] = [];
  for (const [i, t] of a.tasks.entries()) {
    assertDate(t.due);
    const task = tx.insert("tasks", {
      quest_id: quest.id,
      title: t.title,
      status: "open",
      requester: emptyToNull(t.requester) ?? null,
      location: emptyToNull(t.location) ?? null,
      due: t.due ?? null,
      required_env: emptyToNull(t.required_env) ?? null,
      sort_order: orders[i],
      carryover_count: 0,
    });
    taskIds.push(task.id);
    await linkEvents(tx, t.event_ids, { taskId: task.id });
  }
  await markInputs(tx, a.source_input_ids);
  tx.touchQuest(quest.id);
  await tx.commit("add_tasks", M.summary.addTasks(quest.title, a.tasks.length), { questId: quest.id });
  return { quest_id: quest.id, task_ids: taskIds };
};

const updateTask: Handler<"update_task"> = async (ctx, a) => {
  const task = await mustTask(ctx.db, a.task_id);
  assertDate(a.due);
  const tx = new Tx(ctx);
  tx.update("tasks", task, {
    title: a.title,
    requester: emptyToNull(a.requester),
    location: emptyToNull(a.location),
    due: a.due,
    required_env: emptyToNull(a.required_env),
  });
  await linkEvents(tx, a.add_event_ids, { taskId: task.id });
  await unlinkEvents(tx, a.remove_event_ids, { taskId: task.id });
  await markInputs(tx, a.source_input_ids);
  if (!tx.isEmpty) tx.touchQuest(task.quest_id);
  await tx.commit("update_task", M.summary.updateTask(task.title), { questId: task.quest_id });
  return { task_id: task.id };
};

const setTaskStatus: Handler<"set_task_status"> = async (ctx, a) => {
  const task = await mustTask(ctx.db, a.task_id);
  const quest = await mustQuest(ctx.db, task.quest_id);
  assertOpen(quest);
  const tx = new Tx(ctx);
  if (task.status !== a.status) {
    tx.update("tasks", task, { status: a.status, done_at: a.status === "open" ? null : ctx.now });
    if (a.status !== "open") await expireProposals(tx, { targetId: task.id });
    tx.touchQuest(quest.id);
  }
  await markInputs(tx, a.source_input_ids);
  await tx.commit("set_task_status", M.summary.setTaskStatus(task.title, M.taskStatus[a.status]), { questId: quest.id });
  return { task_id: task.id, status: a.status };
};

const moveTasks: Handler<"move_tasks"> = async (ctx, a) => {
  const tasks: TaskRow[] = [];
  for (const id of new Set(a.task_ids)) tasks.push(await mustTask(ctx.db, id));
  const tx = new Tx(ctx);
  let dest: QuestRow;
  if (a.to_quest_id || a.to_daily_date) {
    dest = await resolveDestination(tx, a.to_quest_id, a.to_daily_date);
  } else {
    if (new Set(tasks.map((t) => t.quest_id)).size !== 1) throw new OpError(M.error.needTarget);
    dest = await mustQuest(ctx.db, tasks[0].quest_id);
    assertOpen(dest);
  }
  const moving = new Set(tasks.map((t) => t.id));
  const others = (await tasksOf(ctx.db, dest.id)).filter((t) => !moving.has(t.id));
  const orders = sortOrders(others, tasks.length, a.position, a.after_task_id);
  for (const [i, t] of tasks.entries()) {
    tx.update("tasks", t, {
      quest_id: dest.id,
      sort_order: orders[i],
      // 日付を指定して予約し直したものは、繰り越しの数え直し
      carryover_count: a.to_daily_date ? 0 : undefined,
    });
    if (t.quest_id !== dest.id) tx.touchQuest(t.quest_id);
  }
  await markInputs(tx, a.source_input_ids);
  tx.touchQuest(dest.id);
  await tx.commit("move_tasks", M.summary.moveTasks(tasks.length, dest.title), { questId: dest.id });
  return { quest_id: dest.id, task_ids: tasks.map((t) => t.id) };
};

const setRecurring: Handler<"set_recurring"> = async (ctx, a) => {
  assertDate(a.start_date);
  assertDate(a.end_date);
  const tx = new Tx(ctx);
  let id: string;
  let name: string;
  const current = a.recurring_id ? await findRow<RecurringRow>(ctx.db, "recurring", a.recurring_id) : null;
  if (a.recurring_id && (!current || current.deleted_at)) throw new OpError(M.error.notFound(M.error.recurring), 404);

  const ruleType = a.rule_type ?? current?.rule_type;
  const weekdays = a.weekdays ? JSON.stringify([...new Set(a.weekdays)].sort()) : (current?.weekdays ?? null);
  const dayOfMonth = a.day_of_month ?? current?.day_of_month ?? null;
  const intervalDays = a.interval_days ?? current?.interval_days ?? null;
  if (
    (ruleType === "weekly" && !weekdays) ||
    (ruleType === "monthly" && !dayOfMonth) ||
    (ruleType === "interval" && !intervalDays)
  ) {
    throw new OpError(M.error.recurringRule);
  }

  if (current) {
    const next = tx.update("recurring", current, {
      title: a.title,
      rule_type: ruleType,
      weekdays: ruleType === "weekly" ? weekdays : null,
      day_of_month: ruleType === "monthly" ? dayOfMonth : null,
      interval_days: ruleType === "interval" ? intervalDays : null,
      requester: emptyToNull(a.requester),
      location: emptyToNull(a.location),
      required_env: emptyToNull(a.required_env),
      active: a.active === undefined ? undefined : a.active ? 1 : 0,
      start_date: a.start_date,
      end_date: a.end_date,
    });
    id = next.id;
    name = next.title;
  } else {
    if (!a.title || !ruleType) throw new OpError(M.error.recurringNeedsTitle);
    const row = tx.insert("recurring", {
      title: a.title,
      rule_type: ruleType,
      weekdays: ruleType === "weekly" ? weekdays : null,
      day_of_month: ruleType === "monthly" ? dayOfMonth : null,
      interval_days: ruleType === "interval" ? intervalDays : null,
      requester: emptyToNull(a.requester) ?? null,
      location: emptyToNull(a.location) ?? null,
      required_env: emptyToNull(a.required_env) ?? null,
      active: a.active === false ? 0 : 1,
      start_date: a.start_date ?? ctx.today,
      end_date: a.end_date ?? null,
    });
    id = row.id;
    name = a.title;
  }
  await markInputs(tx, a.source_input_ids);
  await tx.commit(
    current ? "update_recurring" : "create_recurring",
    current ? M.summary.updateRecurring(name) : M.summary.createRecurring(name),
  );
  // 今日が該当日なら、今日のデイリーにすぐ出す
  await generateRecurringForToday(ctx);
  return { recurring_id: id };
};

// ---------- 提案 ----------

/** キーの順番に左右されないJSON（同じ提案かどうかの比較用） */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

async function targetOf(db: D1Database, type: "quest" | "task", id: string): Promise<{ quest: QuestRow; title: string }> {
  if (type === "quest") {
    const quest = await mustQuest(db, id);
    return { quest, title: quest.title };
  }
  const task = await mustTask(db, id);
  return { quest: await mustQuest(db, task.quest_id), title: task.title };
}

const propose: Handler<"propose"> = async (ctx, a) => {
  const { quest, title } = await targetOf(ctx.db, a.target_type, a.target_id);
  const op = a.action.op;
  if (!(PROPOSABLE_OPS as readonly string[]).includes(op)) throw new OpError(M.error.proposalBadOp);
  if (op === "set_quest_status" && a.action.args.status === "completed") throw new OpError(M.error.proposalNoComplete);
  const parsed = schemas[op].safeParse(a.action.args);
  if (!parsed.success) throw new OpError(`${M.error.badRequest}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const args = { ...(a.action.args as Record<string, unknown>) };
  delete args.source_input_ids;

  if (a.kind === "stalled" && a.target_type === "quest" && quest.kind !== "daily" && quest.status === "active") {
    // 報告待ちのクエストは急かさない
    const open = await ctx.db
      .prepare("SELECT COUNT(*) AS n, SUM(status = 'open') AS open FROM tasks WHERE quest_id = ? AND deleted_at IS NULL")
      .bind(quest.id)
      .first<{ n: number; open: number | null }>();
    if (open && open.n > 0 && !open.open) throw new OpError(M.error.proposalAwaiting);
  }

  const actionKey = `${op}:${stableJson(args)}`;
  const since = new Date(Date.parse(ctx.now) - 30 * 86400000).toISOString();
  const dup = await ctx.db
    .prepare(
      "SELECT id FROM proposals WHERE target_id = ? AND action_key = ? AND deleted_at IS NULL AND (status = 'pending' OR (status = 'rejected' AND resolved_at > ?))",
    )
    .bind(a.target_id, actionKey, since)
    .first();
  if (dup) throw new OpError(M.error.proposalDuplicate, 409);

  const immediate = ctx.settings.followup_mode === "immediate";
  const tx = new Tx(ctx);
  const row = tx.insert("proposals", {
    kind: a.kind,
    target_type: a.target_type,
    target_id: a.target_id,
    quest_id: quest.id,
    action: JSON.stringify({ op, args }),
    action_key: actionKey,
    reason: a.reason,
    status: immediate ? "approved" : "pending",
    run_id: ctx.runId ?? null,
    resolved_at: immediate ? ctx.now : null,
  }) as unknown as ProposalRow;
  await markInputs(tx, a.source_input_ids);
  await tx.commit("propose", M.summary.propose(M.proposalKind[a.kind], title), { questId: quest.id });

  if (immediate) {
    // 即時反映：その場で中身を実行する（気に入らなければ履歴から取り消せる）
    try {
      await runOp(op, args, { ...ctx, proposalId: row.id });
    } catch (e) {
      const tx2 = new Tx(ctx);
      tx2.update("proposals", row, { status: "expired" });
      await tx2.commit("expire_proposal", M.summary.expireProposal(title), { questId: quest.id });
      throw e;
    }
    return { proposal_id: row.id, status: "approved", applied: true };
  }
  return { proposal_id: row.id, status: "pending" };
};

async function mustProposal(db: D1Database, id: string): Promise<ProposalRow> {
  const row = await findRow<ProposalRow>(db, "proposals", id);
  if (!row || row.deleted_at) throw new OpError(M.error.notFound(M.error.proposal), 404);
  return row;
}

async function proposalTitle(db: D1Database, p: ProposalRow): Promise<string> {
  const table = p.target_type === "quest" ? "quests" : "tasks";
  const row = await db.prepare(`SELECT title FROM ${table} WHERE id = ?`).bind(p.target_id).first<{ title: string }>();
  return row?.title ?? "";
}

const withdrawProposal: Handler<"withdraw_proposal"> = async (ctx, a) => {
  const p = await mustProposal(ctx.db, a.proposal_id);
  if (p.status !== "pending") throw new OpError(M.error.proposalNotPending);
  const tx = new Tx(ctx);
  tx.update("proposals", p, { status: "withdrawn", resolved_at: ctx.now });
  await tx.commit("withdraw_proposal", M.summary.withdrawProposal(await proposalTitle(ctx.db, p)), { questId: p.quest_id });
  return { proposal_id: p.id, status: "withdrawn" };
};

/** 承認・却下（人が画面で行う）。承認されたら中身をそのまま実行する */
const resolveProposal: Handler<"resolve_proposal"> = async (ctx, a) => {
  if (ctx.actor !== "human") throw new OpError(M.error.humanOnly, 403);
  const p = await mustProposal(ctx.db, a.proposal_id);
  if (p.status !== "pending") throw new OpError(M.error.proposalNotPending);
  const title = await proposalTitle(ctx.db, p);

  if (a.decision === "reject") {
    const tx = new Tx(ctx);
    tx.update("proposals", p, { status: "rejected", resolved_at: ctx.now });
    await tx.commit("reject_proposal", M.summary.rejectProposal(title), { questId: p.quest_id });
    return { proposal_id: p.id, status: "rejected" };
  }

  const action = JSON.parse(p.action) as { op: OpName; args: unknown };
  try {
    await runOp(action.op, action.args, { ...ctx, proposalId: p.id });
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    // 対象が先に変わっていて実行できない＝期限切れ
    const tx = new Tx(ctx);
    tx.update("proposals", p, { status: "expired", resolved_at: ctx.now });
    await tx.commit("expire_proposal", M.summary.expireProposal(title), { questId: p.quest_id });
    return { proposal_id: p.id, status: "expired", message: e.message };
  }
  const tx = new Tx(ctx);
  tx.update("proposals", p, { status: "approved", resolved_at: ctx.now });
  await tx.commit("approve_proposal", M.summary.approveProposal(title), { questId: p.quest_id });
  return { proposal_id: p.id, status: "approved" };
};

const updateSettings: Handler<"update_settings"> = async (ctx, a) => {
  if (ctx.actor !== "human") throw new OpError(M.error.humanOnly, 403);
  if (a.timezone && !isTimeZone(a.timezone)) throw new OpError(M.error.badRequest);
  const current = await getSettings(ctx.db);
  const next = { ...current, ...a, parts: { ...current.parts, ...(a.parts ?? {}) } };
  const tx = new Tx(ctx);
  tx.raw(settingsStatement(ctx.db, next));
  await tx.commit("update_settings", M.summary.updateSettings, { undoable: false, force: true });
  return next;
};

// ---------- 振り分け ----------

const handlers: { [K in OpName]?: Handler<K> } = {
  add_input: addInput,
  create_quest: createQuest,
  update_quest: updateQuest,
  set_quest_status: setQuestStatus,
  complete_quest: completeQuest,
  reopen_quest: reopenQuest,
  purge_quest: purgeQuest,
  append_journal: appendJournal,
  add_tasks: addTasks,
  update_task: updateTask,
  set_task_status: setTaskStatus,
  move_tasks: moveTasks,
  set_recurring: setRecurring,
  propose,
  withdraw_proposal: withdrawProposal,
  resolve_proposal: resolveProposal,
  update_settings: updateSettings,
  undo: (ctx, a) => undo(ctx, a),
};

export const isWriteOp = (name: string): name is OpName => name in handlers;

/** 入力を検証して操作を実行する */
export async function runOp(name: OpName, rawArgs: unknown, ctx: Ctx): Promise<unknown> {
  const handler = handlers[name] as Handler<OpName> | undefined;
  if (!handler) throw new OpError(M.error.badRequest);
  const parsed = schemas[name].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
    throw new OpError(`${M.error.badRequest}: ${detail}`);
  }
  return handler(ctx, parsed.data as Args<OpName>);
}
