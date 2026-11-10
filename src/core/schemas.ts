// 操作の入力の形。MCPのツール定義と画面のAPIの両方がこれを使う。
// describe() の文はAIが読む説明。

import { z } from "zod";
import { DATE_RE, DUE_RE } from "./time";

const id = z.uuid();
const title = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(4000);
/** 省略＝変更しない、null＝空にする */
const optField = z.string().trim().max(500).nullable().optional();
const date = z.string().regex(DATE_RE, "YYYY-MM-DD");
const due = z.string().regex(DUE_RE, "YYYY-MM-DD または YYYY-MM-DDTHH:MM");

const sourceInputs = z
  .array(id)
  .max(50)
  .optional()
  .describe("この操作の元になった未整理の入力のID。指定すると、操作が成功した時点でその入力は処理済みになる");

const eventIds = z.array(id).max(20).optional().describe("紐づける予定のID（get_overview や search で得たもの）");

const taskDraft = z.object({
  title,
  requester: optField.describe("依頼主。空なら所属クエストの値を引き継ぐ"),
  location: optField.describe("場所。空なら所属クエストの値を引き継ぐ"),
  due: due.nullable().optional().describe("期限"),
  required_env: optField.describe("必要な環境（例：PC、現場、電話できる場所）。内容から推測して埋める"),
  event_ids: eventIds,
});

const position = z
  .enum(["start", "end", "after"])
  .optional()
  .describe("挿入位置。start＝先頭、end＝末尾（既定）、after＝after_task_id の直後");

