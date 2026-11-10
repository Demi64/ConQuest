// 取り消し。変更履歴（changes）をさかのぼって元に戻す。取り消し自体も1件の操作として履歴に残るので、取り消しの取り消しもできる。
//
// - 追加の取り消し：行は消さず deleted_at を立てて見えなくする（紐づけの表だけは行を消す）
// - 変更の取り消し：項目ごとに戻す。後から別の変更が入った項目は戻さず、件数を報告する
// - 削除の取り消し：行を入れ直す

import { M } from "../shared/messages";
import type { Args } from "./schemas";
import { OpError, SOFT_DELETE, Tx, findRow, isTable, type Ctx } from "./store";

interface OperationRow {
  id: string;
  op: string;
  summary: string;
  run_id: string | null;
  quest_id: string | null;
  undo_of: string | null;
  undone_at: string | null;
  undoable: number;
}

interface ChangeRow {
  entity: string;
  entity_id: string;
  before: string | null;
  after: string | null;
}

async function undoOperation(ctx: Ctx, op: OperationRow): Promise<{ operation_id: string | null; conflicts: number }> {
  if (op.undone_at) throw new OpError(M.error.alreadyUndone, 409);
  if (!op.undoable) throw new OpError(M.error.notUndoable);

  const changes = await ctx.db
    .prepare("SELECT entity, entity_id, before, after FROM changes WHERE operation_id = ? ORDER BY seq DESC")
    .bind(op.id)
    .all<ChangeRow>();

  const tx = new Tx(ctx);
  let conflicts = 0;
  for (const c of changes.results) {
    if (!isTable(c.entity)) continue;
    const before = c.before ? (JSON.parse(c.before) as Record<string, unknown>) : null;
    const after = c.after ? (JSON.parse(c.after) as Record<string, unknown>) : null;
    const current = await findRow(ctx.db, c.entity, c.entity_id);

    if (!before) {
      // 追加の取り消し
      if (!current) continue;
      if (SOFT_DELETE.has(c.entity)) {
        if (!current.deleted_at) tx.update(c.entity, current, { deleted_at: ctx.now });
      } else {
        tx.remove(c.entity, current);
      }
    } else if (!after) {
      // 削除の取り消し
      if (!current) tx.insert(c.entity, { id: c.entity_id, ...before });
    } else {
      if (!current) {
        conflicts++;
        continue;
      }
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(before)) {
        if ((current[key] ?? null) === (after[key] ?? null)) patch[key] = before[key];
        else conflicts++;
      }
      tx.update(c.entity, current, patch);
    }
  }
  tx.raw(ctx.db.prepare("UPDATE operations SET undone_at = ? WHERE id = ?").bind(ctx.now, op.id));
  // 取り消しを取り消したら、元の操作は「取り消されていない」状態に戻る
  if (op.undo_of) tx.raw(ctx.db.prepare("UPDATE operations SET undone_at = NULL WHERE id = ?").bind(op.undo_of));
  if (op.quest_id) tx.touchQuest(op.quest_id);
  const id = await tx.commit("undo", M.summary.undo(op.summary), { questId: op.quest_id, undoOf: op.id, force: true });
  return { operation_id: id, conflicts };
}

export async function undo(ctx: Ctx, a: Args<"undo">): Promise<unknown> {
  if ((a.operation_id ? 1 : 0) + (a.run_id ? 1 : 0) !== 1) throw new OpError(M.error.undoNeedsTarget);

  if (a.operation_id) {
    const op = await ctx.db.prepare("SELECT * FROM operations WHERE id = ?").bind(a.operation_id).first<OperationRow>();
    if (!op) throw new OpError(M.error.notFound(M.error.operation), 404);
    const r = await undoOperation(ctx, op);
    return { undone: 1, conflicts: r.conflicts, note: r.conflicts ? M.error.undoConflict(r.conflicts) : undefined };
  }

  const run = await ctx.db.prepare("SELECT id FROM runs WHERE id = ?").bind(a.run_id).first();
  if (!run) throw new OpError(M.error.notFound(M.error.run), 404);
  // 新しいものから順に戻す。取り消しの操作そのものは対象にしない
  const ops = await ctx.db
    .prepare(
      "SELECT * FROM operations WHERE run_id = ? AND undone_at IS NULL AND undoable = 1 AND undo_of IS NULL ORDER BY at DESC, rowid DESC",
    )
    .bind(a.run_id)
    .all<OperationRow>();
  let conflicts = 0;
  for (const op of ops.results) conflicts += (await undoOperation(ctx, op)).conflicts;
  return {
    undone: ops.results.length,
    conflicts,
    note: conflicts ? M.error.undoConflict(conflicts) : undefined,
  };
}
