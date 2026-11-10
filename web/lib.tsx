// 画面の共通部品：画面遷移、データの読み込み、お知らせ、日付の表示
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { M } from "../src/shared/messages";

// ---------- 画面遷移 ----------

export function navigate(path: string): void {
  if (path === location.pathname + location.search) return;
  history.pushState(null, "", path);
  window.dispatchEvent(new Event("popstate"));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

export function Link(props: { href: string; class?: string; children: ComponentChildren; title?: string }) {
  return (
    <a
      href={props.href}
      class={props.class}
      title={props.title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate(props.href);
      }}
    >
      {props.children}
    </a>
  );
}

// ---------- お知らせ ----------

let pushToast: (text: string, kind: "info" | "error") => void = () => {};
export const toast = (text: string): void => pushToast(text, "info");
export const toastError = (e: unknown): void => pushToast(e instanceof Error ? e.message : M.error.unknown, "error");

export function Toasts() {
  const [items, setItems] = useState<{ id: number; text: string; kind: string }[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    pushToast = (text, kind) => {
      const id = ++seq.current;
      setItems((list) => [...list, { id, text, kind }]);
      setTimeout(() => setItems((list) => list.filter((i) => i.id !== id)), kind === "error" ? 6000 : 3000);
    };
  }, []);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {items.map((i) => (
        <div key={i.id} class={`toast ${i.kind}`}>
          {i.text}
        </div>
      ))}
    </div>
  );
}

/** 操作を実行し、失敗したらお知らせを出す。成功したら true */
export async function run(action: () => Promise<unknown>, done?: () => void | Promise<void>): Promise<boolean> {
  try {
    await action();
    await done?.();
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

// ---------- データの読み込み ----------

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * データを読み込む。画面に戻ってきたときと、intervalMs ごとに読み直す。
 * 読み直しの間も前のデータを出し続ける（画面はAIやサーバーを待たない）。
 */
export function useData<T>(fetcher: () => Promise<T>, deps: unknown[], intervalMs?: number): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const d = await fetcher();
      if (mine === latest.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === latest.current) setError(e instanceof Error ? e.message : M.error.unknown);
    }
  }, deps);
  useEffect(() => {
    setData(null);
    void reload();
    const onVisible = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", onVisible);
    const timer = intervalMs ? setInterval(() => document.visibilityState === "visible" && void reload(), intervalMs) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearInterval(timer);
    };
  }, [reload, intervalMs]);
  return { data, error, reload };
}

export function Loading(props: { state: Loaded<unknown> }) {
  if (props.state.error) {
    return (
      <div class="empty">
        <p class="error">{props.state.error}</p>
        <button onClick={() => void props.state.reload()}>{M.ui.retry}</button>
      </div>
    );
  }
  return <div class="empty muted">{M.ui.loading}</div>;
}

// ---------- 日付の表示 ----------

const pad = (n: number) => String(n).padStart(2, "0");

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 「11/13（金）」。今日・明日はその言葉で出す */
export function formatDate(date: string, today: string = todayLocal()): string {
  const d = new Date(`${date}T00:00:00`);
  const diff = Math.round((d.getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000);
  if (diff === 0) return M.ui.events.today;
  if (diff === 1) return M.ui.events.tomorrow;
  const year = date.slice(0, 4) === today.slice(0, 4) ? "" : `${d.getFullYear()}/`;
  return `${year}${d.getMonth() + 1}/${d.getDate()}（${M.weekdays[d.getDay()]}）`;
}

/** 期限（YYYY-MM-DD か YYYY-MM-DDTHH:MM） */
export function formatDue(due: string, today?: string): string {
  return due.length > 10 ? `${formatDate(due.slice(0, 10), today)} ${due.slice(11)}` : formatDate(due, today);
}

/** 記録の日時（ISO）を端末の時刻で「11/10 21:05」 */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 期限が今日以前か（目立たせる用） */
export const isDueSoon = (due: string | null, today: string): boolean => !!due && due.slice(0, 10) <= today;
