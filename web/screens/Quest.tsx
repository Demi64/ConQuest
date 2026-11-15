// クエストの内容（ウィンドウの右側）：完了条件、目的（タスク）、情報、紐づく予定、ジャーナル、提案、状態の変更
import { useState } from "preact/hooks";
import { M } from "../../src/shared/messages";
import type { EventView, QuestDetail } from "../../src/shared/types";
import { get, op } from "../api";
import { Dialog, EventItem, ProposalCard, QuickAdd, ReasonDialog, Section, TaskItem, questGlyph } from "../components";
import { Link, Loading, formatDate, formatDue, formatStamp, isDueSoon, navigate, run, todayLocal, useData } from "../lib";

const U = M.ui;
type Pending = null | "on_hold" | "discarded" | "board" | "events";

function EventPicker(props: { quest: QuestDetail; today: string; onClose: () => void; onChange: () => Promise<void> }) {
  const state = useData<{ events: EventView[] }>(() => get(`/api/events?from=${props.today}`), [props.today]);
  const linked = new Set(props.quest.events.map((e) => e.id));
  return (
    <Dialog title={U.events.pick} onClose={props.onClose}>
      {!state.data ? (
        <Loading state={state} />
      ) : (
        <ul class="events picker">
          {state.data.events.length === 0 && <p class="empty muted">{U.events.empty}</p>}
          {state.data.events
            .filter((e) => !linked.has(e.id))
            .map((e) => (
              <EventItem
                key={e.id}
                event={e}
                today={props.today}
                showLinks={false}
                action={
                  <button
                    class="small"
                    onClick={async () => {
                      await run(() => op("update_quest", { quest_id: props.quest.id, add_event_ids: [e.id] }), props.onChange);
                      props.onClose();
                    }}
                  >
                    {U.events.linked}
                  </button>
                }
              />
            ))}
        </ul>
      )}
      <div class="row end">
        <button onClick={props.onClose}>{U.close}</button>
      </div>
    </Dialog>
  );
}

