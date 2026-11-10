// サーバーと画面で共有する型

export type QuestKind = "normal" | "daily" | "event";
export type QuestStatus = "board" | "active" | "on_hold" | "completed" | "discarded";
export type TaskStatus = "open" | "done" | "dropped";
export type ProposalKind = "do" | "dont" | "stalled";
export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "withdrawn";
export type Actor = "ai" | "human" | "system";

export interface QuestRow {
  id: string;
  title: string;
  kind: QuestKind;
  completion_condition: string | null;
  status: QuestStatus;
  tracked: number;
  requester: string | null;
  location: string | null;
  due: string | null;
  required_env: string | null;
  resume_on: string | null;
  daily_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  [k: string]: unknown;
}

export interface TaskRow {
  id: string;
  quest_id: string;
  title: string;
  status: TaskStatus;
  requester: string | null;
  location: string | null;
  due: string | null;
  required_env: string | null;
  sort_order: number;
  carryover_count: number;
  recurring_id: string | null;
  generated_date: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  [k: string]: unknown;
}

export interface RecurringRow {
  id: string;
  title: string;
  rule_type: "daily" | "weekly" | "monthly" | "interval";
  weekdays: string | null;
  day_of_month: number | null;
  interval_days: number | null;
  requester: string | null;
  location: string | null;
  required_env: string | null;
  active: number;
  start_date: string;
  end_date: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  [k: string]: unknown;
}

export interface ProposalRow {
  id: string;
  kind: ProposalKind;
  target_type: "quest" | "task";
  target_id: string;
  quest_id: string | null;
  action: string;
  action_key: string;
  reason: string;
  status: ProposalStatus;
  run_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  [k: string]: unknown;
}

export interface InputRow {
  id: string;
  body: string;
  source: string;
  status: "pending" | "processed";
  processed_run_id: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  [k: string]: unknown;
}

export interface EventRow {
  id: string;
  provider: string;
  calendar_id: string;
  external_id: string;
  calendar_name: string | null;
  title: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: number;
  location: string | null;
  link: string | null;
  status: string;
}

// ---- 画面・AIに返す形 ----

export interface TaskView {
  id: string;
  quest_id: string;
  title: string;
  status: TaskStatus;
  /** 空なら所属クエストの値を引き継いだもの */
  requester: string | null;
  location: string | null;
  due: string | null;
  required_env: string | null;
  carryover_count: number;
  from_recurring: boolean;
  updated_at: string;
  event_ids: string[];
}

export interface QuestSummary {
  id: string;
  title: string;
  kind: QuestKind;
  status: QuestStatus;
  tracked: boolean;
  completion_condition: string | null;
  requester: string | null;
  location: string | null;
  due: string | null;
  required_env: string | null;
  resume_on: string | null;
  daily_date: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** 現在の目的＝未完了タスクの先頭 */
  current_objective: { id: string; title: string } | null;
  progress: { done: number; total: number };
  /** 報告待ち＝タスクが全部終わったが、まだ人が完了にしていない */
  awaiting_report: boolean;
  pending_proposals: number;
}

export interface EventView {
  id: string;
  title: string | null;
  /** 設定のタイムゾーンでの日付（YYYY-MM-DD）と時刻（HH:MM）。終日は時刻なし */
  date: string;
  end_date: string;
  time: string | null;
  end_time: string | null;
  all_day: boolean;
  location: string | null;
  calendar_name: string | null;
  link: string | null;
  linked: { quest_id: string | null; task_id: string | null; quest_title: string | null; task_title: string | null }[];
}

export interface ProposalView {
  id: string;
  kind: ProposalKind;
  target_type: "quest" | "task";
  target_id: string;
  target_title: string | null;
  quest_id: string | null;
  quest_title: string | null;
  action: { op: string; args: Record<string, unknown> };
  /** 実行すると何が変わるかの説明 */
  action_text: string;
  reason: string;
  status: ProposalStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface JournalView {
  id: string;
  body: string;
  author: Actor;
  created_at: string;
}

export interface QuestDetail extends QuestSummary {
  tasks: TaskView[];
  journal: JournalView[];
  prerequisites: { id: string; title: string; status: QuestStatus }[];
  events: EventView[];
  proposals: ProposalView[];
}

export interface OperationView {
  id: string;
  at: string;
  actor: Actor;
  op: string;
  summary: string;
  run_id: string | null;
  proposal_id: string | null;
  quest_id: string | null;
  undo_of: string | null;
  undone: boolean;
  undoable: boolean;
}

export interface RunView {
  id: string;
  trigger: string;
  started_at: string;
  last_at: string;
  operations: number;
  undone: number;
  proposals: number;
}

export interface AiState {
  /** 整理中の印を出すか */
  organizing: boolean;
  /** AIの起動先が設定済みか */
  configured: boolean;
  last_error: string | null;
}

export interface SettingsView {
  timezone: string;
  followup_mode: "approval" | "immediate";
  stalled_carryover_count: number;
  stale_days: number;
  parts: { input: boolean; daily: boolean; tracker: boolean; proposals: boolean; events: boolean };
}

export interface HomeView {
  today: string;
  ai: AiState;
  settings: SettingsView;
  pending_inputs: { id: string; body: string; created_at: string }[];
  daily: { quest_id: string | null; date: string; tasks: TaskView[] };
  tracker: QuestSummary[];
  proposals: ProposalView[];
  events: EventView[];
  calendar_connected: boolean;
  board_count: number;
}
