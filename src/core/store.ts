// 書き込みの土台。全ての書き込みを Tx 経由で行い、変更履歴（operations / changes）に必ず残す。
// D1 には対話的なトランザクションがないので、書き込みを溜めて commit() で一括実行（batch＝全部成功か全部失敗）する。

import type { Settings } from "./settings";

export type Actor = "ai" | "human" | "system";

export interface Ctx {
  db: D1Database;
  /** 誰の操作か。接続元（MCP＝ai／画面＝human／定期処理＝system）からサーバーが決める */
  actor: Actor;
  runId?: string | null;
  proposalId?: string | null;
  settings: Settings;
  /** ISO 8601（UTC） */
  now: string;
  /** 設定のタイムゾーンでの今日（YYYY-MM-DD） */
  today: string;
}

/** 利用者（AI・人）に見せてよいエラー */
export class OpError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export type Row = Record<string, unknown> & { id: string };

/** 履歴の対象にする表と列（id・updated_at 以外）。ここにない表・列は Tx では書けない */
const TABLES = {
  inputs: ["body", "source", "status", "processed_run_id", "processed_at", "created_at", "deleted_at"],
  quests: [
    "title", "kind", "completion_condition", "status", "tracked", "requester", "location", "due", "required_env",
    "resume_on", "daily_date", "completed_at", "created_at", "deleted_at",
  ],
  quest_prereqs: ["quest_id", "prereq_id"],
  journal: ["quest_id", "body", "author", "created_at", "deleted_at"],
  tasks: [
    "quest_id", "title", "status", "requester", "location", "due", "required_env", "sort_order", "carryover_count",
    "recurring_id", "generated_date", "done_at", "created_at", "deleted_at",
  ],
  recurring: [
    "title", "rule_type", "weekdays", "day_of_month", "interval_days", "requester", "location", "required_env",
    "active", "start_date", "end_date", "created_at", "deleted_at",
  ],
  event_links: ["event_id", "quest_id", "task_id", "created_at"],
  proposals: [
    "kind", "target_type", "target_id", "quest_id", "action", "action_key", "reason", "status", "run_id",
    "resolved_at", "created_at", "deleted_at",
  ],
} as const;

export type Table = keyof typeof TABLES;

const HAS_UPDATED_AT: ReadonlySet<Table> = new Set(["inputs", "quests", "journal", "tasks", "recurring", "proposals"]);
/** 取り消しで「追加」を戻すとき、行を消さずに deleted_at を立てる表 */
export const SOFT_DELETE: ReadonlySet<Table> = new Set(["inputs", "quests", "journal", "tasks", "recurring", "proposals"]);

export const isTable = (t: string): t is Table => t in TABLES;
export const columnsOf = (t: Table): readonly string[] => TABLES[t];

interface Change {
  entity: Table;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export class Tx {
  private stmts: D1PreparedStatement[] = [];
  private changes: Change[] = [];

  constructor(public ctx: Ctx) {}

  get db(): D1Database {
    return this.ctx.db;
  }

  get isEmpty(): boolean {
    return this.changes.length === 0 && this.stmts.length === 0;
  }

  /** 行を追加する。id がなければUUIDを振る */
  insert<T extends Record<string, unknown>>(table: Table, values: T): T & Row {
    const cols = TABLES[table] as readonly string[];
    const row: Record<string, unknown> = { id: (values.id as string) ?? crypto.randomUUID() };
    for (const c of cols) row[c] = values[c] ?? null;
    if (cols.includes("created_at") && !row.created_at) row.created_at = this.ctx.now;
    const names = ["id", ...cols];
    const params = names.map((n) => row[n]);
    if (HAS_UPDATED_AT.has(table)) {
      names.push("updated_at");
      params.push(this.ctx.now);
      row.updated_at = this.ctx.now;
    }
    this.stmts.push(
      this.db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).bind(...params),
    );
    const after: Record<string, unknown> = {};
    for (const c of cols) after[c] = row[c];
    this.changes.push({ entity: table, entityId: row.id as string, before: null, after });
    return row as T & Row;
  }

  /** 行の一部を書き換える。実際に変わった列だけを履歴に残す。変更後の行を返す */
  update<T extends Row>(table: Table, current: T, patch: Record<string, unknown>): T {
    const cols = TABLES[table] as readonly string[];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols.includes(k)) continue;
      const cur = current[k] ?? null;
      const next = v ?? null;
      if (cur === next) continue;
      before[k] = cur;
      after[k] = next;
    }
    const keys = Object.keys(after);
    if (keys.length === 0) return current;
    const sets = keys.map((k) => `${k} = ?`);
    const params = keys.map((k) => after[k]);
    if (HAS_UPDATED_AT.has(table)) {
      sets.push("updated_at = ?");
      params.push(this.ctx.now);
    }
    this.stmts.push(this.db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).bind(...params, current.id));
    this.changes.push({ entity: table, entityId: current.id, before, after });
    return { ...current, ...after, ...(HAS_UPDATED_AT.has(table) ? { updated_at: this.ctx.now } : {}) };
  }

  /** 行を消す（紐づけなど、中身を持たない表だけに使う） */
  remove(table: Table, current: Row): void {
    const cols = TABLES[table] as readonly string[];
    const before: Record<string, unknown> = {};
    for (const c of cols) before[c] = current[c] ?? null;
    this.stmts.push(this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(current.id));
    this.changes.push({ entity: table, entityId: current.id, before, after: null });
  }

  /** クエストの最終更新日時だけを進める（停滞の検知用。履歴には残さない） */
  touchQuest(questId: string): void {
    this.stmts.push(this.db.prepare("UPDATE quests SET updated_at = ? WHERE id = ?").bind(this.ctx.now, questId));
  }

  /** 履歴に残さない文を一緒に実行する（設定値など、利用者のデータではないもの） */
  raw(stmt: D1PreparedStatement): void {
    this.stmts.push(stmt);
  }

  /**
   * 溜めた書き込みを一括で実行し、1回の操作として履歴に記録する。
   * 変更が何もなければ何もせず null を返す。
   */
  async commit(
    op: string,
    summary: string,
    opts: { questId?: string | null; undoOf?: string | null; undoable?: boolean; force?: boolean } = {},
  ): Promise<string | null> {
    if (this.changes.length === 0 && !opts.force) {
      if (this.stmts.length > 0) await this.db.batch(this.stmts);
      this.stmts = [];
      return null;
    }
    const { ctx } = this;
    const opId = crypto.randomUUID();
    const stmts = [...this.stmts];
    stmts.push(
      this.db
        .prepare(
          "INSERT INTO operations (id, at, actor, op, summary, run_id, proposal_id, quest_id, undo_of, undoable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          opId, ctx.now, ctx.actor, op, summary, ctx.runId ?? null, ctx.proposalId ?? null, opts.questId ?? null,
          opts.undoOf ?? null, opts.undoable === false ? 0 : 1,
        ),
    );
    this.changes.forEach((c, i) => {
      stmts.push(
        this.db
          .prepare("INSERT INTO changes (id, operation_id, seq, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(
            crypto.randomUUID(), opId, i, c.entity, c.entityId,
            c.before ? JSON.stringify(c.before) : null, c.after ? JSON.stringify(c.after) : null,
          ),
      );
    });
    await this.db.batch(stmts);
    this.stmts = [];
    this.changes = [];
    return opId;
  }
}

export async function findRow<T extends Row = Row>(db: D1Database, table: Table, id: string): Promise<T | null> {
  return (await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<T>()) ?? null;
}
