// 設定：ホームのパーツ、フォローアップの反映方式、繰り返しの定義、カレンダー、AIの自動起動
import { M } from "../../src/shared/messages";
import type { AiState, RecurringRow, SettingsView } from "../../src/shared/types";
import { get, op, post } from "../api";
import { Section } from "../components";
import { Loading, formatStamp, run, toast, useData } from "../lib";

const U = M.ui.settings;

interface Data {
  settings: SettingsView;
  recurring: RecurringRow[];
  calendar: { ready: boolean; connected: boolean; last_sync: string | null; last_error: string | null };
  ai: AiState;
}

function ruleText(r: RecurringRow): string {
  switch (r.rule_type) {
    case "weekly":
      return M.ui.rule.weekly((JSON.parse(r.weekdays ?? "[]") as number[]).map((d) => M.weekdays[d]).join("・"));
    case "monthly":
      return M.ui.rule.monthly(r.day_of_month ?? 1);
    case "interval":
      return M.ui.rule.interval(r.interval_days ?? 1);
    default:
      return M.ui.rule.daily;
  }
}

export function Settings() {
  const state = useData<Data>(() => get("/api/settings"), []);
  const d = state.data;
  if (!d) return <Loading state={state} />;
  const save = (patch: Partial<SettingsView> | { parts: Partial<SettingsView["parts"]> }) =>
    run(() => op("update_settings", patch), async () => {
      await state.reload();
      toast(U.saved);
    });
  const s = d.settings;
  const partKeys = Object.keys(s.parts) as (keyof SettingsView["parts"])[];

  return (
    <div class="page settings">
      <h1>{U.title}</h1>

      <Section title={U.parts}>
        {partKeys.map((k) => (
          <label key={k} class="check-label">
            <input type="checkbox" checked={s.parts[k]} onChange={(e) => save({ parts: { [k]: e.currentTarget.checked } })} />
            {U.partNames[k]}
          </label>
        ))}
      </Section>

      <Section title={U.followup}>
        <label class="check-label">
          <input type="radio" name="followup" checked={s.followup_mode === "approval"} onChange={() => save({ followup_mode: "approval" })} />
          {U.followupApproval}
        </label>
        <label class="check-label">
          <input type="radio" name="followup" checked={s.followup_mode === "immediate"} onChange={() => save({ followup_mode: "immediate" })} />
          {U.followupImmediate}
        </label>
      </Section>

      <Section title={U.thresholds}>
        <label class="field-row">
          {U.carryover}
          <input
            type="number"
            min={1}
            max={30}
            value={s.stalled_carryover_count}
            onChange={(e) => save({ stalled_carryover_count: Number(e.currentTarget.value) })}
          />
        </label>
        <label class="field-row">
          {U.staleDays}
          <input type="number" min={1} max={365} value={s.stale_days} onChange={(e) => save({ stale_days: Number(e.currentTarget.value) })} />
        </label>
        <label class="field-row">
          {U.timezone}
          <input type="text" value={s.timezone} onChange={(e) => save({ timezone: e.currentTarget.value.trim() })} />
        </label>
      </Section>

      <Section title={U.recurring}>
        {d.recurring.length === 0 && <p class="empty muted">{U.recurringEmpty}</p>}
        <ul class="recurring">
          {d.recurring.map((r) => (
            <li key={r.id}>
              <div>
                <span>{r.title}</span>
                <span class="meta">{ruleText(r)}</span>
              </div>
              <label class="check-label">
                <input
                  type="checkbox"
                  checked={!!r.active}
                  onChange={(e) => run(() => op("set_recurring", { recurring_id: r.id, active: e.currentTarget.checked }), state.reload)}
                />
                {U.recurringActive}
              </label>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={U.calendar}>
        {!d.calendar.ready ? (
          <p class="muted">{U.calendarNotReady}</p>
        ) : d.calendar.connected ? (
          <>
            <p>
              {U.calendarConnected}
              {d.calendar.last_sync && (
                <span class="meta">
                  {" "}
                  {U.calendarLastSync} {formatStamp(d.calendar.last_sync)}
                </span>
              )}
            </p>
            {d.calendar.last_error && <p class="error">{d.calendar.last_error}</p>}
            <div class="row wrap">
              <button onClick={() => run(() => post("/api/calendar/sync"), state.reload)}>{U.calendarSync}</button>
              <button class="danger" onClick={() => run(() => post("/api/calendar/disconnect"), state.reload)}>
                {U.calendarDisconnect}
              </button>
            </div>
          </>
        ) : (
          <>
            <p class="muted">{U.calendarNotConnected}</p>
            <a class="button primary" href="/google/connect">
              {U.calendarConnect}
            </a>
          </>
        )}
      </Section>

      <Section title={U.ai}>
        <p class={d.ai.configured ? "" : "muted"}>{d.ai.configured ? U.aiConfigured : U.aiNotConfigured}</p>
        {d.ai.last_error && <p class="error">{d.ai.last_error}</p>}
      </Section>

      <button
        class="logout"
        onClick={() =>
          run(() => post("/api/logout"), () => {
            location.href = "/";
          })
        }
      >
        {U.logout}
      </button>
    </div>
  );
}
