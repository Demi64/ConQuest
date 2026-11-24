-- タスクの「やる日」とメモ（docs/design.md 6章 13・17）
-- scheduled_on：クエストに属したまま、その日のデイリーに表示する日付（YYYY-MM-DD）
-- note：タイトルに入らない補足（「残高で足りれば不要」など）

ALTER TABLE tasks ADD COLUMN scheduled_on TEXT;
ALTER TABLE tasks ADD COLUMN note TEXT;
CREATE INDEX idx_tasks_scheduled ON tasks(scheduled_on) WHERE scheduled_on IS NOT NULL;

-- 以前の方式でクエストからデイリーへ移された未完了のタスクを、元のクエストに戻し、デイリーの日付を「やる日」にする。
-- 元のクエスト＝変更履歴で、そのタスクが最後に属していたデイリー以外のクエスト（受注中・保留・Quest Board のもの）。
UPDATE tasks
SET
  scheduled_on = (SELECT d.daily_date FROM quests d WHERE d.id = tasks.quest_id),
  quest_id = (
    SELECT q.id
    FROM changes c
    JOIN operations o ON o.id = c.operation_id
    JOIN quests q ON q.id = COALESCE(json_extract(c.before, '$.quest_id'), json_extract(c.after, '$.quest_id'))
    WHERE c.entity = 'tasks' AND c.entity_id = tasks.id
      AND q.kind != 'daily' AND q.status IN ('active', 'on_hold', 'board') AND q.deleted_at IS NULL
    ORDER BY o.at DESC, c.seq DESC
    LIMIT 1
  )
WHERE status = 'open'
  AND deleted_at IS NULL
  AND quest_id IN (SELECT id FROM quests WHERE kind = 'daily')
  AND EXISTS (
    SELECT 1
    FROM changes c
    JOIN quests q ON q.id = COALESCE(json_extract(c.before, '$.quest_id'), json_extract(c.after, '$.quest_id'))
    WHERE c.entity = 'tasks' AND c.entity_id = tasks.id
      AND q.kind != 'daily' AND q.status IN ('active', 'on_hold', 'board') AND q.deleted_at IS NULL
  );
