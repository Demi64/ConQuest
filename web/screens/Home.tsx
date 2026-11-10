// ホーム：入力欄、今日のデイリー、トラッカー、提案、予定。各パーツは設定で表示／非表示を切り替えられる
import { useState } from "preact/hooks";
import { M } from "../../src/shared/messages";
import type { HomeView } from "../../src/shared/types";
import { op, post } from "../api";
import { EventItem, ProposalCard, QuestCard, QuickAdd, Section, TaskItem } from "../components";
import { Link, Loading, run, toast, useData } from "../lib";
import { get } from "../api";

const U = M.ui;

function InputPart(props: { home: HomeView; reload: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const { home } = props;
  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    const ok = await run(() => op("add_input", { body }), props.reload);
    if (ok) {
      setText("");
      toast(home.ai.configured ? U.input.sent : U.settings.aiNotConfigured);
    }
    setBusy(false);
  };
  return (
    <Section title={U.input.title} class="input-part">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={text}
          rows={3}
          placeholder={U.input.placeholder}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void submit()}
        />
        <div class="row end">
          {home.pending_inputs.length > 0 && <span class="meta grow">{U.input.pending(home.pending_inputs.length)}</span>}
          {home.pending_inputs.length > 0 && home.ai.configured && !home.ai.organizing && (
            <button type="button" onClick={() => run(() => post("/api/refresh"), props.reload)}>
              {U.input.refresh}
            </button>
          )}
          <button class="primary" disabled={!text.trim() || busy}>
            {U.input.submit}
          </button>
        </div>
      </form>
      {home.pending_inputs.length > 0 && (
        <ul class="pending-inputs">
          {home.pending_inputs.map((i) => (
            <li key={i.id}>{i.body}</li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function Home() {
  const [fast, setFast] = useState(false);
  // AIが整理している間は短い間隔で読み直す
  const state = useData<HomeView>(
    async () => {
      const h = await get<HomeView>("/api/home");
      setFast(h.ai.organizing);
      return h;
    },
    [],
    fast ? 4000 : 30000,
  );
  const home = state.data;
  if (!home) return <Loading state={state} />;
  const { parts } = home.settings;
  const reload = state.reload;
  const openDaily = home.daily.tasks.filter((t) => t.status === "open");
  const closedDaily = home.daily.tasks.filter((t) => t.status !== "open");

  return (
    <div class="home">
      <div class="status-line">
        {home.ai.organizing && <span class="organizing">{U.organizing}</span>}
        {home.ai.last_error && <span class="error" title={home.ai.last_error}>{U.aiError}</span>}
      </div>
      <div class="home-grid">
        <div class="col">
          {parts.input && <InputPart home={home} reload={reload} />}
          {parts.daily && (
            <Section title={U.daily.title} count={openDaily.length}>
              {home.daily.tasks.length === 0 && <p class="empty muted">{U.daily.empty}</p>}
              <ul class="tasks">
                {[...openDaily, ...closedDaily].map((t) => (
                  <TaskItem key={t.id} task={t} today={home.today} onChange={reload} />
                ))}
              </ul>
              <QuickAdd
                placeholder={U.daily.add}
                onAdd={async (title) => {
                  await op("add_tasks", { daily_date: home.today, tasks: [{ title }] });
                  await reload();
                }}
              />
            </Section>
          )}
          {parts.events && (
            <Section title={U.events.title} class="events-part">
              {!home.calendar_connected ? (
                <p class="empty muted">
                  <Link href="/settings">{U.events.notConnected}</Link>
                </p>
              ) : home.events.length === 0 ? (
                <p class="empty muted">{U.events.empty}</p>
              ) : (
                <ul class="events">
                  {home.events.map((e) => (
                    <EventItem key={e.id} event={e} today={home.today} />
                  ))}
                </ul>
              )}
            </Section>
          )}
        </div>
        <div class="col">
          {parts.proposals && home.proposals.length > 0 && (
            <Section title={U.proposals.title} count={home.proposals.length}>
              <ul class="proposals">
                {home.proposals.map((p) => (
                  <ProposalCard key={p.id} proposal={p} onChange={reload} />
                ))}
              </ul>
            </Section>
          )}
          {parts.tracker && (
            <Section title={U.tracker.title} count={home.tracker.length}>
              {home.tracker.length === 0 && <p class="empty muted">{U.tracker.empty}</p>}
              <ul class="quests">
                {home.tracker.map((q) => (
                  <QuestCard key={q.id} quest={q} today={home.today} onChange={reload} />
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