export function Quest(props: { id: string; listHref: string }) {
  const state = useData<QuestDetail>(() => get(`/api/quests/${props.id}`), [props.id], 30000);
  const [pending, setPending] = useState<Pending>(null);
  const [showDone, setShowDone] = useState(false);
  const q = state.data;
  if (!q) return <Loading state={state} />;
  const today = todayLocal();
  const reload = state.reload;
  const isDaily = q.kind === "daily";
  const closed = q.status === "completed" || q.status === "discarded";
  const openTasks = q.tasks.filter((t) => t.status === "open");
  const doneTasks = q.tasks.filter((t) => t.status !== "open");

  const setStatus = (status: string, reason: string, resumeOn?: string | null) =>
    run(() => op("set_quest_status", { quest_id: q.id, status, reason, resume_on: resumeOn ?? undefined }), reload);
  const complete = () => {
    if (openTasks.length > 0 && !confirm(U.quest.completeConfirmOpen(openTasks.length))) return;
    void run(() => op("complete_quest", { quest_id: q.id }), reload);
  };
  const facts: [string, string | null][] = [
    [U.quest.due, q.due ? formatDue(q.due, today) : null],
    [U.quest.requester, q.requester],
    [U.quest.location, q.location],
    [U.quest.requiredEnv, q.required_env],
    [U.quest.resumeOn, q.resume_on ? formatDate(q.resume_on, today) : null],
  ];

  const shownFacts = facts.filter(([, v]) => v);

  return (
    <article class={`quest-detail kind-${q.kind}`}>
      <Link href={props.listHref} class="back narrow-only">
        ‹ {U.log.backToList}
      </Link>
      <header class="quest-head">
        <span class="quest-glyph" aria-hidden="true">
          {questGlyph(q)}
        </span>
        <div class="quest-head-main">
          <h1>{q.title}</h1>
          <div class="badges">
            <span class={`badge status-${q.status}`}>{q.awaiting_report ? U.tracker.awaiting : M.questStatus[q.status]}</span>
            {q.kind !== "normal" && <span class={`badge kind-${q.kind}`}>{M.questKind[q.kind]}</span>}
            {q.progress.total > 0 && <span class="meta">{U.quest.progress(q.progress.done, q.progress.total)}</span>}
          </div>
        </div>
      </header>

      {q.awaiting_report && (
        <div class="report-banner">
          <span>{U.tracker.awaiting}</span>
          <button class="primary" onClick={complete}>
            {U.quest.complete}
          </button>
        </div>
      )}

      {q.completion_condition && (
        <Section title={U.quest.completionCondition} icon="❖">
          <p class="condition">{q.completion_condition}</p>
        </Section>
      )}

      {q.proposals.length > 0 && (
        <Section title={U.quest.proposals} count={q.proposals.length}>
          <ul class="proposals">
            {q.proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} onChange={reload} showQuest={false} />
            ))}
          </ul>
        </Section>
      )}

      <Section title={U.quest.objectives} count={openTasks.length} icon="!">
        <ul class="tasks">
          {openTasks.map((t, i) => (
            <TaskItem key={t.id} task={t} today={today} onChange={reload} readOnly={closed} current={i === 0 && !closed && !isDaily} />
          ))}
        </ul>
        {!closed && (
          <QuickAdd
            placeholder={U.quest.addTaskPlaceholder}
            onAdd={async (title) => {
              await op("add_tasks", { quest_id: q.id, tasks: [{ title }] });
              await reload();
            }}
          />
        )}
        {doneTasks.length > 0 && (
          <>
            <button class="link" onClick={() => setShowDone(!showDone)}>
              {U.quest.doneTasks(doneTasks.length)} {showDone ? "▴" : "▾"}
            </button>
            {showDone && (
              <ul class="tasks">
                {doneTasks.map((t) => (
                  <TaskItem key={t.id} task={t} today={today} onChange={reload} readOnly={closed} />
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      {(shownFacts.length > 0 || q.prerequisites.length > 0) && (
        <Section title={U.quest.info} icon="i">
          <dl class="facts">
            {shownFacts.map(([k, v]) => (
              <div key={k} class={k === U.quest.due && q.status === "active" && isDueSoon(q.due, today) ? "soon" : ""}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {q.prerequisites.length > 0 && (
            <p class="meta">
              {U.quest.prerequisites}：
              {q.prerequisites.map((p) => (
                <Link key={p.id} href={`/quest/${p.id}`} class="chip">
                  {p.title}（{M.questStatus[p.status]}）
                </Link>
              ))}
            </p>
          )}
        </Section>
      )}

      {!isDaily && (
        <Section
          icon="◷"
          title={U.quest.events}
          action={
            !closed && (
              <button class="small" onClick={() => setPending("events")}>
                {U.events.link}
              </button>
            )
          }
        >
          {q.events.length === 0 ? (
            <p class="empty muted">{U.none}</p>
          ) : (
            <ul class="events">
              {q.events.map((e) => (
                <EventItem
                  key={e.id}
                  event={e}
                  today={today}
                  showLinks={false}
                  action={
                    !closed && (
                      <button class="small" onClick={() => run(() => op("update_quest", { quest_id: q.id, remove_event_ids: [e.id] }), reload)}>
                        {U.events.unlink}
                      </button>
                    )
                  }
                />
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title={U.quest.journal} icon="✎">
        {q.journal.length === 0 && <p class="empty muted">{U.none}</p>}
        <ul class="journal">
          {q.journal.map((j) => (
            <li key={j.id}>
              <span class="meta">
                {formatStamp(j.created_at)}・{M.actor[j.author]}
              </span>
              <p>{j.body}</p>
            </li>
          ))}
        </ul>
        <QuickAdd
          placeholder={U.quest.addJournal}
          onAdd={async (body) => {
            await op("append_journal", { quest_id: q.id, body });
            await reload();
          }}
        />
      </Section>

      {!isDaily && (
        <footer class="quest-actions">
          {q.status === "active" && (
            <label class="check-label">
              <input
                type="checkbox"
                checked={q.tracked}
                onChange={(e) => run(() => op("update_quest", { quest_id: q.id, tracked: e.currentTarget.checked }), reload)}
              />
              {U.quest.tracked}
            </label>
          )}
          <div class="row wrap action-bar">
            {q.status === "board" && <button class="primary" onClick={() => setStatus("active", U.quest.accept)}>{U.quest.accept}</button>}
            {q.status === "on_hold" && <button class="primary" onClick={() => setStatus("active", U.quest.resume)}>{U.quest.resume}</button>}
            {q.status === "active" && !q.awaiting_report && <button onClick={complete}>{U.quest.complete}</button>}
            {q.status === "active" && <button onClick={() => setPending("on_hold")}>{U.quest.hold}</button>}
            {(q.status === "active" || q.status === "on_hold") && <button onClick={() => setPending("board")}>{U.quest.toBoard}</button>}
            {!closed && <button class="danger" onClick={() => setPending("discarded")}>{U.quest.discard}</button>}
            {closed && <button onClick={() => run(() => op("reopen_quest", { quest_id: q.id }), reload)}>{U.quest.restore}</button>}
            {q.status === "discarded" && (
              <button
                class="danger"
                onClick={() => confirm(U.quest.purgeConfirm) && run(() => op("purge_quest", { quest_id: q.id }), () => navigate(props.listHref))}
              >
                {U.quest.purge}
              </button>
            )}
          </div>
          <Link href={`/history?quest_id=${q.id}`} class="meta">
            {U.quest.history} ›
          </Link>
          <p class="meta">
            {U.quest.updated} {formatStamp(q.updated_at)}
          </p>
        </footer>
      )}

      {(pending === "on_hold" || pending === "discarded" || pending === "board") && (
        <ReasonDialog
          title={pending === "on_hold" ? U.quest.hold : pending === "discarded" ? U.quest.discard : U.quest.toBoard}
          withDate={pending === "on_hold"}
          onClose={() => setPending(null)}
          onSubmit={(reason, date) => setStatus(pending, reason, date)}
        />
      )}
      {pending === "events" && <EventPicker quest={q} today={today} onClose={() => setPending(null)} onChange={reload} />}
    </article>
  );
}
