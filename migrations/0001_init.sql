-- ComQuest MVP のデータベース定義（docs/design.md 参照）
-- 時刻は ISO 8601（UTC）、日付は YYYY-MM-DD（設定のタイムゾーン）で持つ。IDは全てUUID。

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE inputs (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'app',
  status TEXT NOT NULL DEFAULT 'pending',      -- pending / processed
  processed_run_id TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_inputs_status ON inputs(status, created_at);

CREATE TABLE quests (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- normal / daily / event
  completion_condition TEXT,
  status TEXT NOT NULL,                         -- board / active / on_hold / completed / discarded
  tracked INTEGER NOT NULL DEFAULT 1,
  requester TEXT,
  location TEXT,
  due TEXT,                                     -- YYYY-MM-DD または YYYY-MM-DDTHH:MM
  required_env TEXT,
  resume_on TEXT,
  daily_date TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_quests_status ON quests(status, updated_at);
CREATE UNIQUE INDEX idx_quests_daily ON quests(daily_date) WHERE kind = 'daily';

CREATE TABLE quest_prereqs (
  id TEXT PRIMARY KEY,
  quest_id TEXT NOT NULL,
  prereq_id TEXT NOT NULL,
  UNIQUE (quest_id, prereq_id)
);

CREATE TABLE journal (
  id TEXT PRIMARY KEY,
  quest_id TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,                         -- ai / human / system
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_journal_quest ON journal(quest_id, created_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  quest_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',          -- open / done / dropped
  requester TEXT,
  location TEXT,
  due TEXT,
  required_env TEXT,
  sort_order REAL NOT NULL,
  carryover_count INTEGER NOT NULL DEFAULT 0,
  recurring_id TEXT,
  generated_date TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_tasks_quest ON tasks(quest_id, sort_order);
CREATE INDEX idx_tasks_status ON tasks(status, updated_at);
CREATE UNIQUE INDEX idx_tasks_generated ON tasks(recurring_id, generated_date) WHERE recurring_id IS NOT NULL;

CREATE TABLE recurring (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  rule_type TEXT NOT NULL,                      -- daily / weekly / monthly / interval
  weekdays TEXT,                                -- 曜日指定：JSON配列（0=日 … 6=土）
  day_of_month INTEGER,
  interval_days INTEGER,
  requester TEXT,
  location TEXT,
  required_env TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,
  end_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- 外部カレンダーの予定の写し（正は外部カレンダー。変更履歴の対象外）
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  calendar_name TEXT,
  title TEXT,
  starts_at TEXT NOT NULL,                      -- 終日は YYYY-MM-DD、時刻つきは ISO 8601
  ends_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  link TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',     -- confirmed / cancelled
  fetched_at TEXT NOT NULL,
  UNIQUE (provider, calendar_id, external_id)
);
CREATE INDEX idx_events_start ON calendar_events(starts_at);

CREATE TABLE event_links (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  quest_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_links_event ON event_links(event_id);
CREATE INDEX idx_links_quest ON event_links(quest_id);
CREATE INDEX idx_links_task ON event_links(task_id);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                           -- do / dont / stalled
  target_type TEXT NOT NULL,                    -- quest / task
  target_id TEXT NOT NULL,
  quest_id TEXT,
  action TEXT NOT NULL,                         -- JSON {op, args}
  action_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending / approved / rejected / expired / withdrawn
  run_id TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_proposals_status ON proposals(status, created_at);
CREATE INDEX idx_proposals_target ON proposals(target_id, status);

-- AIの実行（MCP経由の一連の呼び出しを1回の実行としてまとめる）
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,                        -- app（アプリから起動） / chat（Claudeとの会話など）
  started_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
CREATE INDEX idx_runs_last ON runs(last_at);

-- 変更履歴：1回の操作（operations）と、その中の行ごとの変更（changes）
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,                          -- ai / human / system
  op TEXT NOT NULL,
  summary TEXT NOT NULL,
  run_id TEXT,
  proposal_id TEXT,
  quest_id TEXT,
  undo_of TEXT,
  undone_at TEXT,
  undoable INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_operations_at ON operations(at);
CREATE INDEX idx_operations_run ON operations(run_id);
CREATE INDEX idx_operations_quest ON operations(quest_id, at);

CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before TEXT,                                  -- JSON（追加のときは NULL）
  after TEXT                                    -- JSON（削除のときは NULL）
);
CREATE INDEX idx_changes_op ON changes(operation_id, seq);
CREATE INDEX idx_changes_entity ON changes(entity_id);

-- 画面のログイン
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL
);
