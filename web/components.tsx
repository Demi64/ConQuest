// 複数の画面で使う部品
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { M } from "../src/shared/messages";
import type { EventView, ProposalView, QuestSummary, TaskView } from "../src/shared/types";
import { op } from "./api";
import { Link, formatDate, formatDue, isDueSoon, run } from "./lib";

const U = M.ui;

export function Section(props: { title: string; count?: number; action?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`part ${props.class ?? ""}`}>
      <header class="part-head">
        <h2>
          {props.title}
          {props.count ? <span class="count">{props.count}</span> : null}
        </h2>
        {props.action}
      </header>
      {props.children}
    </section>
  );
}

/** 確認や理由の入力に使う小さなダイアログ */
export function Dialog(props: { title: string; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onClose={props.onClose} onClick={(e) => e.target === ref.current && props.onClose()}>
      <div class="dialog-body">
        <h3>{props.title}</h3>
        {props.children}
      </div>
    </dialog>
  );
}

/** 理由（必須）と、必要なら再開日を聞く */
export function ReasonDialog(props: {
  title: string;
  withDate?: boolean;
  onSubmit: (reason: string, date: string | null) => Promise<unknown> | void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  return (
    <Dialog title={props.title} onClose={props.onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!reason.trim()) return;
          await props.onSubmit(reason.trim(), date || null);
          props.onClose();
        }}
      >
        <label>
          {U.quest.reasonPrompt}
          <textarea value={reason} onInput={(e) => setReason(e.currentTarget.value)} rows={3} required autofocus />
        </label>
        {props.withDate && (
          <label>
            {U.quest.resumeOnPrompt}
            <input type="date" value={date} onInput={(e) => setDate(e.currentTarget.value)} />
          </label>
        )}
        <div class="row end">
          <button type="button" onClick={props.onClose}>
            {U.cancel}
          </button>
          <button class="primary" disabled={!reason.trim()}>
            {U.confirm}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** 1行の入力欄（タスクの追加など）。Enterで確定 */
export function QuickAdd(props: { placeholder: string; onAdd: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      class="quick-add"
      onSubmit={async (e) => {
        e.preventDefault();
        const value = text.trim();
        if (!value || busy) return;
        setBusy(true);
        if (await run(() => props.onAdd(value))) setText("");
        setBusy(false);
      }}
    >
      <input value={text} onInput={(e) => setText(e.currentTarget.value)} placeholder={props.placeholder} enterkeyhint="done" />
      <button disabled={!text.trim() || busy} aria-label={props.placeholder}>
        ＋
      </button>
    </form>
  );
}

export function TaskItem(props: { task: TaskView; today: string; onChange: () => void; questTitle?: string; readOnly?: boolean }) {
  const { task: t } = props;
  const [open, setOpen] = useState(false);
  const set = (status: TaskView["status"]) => run(() => op("set_task_status", { task_id: t.id, status }), props.onChange);
  const meta = [
    t.due ? `${U.quest.due} ${formatDue(t.due, props.today)}` : null,
    t.location,
    t.required_env,
    t.carryover_count > 0 ? U.daily.carried(t.carryover_count) : null,
  ].filter(Boolean);
  return (
    <li class={`task ${t.status}`}>
      <button
        class="check"
        role="checkbox"
        aria-checked={t.status === "done"}
        aria-label={t.title}
        disabled={props.readOnly || t.status === "dropped"}
        onClick={() => set(t.status === "open" ? "done" : "open")}
      >
        {t.status === "done" ? "✓" : t.status === "dropped" ? "–" : ""}
      </button>
      <div class="task-main" onClick={() => !props.readOnly && setOpen(!open)}>
        <span class="task-title">{t.title}</span>
        {meta.length > 0 && (
          <span class={`meta ${t.status === "open" && isDueSoon(t.due, props.today) ? "soon" : ""}`}>{meta.join("・")}</span>
        )}
        {open && (
          <span class="row task-actions">
            {t.status === "open" ? (
              <button class="small" onClick={() => set("dropped")}>
                {U.quest.drop}
              </button>
            ) : (
              <button class="small" onClick={() => set("open")}>
                {U.quest.reopenTask}
              </button>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

export function ProposalCard(props: { proposal: ProposalView; onChange: () => void; showQuest?: boolean }) {
  const { proposal: p } = props;
  const [busy, setBusy] = useState(false);
  const resolve = async (decision: "approve" | "reject") => {
    setBusy(true);
    await run(async () => {
      const r = await op<{ status: string; message?: string }>("resolve_proposal", { proposal_id: p.id, decision });
      if (r.status === "expired") throw new Error(`${M.proposalStatus.expired}：${r.message ?? ""}`);
    }, props.onChange);
    setBusy(false);
  };
  return (
    <li class={`proposal kind-${p.kind}`}>
      <div class="proposal-head">
        <span class={`badge kind-${p.kind}`}>{M.proposalKind[p.kind]}</span>
        {p.quest_id && props.showQuest !== false ? (
          <Link href={`/quest/${p.quest_id}`} class="proposal-target">
            {p.target_title ?? p.quest_title}
          </Link>
        ) : (
          <span class="proposal-target">{p.target_title}</span>
        )}
      </div>
      {p.target_type === "task" && p.quest_title && props.showQuest !== false && <div class="meta">{p.quest_title}</div>}
      <div class="proposal-action">{p.action_text}</div>
      <div class="meta">
        {U.proposals.reason}：{p.reason}
      </div>
      <div class="row end">
        <button disabled={busy} onClick={() => resolve("reject")}>
          {U.proposals.reject}
        </button>
        <button class="primary" disabled={busy} onClick={() => resolve("approve")}>
          {U.proposals.approve}
        </button>
      </div>
    </li>
  );
}

export function EventItem(props: { event: EventView; today: string; action?: ComponentChildren; showLinks?: boolean }) {
  const { event: e } = props;
  const day = e.end_date !== e.date ? `${formatDate(e.date, props.today)}〜${formatDate(e.end_date, props.today)}` : formatDate(e.date, props.today);
  const time = e.all_day ? U.events.allDay : `${e.time}〜${e.end_time}`;
  return (
    <li class={`event ${e.date <= props.today ? "today" : ""}`}>
      <div class="event-when">
        <span>{day}</span>
        <span class="meta">{time}</span>
      </div>
      <div class="event-main">
        <span>{e.title ?? "—"}</span>
        {e.location && <span class="meta">{e.location}</span>}
        {props.showLinks !== false &&
          e.linked.map(
            (l) =>
              l.quest_id && (
                <Link href={`/quest/${l.quest_id}`} class="chip">
                  {l.task_title ?? l.quest_title}
                </Link>
              ),
          )}
      </div>
      {props.action}
    </li>
  );
}

export function QuestCard(props: { quest: QuestSummary; today: string; onChange: () => void; action?: ComponentChildren }) {
  const { quest: q } = props;
  const complete = () => run(() => op("complete_quest", { quest_id: q.id }), props.onChange);
  const meta = [
    q.due ? `${U.quest.due} ${formatDue(q.due, props.today)}` : null,
    q.status === "on_hold" && q.resume_on ? `${U.quest.resumeOn} ${formatDate(q.resume_on, props.today)}` : null,
    q.requester,
    q.location,
  ].filter(Boolean);
  return (
    <li class={`quest-card ${q.awaiting_report ? "awaiting" : ""}`}>
      <Link href={`/quest/${q.id}`} class="quest-card-main">
        <span class="quest-title">
          {q.kind === "event" && <span class="badge kind-event">{M.questKind.event}</span>}
          {q.title}
        </span>
        {q.awaiting_report ? (
          <span class="objective awaiting-label">{U.tracker.awaiting}</span>
        ) : q.status === "active" || q.status === "on_hold" ? (
          <span class="objective">{q.current_objective?.title ?? U.tracker.noObjective}</span>
        ) : null}
        <span class={`meta ${q.status === "active" && isDueSoon(q.due, props.today) ? "soon" : ""}`}>
          {[...(q.progress.total ? [U.quest.progress(q.progress.done, q.progress.total)] : []), ...meta].join("・")}
          {q.pending_proposals > 0 && <span class="chip">{U.proposals.badge(q.pending_proposals)}</span>}
        </span>
      </Link>
      {q.awaiting_report ? (
        <button class="primary complete" onClick={complete}>
          {U.tracker.complete}
        </button>
      ) : (
        props.action
      )}
    </li>
  );
}
