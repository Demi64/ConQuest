// 履歴：変更履歴（1件ずつ取り消せる）と、AIの実行（まとめて取り消せる）
import { useState } from "preact/hooks";
import { M } from "../../src/shared/messages";
import type { OperationView, RunView } from "../../src/shared/types";
import { get, op } from "../api";
import { Link, Loading, formatStamp, run, useData } from "../lib";

const U = M.ui.history;

function Operations(props: { query: string }) {
  const [pages, setPages] = useState(1);
  const state = useData<{ operations: OperationView[]; has_more: boolean }>(async () => {
    const all: OperationView[] = [];
    let more = false;
    for (let i = 0; i < pages; i++) {
      const r = await get<{ operations: OperationView[]; has_more: boolean }>(`/api/history?${props.query}&offset=${i * 30}`);
      all.push(...r.operations);
      more = r.has_more;
    }
    return { operations: all, has_more: more };
  }, [props.query, pages]);
  if (!state.data) return <Loading state={state} />;
  if (state.data.operations.length === 0) return <p class="empty muted">{U.empty}</p>;
  return (
    <>
      <ul class="history">
        {state.data.operations.map((o) => (
          <li key={o.id} class={o.undone ? "undone" : ""}>
            <div class="history-main">
              <span class="meta">
                {formatStamp(o.at)}・<span class={`actor actor-${o.actor}`}>{M.actor[o.actor]}</span>
              </span>
              {o.quest_id ? <Link href={`/quest/${o.quest_id}`}>{o.summary}</Link> : <span>{o.summary}</span>}
            </div>
            {o.undone ? (
              <span class="meta">{U.undone}</span>
            ) : (
              o.undoable && (
                <button class="small" onClick={() => confirm(U.undoConfirm) && run(() => op("undo", { operation_id: o.id }), state.reload)}>
                  {U.undo}
                </button>
              )
            )}
          </li>
        ))}
      </ul>
      {state.data.has_more && (
        <button class="more" onClick={() => setPages(pages + 1)}>
          {U.more}
        </button>
      )}
    </>
  );
}

function Runs() {
  const state = useData<{ runs: RunView[] }>(() => get("/api/runs"), []);
  const [open, setOpen] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  if (!state.data) return <Loading state={state} />;
  if (state.data.runs.length === 0) return <p class="empty muted">{U.empty}</p>;
  return (
    <ul class="runs">
      {state.data.runs.map((r) => (
        <li key={r.id}>
          <div class="run-head">
            <button class="link grow" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <span class="meta">
                {formatStamp(r.started_at)}・{M.runTrigger[r.trigger as keyof typeof M.runTrigger] ?? r.trigger}
              </span>
              <span>
                {U.runSummary(r.operations, r.proposals)} {open === r.id ? "▴" : "▾"}
              </span>
            </button>
            {r.operations > r.undone && (
              <button
                class="small"
                onClick={() =>
                  confirm(U.undoConfirm) &&
                  run(() => op("undo", { run_id: r.id }), async () => {
                    await state.reload();
                    setVersion(version + 1);
                  })
                }
              >
                {U.undoRun}
              </button>
            )}
          </div>
          {open === r.id && <Operations key={version} query={`run_id=${r.id}`} />}
        </li>
      ))}
    </ul>
  );
}

export function History(props: { questId: string | null }) {
  const [tab, setTab] = useState<"changes" | "runs">("changes");
  return (
    <div class="page">
      <h1>{U.title}</h1>
      {props.questId ? (
        <Operations query={`quest_id=${props.questId}`} />
      ) : (
        <>
          <div class="chips" role="tablist">
            <button role="tab" aria-selected={tab === "changes"} class={`chip-button ${tab === "changes" ? "on" : ""}`} onClick={() => setTab("changes")}>
              {U.changes}
            </button>
            <button role="tab" aria-selected={tab === "runs"} class={`chip-button ${tab === "runs" ? "on" : ""}`} onClick={() => setTab("runs")}>
              {U.runs}
            </button>
          </div>
          {tab === "changes" ? <Operations query="" /> : <Runs />}
        </>
      )}
    </div>
  );
}
