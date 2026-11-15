// 画面の入口：ログインの確認、ホーム（HUD）とその上に重ねるウィンドウの切り替え、下（PCでは左）のナビ
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { M } from "../src/shared/messages";
import { ApiError, get, post } from "./api";
import { Window } from "./components";
import { Link, Toasts, navigate, toastError, usePath } from "./lib";
import { History } from "./screens/History";
import { Home } from "./screens/Home";
import { QuestWindow } from "./screens/QuestList";
import { Settings } from "./screens/Settings";

const U = M.ui;

function Login(props: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main class="auth-card">
      <h1>{U.login.title}</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await post("/api/login", { password });
            props.onDone();
          } catch (err) {
            toastError(err);
          }
          setBusy(false);
        }}
      >
        <label>
          {U.login.password}
          <input type="password" autocomplete="current-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} required autofocus />
        </label>
        <button class="primary" disabled={busy || !password}>
          {U.login.submit}
        </button>
      </form>
    </main>
  );
}

const NAV: { href: string; label: string; icon: string }[] = [
  { href: "/", label: U.nav.home, icon: "◎" },
  { href: "/log", label: U.nav.log, icon: "◆" },
  { href: "/board", label: U.nav.board, icon: "▤" },
  { href: "/history", label: U.nav.history, icon: "↺" },
  { href: "/settings", label: U.nav.settings, icon: "⚙" },
];

type ListMode = "log" | "board";

function App() {
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  const path = usePath();
  // クエストの内容を開いたとき、左の一覧をログと Quest Board のどちらにするか（最後に開いていた方）
  const mode = useRef<ListMode>("log");
  useEffect(() => {
    get("/api/settings")
      .then(() => setAuth("in"))
      .catch((e) => setAuth(e instanceof ApiError && e.status === 401 ? "out" : "in"));
    const out = () => setAuth("out");
    window.addEventListener("cq:unauthorized", out);
    return () => window.removeEventListener("cq:unauthorized", out);
  }, []);

  if (auth === "checking") return <div class="empty muted">{U.loading}</div>;
  if (auth === "out") {
    return (
      <>
        <Login onDone={() => setAuth("in")} />
        <Toasts />
      </>
    );
  }
  const url = new URL(path, location.origin);
  const p = url.pathname;
  if (p === "/log") mode.current = "log";
  if (p === "/board") mode.current = "board";
  const questId = p.startsWith("/quest/") ? p.slice("/quest/".length) : null;
  const current = questId ? `/${mode.current}` : p;
  const close = () => navigate("/");

  // ホーム（HUD）は常に下にあり、他の画面はその上にウィンドウとして重ねて開く
  let overlay = null;
  if (questId || p === "/log" || p === "/board") overlay = <QuestWindow mode={mode.current} questId={questId} onClose={close} />;
  else if (p === "/history")
    overlay = (
      <Window title={U.history.title} onClose={close}>
        <History questId={url.searchParams.get("quest_id")} />
      </Window>
    );
  else if (p === "/settings")
    overlay = (
      <Window title={U.settings.title} onClose={close}>
        <Settings />
      </Window>
    );

  return (
    <div class="shell">
      <nav class="nav">
        <span class="brand">{M.appName}</span>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} class={`nav-item ${current === n.href ? "on" : ""}`}>
            <span class="nav-icon" aria-hidden="true">
              {n.icon}
            </span>
            <span>{n.label}</span>
          </Link>
        ))}
      </nav>
      <main class="content">
        <Home />
      </main>
      {overlay}
      <Toasts />
    </div>
  );
}

render(<App />, document.getElementById("app")!);
