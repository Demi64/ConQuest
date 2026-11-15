// クエストのウィンドウ：左に一覧（ログ または Quest Board）、右に選んだクエストの内容。
// 幅が狭い画面では、一覧と内容を1枚ずつ切り替えて出す。
import { useEffect, useState } from "preact/hooks";
import { M } from "../../src/shared/messages";
import type { QuestStatus, QuestSummary } from "../../src/shared/types";
import { get } from "../api";
import { QuestRow, Window } from "../components";
import { Loading, todayLocal, useData } from "../lib";
import { Quest } from "./Quest";

const U = M.ui;
const PAGE = 30;
const LOG_STATUSES: QuestStatus[] = ["active", "on_hold", "completed", "discarded"];
type GroupKey = keyof typeof U.log.groups;
const GROUP_ORDER: GroupKey[] = ["awaiting", "event", "normal", "daily"];

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

/** 見出しつきのまとまりに分ける：報告待ち → イベント → クエスト → デイリー */
function grouped(quests: QuestSummary[]): [GroupKey, QuestSummary[]][] {
  const map = new Map<GroupKey, QuestSummary[]>();
  for (const q of quests) {
    const key: GroupKey = q.awaiting_report ? "awaiting" : q.kind;
    map.set(key, [...(map.get(key) ?? []), q]);
  }
  return GROUP_ORDER.filter((k) => map.has(k)).map((k) => [k, map.get(k)!]);
}

function QuestList(props: { mode: "log" | "board"; selected: string | null }) {
  const [status, setStatus] = useState<QuestStatus>("active");
  const [keyword, setKeyword] = useState("");
  const [includeDaily, setIncludeDaily] = useState(false);
  const isLog = props.mode === "log";
  const { state, more, limit } = useQuests(isLog ? status : "board", keyword, isLog && includeDaily);
  const today = todayLocal();
  const quests = state.data?.quests ?? [];
  return (
    <div class="quest-list">
      <div class="filters">
        {isLog && (
          <div class="tabs" role="tablist">
            {LOG_STATUSES.map((s) => (
              <button key={s} role="tab" aria-selected={s === status} class={`tab ${s === status ? "on" : ""}`} onClick={() => setStatus(s)}>
                {M.questStatus[s]}
              </button>
            ))}
          </div>
        )}
        <input type="search" placeholder={U.log.search} value={keyword} onInput={(e) => setKeyword(e.currentTarget.value)} />
        {isLog && status === "completed" && (
          <label class="check-label">
            <input type="checkbox" checked={includeDaily} onChange={(e) => setIncludeDaily(e.currentTarget.checked)} />
            {U.log.includeDaily}
          </label>
        )}
      </div>
      <div class="quest-list-body">
        {!state.data ? (
          <Loading state={state} />
        ) : quests.length === 0 ? (
          <p class="empty muted">{isLog ? U.log.empty : U.board.empty}</p>
        ) : (
          <>
            {grouped(quests).map(([key, list]) => (
              <section key={key} class={`quest-group group-${key}`}>
                <h3 class="group-head">
                  <span class="glyph" aria-hidden="true">
                    ❖
                  </span>
                  {U.log.groups[key]}
                  <span class="group-count">{list.length}</span>
                </h3>
                <ul>
                  {list.map((q) => (
                    <QuestRow key={q.id} quest={q} today={today} selected={q.id === props.selected} onChange={state.reload} />
                  ))}
                </ul>
              </section>
            ))}
            {state.data.total > limit && limit < 100 && (
              <button class="more" onClick={more}>
                {U.log.more}
              </button>
            )}
          </>
        )}
      </div>
      <footer class="quest-list-foot">
        <span>{isLog ? M.questStatus[status] : U.board.title}</span>
        <span class="num">{U.log.count(quests.length)}</span>
      </footer>
    </div>
  );
}

export function QuestWindow(props: { mode: "log" | "board"; questId: string | null; onClose: () => void }) {
  return (
    <Window title={props.mode === "log" ? U.log.title : U.board.title} wide onClose={props.onClose}>
      <div class={`panes ${props.questId ? "has-detail" : ""}`}>
        <div class="pane-list">
          <QuestList key={props.mode} mode={props.mode} selected={props.questId} />
        </div>
        <div class="pane-detail">
          {props.questId ? <Quest id={props.questId} listHref={`/${props.mode}`} /> : <p class="empty muted pane-empty">{U.quest.select}</p>}
        </div>
      </div>
    </Window>
  );
}
