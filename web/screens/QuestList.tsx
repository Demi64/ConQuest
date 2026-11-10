// ログ（受注済みクエストの一覧と絞り込み）と Quest Board（受注前の候補）
import { useEffect, useState } from "preact/hooks";
import { M } from "../../src/shared/messages";
import type { QuestStatus, QuestSummary } from "../../src/shared/types";
import { get, op } from "../api";
import { QuestCard } from "../components";
import { Loading, run, todayLocal, useData } from "../lib";

const U = M.ui;
const PAGE = 30;
const LOG_STATUSES: QuestStatus[] = ["active", "on_hold", "completed", "discarded"];

interface Result {
  total: number;
  quests: QuestSummary[];
}

function useQuests(status: string, keyword: string, includeDaily: boolean) {
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [status, keyword, includeDaily]);
  const state = useData<Result>(async () => {
    const q = new URLSearchParams({ status, limit: String(Math.min(limit, 100)) });
    if (keyword) q.set("keyword", keyword);
    const r = await get<Result>(`/api/quests?${q}`);
    return includeDaily ? r : { ...r, quests: r.quests.filter((x) => x.kind !== "daily") };
  }, [status, keyword, includeDaily, limit]);
  return { state, more: () => setLimit((n) => n + PAGE), limit };
}

export function Log() {
  const [status, setStatus] = useState<QuestStatus>("active");
  const [keyword, setKeyword] = useState("");
  const [includeDaily, setIncludeDaily] = useState(false);
  const { state, more, limit } = useQuests(status, keyword, includeDaily);
  const today = todayLocal();
  return (
    <div class="page">
      <h1>{U.log.title}</h1>
      <div class="filters">
        <div class="chips" role="tablist">
          {LOG_STATUSES.map((s) => (
            <button key={s} role="tab" aria-selected={s === status} class={`chip-button ${s === status ? "on" : ""}`} onClick={() => setStatus(s)}>
              {M.questStatus[s]}
            </button>
          ))}
        </div>
        <input type="search" placeholder={U.log.search} value={keyword} onInput={(e) => setKeyword(e.currentTarget.value)} />
        {status === "completed" && (
          <label class="check-label">
            <input type="checkbox" checked={includeDaily} onChange={(e) => setIncludeDaily(e.currentTarget.checked)} />
            {U.log.includeDaily}
          </label>
        )}
      </div>
      {!state.data ? (
        <Loading state={state} />
      ) : state.data.quests.length === 0 ? (
        <p class="empty muted">{U.log.empty}</p>
      ) : (
        <>
          <ul class="quests">
            {state.data.quests.map((q) => (
              <QuestCard key={q.id} quest={q} today={today} onChange={state.reload} />
            ))}
          </ul>
          {state.data.total > limit && limit < 100 && (
            <button class="more" onClick={more}>
              {U.log.more}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function Board() {
  const [keyword, setKeyword] = useState("");
  const { state, more, limit } = useQuests("board", keyword, false);
  const today = todayLocal();
  return (
    <div class="page">
      <h1>{U.board.title}</h1>
      <div class="filters">
        <input type="search" placeholder={U.log.search} value={keyword} onInput={(e) => setKeyword(e.currentTarget.value)} />
      </div>
      {!state.data ? (
        <Loading state={state} />
      ) : state.data.quests.length === 0 ? (
        <p class="empty muted">{U.board.empty}</p>
      ) : (
        <>
          <ul class="quests">
            {state.data.quests.map((q) => (
              <QuestCard
                key={q.id}
                quest={q}
                today={today}
                onChange={state.reload}
                action={
                  <button
                    onClick={() =>
                      run(() => op("set_quest_status", { quest_id: q.id, status: "active", reason: U.board.accept }), state.reload)
                    }
                  >
                    {U.board.accept}
                  </button>
                }
              />
            ))}
          </ul>
          {state.data.total > limit && limit < 100 && (
            <button class="more" onClick={more}>
              {U.log.more}
            </button>
          )}
        </>
      )}
    </div>
  );
}