export const schemas = {
  get_overview: z.object({
    acknowledge_input_ids: z
      .array(id)
      .max(50)
      .optional()
      .describe("読んだ結果、何も変更が要らなかった未整理の入力のID。処理済みにする"),
  }),
  get_quest: z.object({ quest_id: id }),
  search: z.object({
    target: z.enum(["quests", "tasks", "events"]).default("quests").describe("何を探すか"),
    keyword: z.string().trim().max(100).optional(),
    status: z
      .array(z.string())
      .optional()
      .describe("クエスト：board/active/on_hold/completed/discarded、タスク：open/done/dropped"),
    kind: z.enum(["normal", "daily", "event"]).optional().describe("クエストの種類"),
    required_env: z.string().trim().max(100).optional(),
    requester: z.string().trim().max(100).optional(),
    due_from: date.optional().describe("期限がこの日以降"),
    due_to: date.optional().describe("期限がこの日以前"),
    updated_before: date.optional().describe("最終更新がこの日より前（停滞の検知用）"),
    min_carryover: z.number().int().min(1).optional().describe("繰り越し回数がこれ以上のタスク"),
    from: date.optional().describe("予定の検索：この日以降"),
    to: date.optional().describe("予定の検索：この日以前"),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).default(0),
  }),

  create_quest: z.object({
    title: title.describe("タイトル。作成後は変更できない"),
    kind: z.enum(["normal", "event"]).default("normal").describe("normal＝通常、event＝突発の用件（期限必須・即受注）"),
    completion_condition: text.describe("完了条件。何がどうなったら終わりか"),
    placement: z
      .enum(["active", "board"])
      .default("active")
      .describe("置き場所。active＝受注中、board＝Quest Board（いつかやる）"),
    requester: optField.describe("依頼主"),
    location: optField.describe("場所"),
    due: due.nullable().optional().describe("期限"),
    required_env: optField.describe("必要な環境"),
    tracked: z.boolean().optional().describe("トラッカーに出すか。既定は受注中なら出す"),
    tasks: z.array(taskDraft).max(50).optional().describe("最初のタスク群。分かっている分だけでよい"),
    event_ids: eventIds,
    prerequisite_ids: z.array(id).max(20).optional().describe("前提クエストのID"),
    source_input_ids: sourceInputs,
  }),
  update_quest: z.object({
    quest_id: id,
    completion_condition: text.optional(),
    requester: optField,
    location: optField,
    due: due.nullable().optional(),
    required_env: optField,
    tracked: z.boolean().optional(),
    add_event_ids: eventIds,
    remove_event_ids: z.array(id).max(20).optional(),
    prerequisite_ids: z.array(id).max(20).optional().describe("前提クエストのID（指定した内容で置き換える）"),
    source_input_ids: sourceInputs,
  }),
  set_quest_status: z.object({
    quest_id: id,
    status: z
      .enum(["active", "on_hold", "discarded", "board"])
      .describe("active＝受注、on_hold＝保留、discarded＝破棄、board＝Quest Boardへ戻す。完了にはできない（完了は人だけが行う）"),
    reason: text.describe("理由。ジャーナルに自動で残る"),
    resume_on: date.nullable().optional().describe("保留のときの再開日（任意）"),
    source_input_ids: sourceInputs,
  }),
  append_journal: z.object({
    quest_id: id,
    body: text.describe("経緯の記録。追記専用"),
    source_input_ids: sourceInputs,
  }),

  add_tasks: z.object({
    quest_id: id.optional().describe("追加先のクエスト"),
    daily_date: date.optional().describe("デイリーに入れる場合の日付（今日以降）。quest_id とどちらか一方"),
    tasks: z.array(taskDraft).min(1).max(50),
    position,
    after_task_id: id.optional(),
    source_input_ids: sourceInputs,
  }),
  update_task: z.object({
    task_id: id,
    title: title.optional(),
    requester: optField,
    location: optField,
    due: due.nullable().optional(),
    required_env: optField,
    add_event_ids: eventIds,
    remove_event_ids: z.array(id).max(20).optional(),
    source_input_ids: sourceInputs,
  }),
  set_task_status: z.object({
    task_id: id,
    status: z.enum(["done", "dropped", "open"]).describe("done＝完了、dropped＝やめた、open＝未完了に戻す"),
    source_input_ids: sourceInputs,
  }),
  move_tasks: z.object({
    task_ids: z.array(id).min(1).max(50).describe("この順番で並ぶ"),
    to_quest_id: id.optional().describe("移動先のクエスト。省略すると今のクエスト内での並べ替え"),
    to_daily_date: date.optional().describe("デイリーの日付への予約（今日以降）"),
    position,
    after_task_id: id.optional(),
    source_input_ids: sourceInputs,
  }),

  set_recurring: z.object({
    recurring_id: id.optional().describe("変更・停止する定義のID。省略すると新規作成"),
    title: title.optional().describe("毎回デイリーに出すタスクのタイトル"),
    rule_type: z
      .enum(["daily", "weekly", "monthly", "interval"])
      .optional()
      .describe("daily＝毎日、weekly＝曜日指定、monthly＝毎月◯日、interval＝N日ごと"),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional().describe("曜日指定：0＝日 … 6＝土"),
    day_of_month: z.number().int().min(1).max(31).optional(),
    interval_days: z.number().int().min(2).max(365).optional(),
    requester: optField,
    location: optField,
    required_env: optField,
    active: z.boolean().optional().describe("false で停止"),
    start_date: date.optional(),
    end_date: date.nullable().optional(),
    source_input_ids: sourceInputs,
  }),

  get_history: z.object({
    quest_id: id.optional(),
    run_id: id.optional().describe("AIの実行単位で絞り込む"),
    since: z.string().max(40).optional().describe("この日時以降（ISO 8601 か YYYY-MM-DD）"),
    until: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).default(0),
  }),
  undo: z.object({
    operation_id: id.optional().describe("取り消す変更（get_history の id）"),
    run_id: id.optional().describe("AIの1回の実行をまとめて取り消す"),
  }),

  propose: z.object({
    kind: z.enum(["do", "dont", "stalled"]).describe("do＝やるもの、dont＝やらないもの、stalled＝止まっているもの"),
    target_type: z.enum(["quest", "task"]),
    target_id: id,
    action: z
      .object({
        op: z.enum([
          "set_quest_status", "update_quest", "set_task_status", "update_task", "move_tasks", "add_tasks",
          "append_journal", "set_recurring",
        ]),
        args: z.record(z.string(), z.unknown()),
      })
      .describe("承認されたらシステムがそのまま実行する操作。op は操作名、args はその操作の引数"),
    reason: text.describe("なぜそう提案するか。画面に表示される"),
    source_input_ids: sourceInputs,
  }),
  withdraw_proposal: z.object({ proposal_id: id }),

  // ---- ここから下は画面から人だけが行う操作（MCPには出さない） ----
  add_input: z.object({ body: z.string().trim().min(1).max(10000), source: z.enum(["app", "voice"]).default("app") }),
  complete_quest: z.object({ quest_id: id }),
  reopen_quest: z.object({ quest_id: id }),
  purge_quest: z.object({ quest_id: id }),
  resolve_proposal: z.object({ proposal_id: id, decision: z.enum(["approve", "reject"]) }),
  update_settings: z.object({
    timezone: z.string().max(60).optional(),
    followup_mode: z.enum(["approval", "immediate"]).optional(),
    stalled_carryover_count: z.number().int().min(1).max(30).optional(),
    stale_days: z.number().int().min(1).max(365).optional(),
    parts: z
      .object({
        input: z.boolean(), daily: z.boolean(), tracker: z.boolean(), proposals: z.boolean(), events: z.boolean(),
      })
      .partial()
      .optional(),
  }),
} as const;

export type OpName = keyof typeof schemas;
export type Args<K extends OpName> = z.output<(typeof schemas)[K]>;

/** MCPに出す16操作 */
export const MCP_OPS = [
  "get_overview", "get_quest", "search",
  "create_quest", "update_quest", "set_quest_status", "append_journal",
  "add_tasks", "update_task", "set_task_status", "move_tasks",
  "set_recurring",
  "get_history", "undo",
  "propose", "withdraw_proposal",
] as const satisfies readonly OpName[];

/** 提案の中身にできる操作 */
export const PROPOSABLE_OPS = [
  "set_quest_status", "update_quest", "set_task_status", "update_task", "move_tasks", "add_tasks", "append_journal",
  "set_recurring",
] as const satisfies readonly OpName[];
