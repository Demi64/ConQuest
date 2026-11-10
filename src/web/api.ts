// 画面用のAPIと、MCPの接続許可（/authorize）、Googleカレンダーの接続（/google/*）。
// ここを通る書き込みは全て「人の操作」として記録する。

import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { aiState, requestAi } from "../ai/queue";
import { calendarStatus, connectUrl, disconnect, finishConnect, googleReady, syncCalendar } from "../calendar/google";
import { makeCtx } from "../core/context";
import { ensureDay } from "../core/daily";
import { isWriteOp, runOp } from "../core/ops";
import { schemas } from "../core/schemas";
import { OpError } from "../core/store";
import { addDays } from "../core/time";
import { eventsBetween, history, homeView, questDetail, recurringList, runs, search } from "../core/views";
import type { Env } from "../env";
import { M } from "../shared/messages";
import { checkPassword, createSession, destroySession, hasSession } from "./auth";
import { authorizePage, messagePage } from "./pages";

type App = { Bindings: Env };
const app = new Hono<App>();

app.onError((e, c) => {
  if (e instanceof OpError) return c.json({ error: e.message }, e.status as 400);
  console.error("api error", e);
  return c.json({ error: M.error.unknown }, 500);
});

// ---------- 画面のAPI ----------

const api = new Hono<App>();

// 他のサイトからの書き込みを防ぐ：POST は同じオリジンからだけ受ける
api.use("*", async (c, next) => {
  if (c.req.method !== "GET") {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: M.error.unauthorized }, 403);
  }
  await next();
});

api.post("/login", async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  await checkPassword(c.env, String(body.password ?? ""));
  c.header("Set-Cookie", await createSession(c.env));
  return c.json({ ok: true });
});

api.post("/logout", async (c) => {
  c.header("Set-Cookie", await destroySession(c.env, c.req.raw));
  return c.json({ ok: true });
});

api.use("*", async (c, next) => {
  if (!(await hasSession(c.env, c.req.raw))) return c.json({ error: M.error.unauthorized }, 401);
  await next();
});

async function humanCtx(env: Env) {
  const ctx = await makeCtx(env, "human");
  await ensureDay(ctx);
  return ctx;
}

api.get("/home", async (c) => {
  const ctx = await humanCtx(c.env);
  const cal = await calendarStatus(c.env);
  return c.json(await homeView(ctx, await aiState(c.env), cal.connected));
});

api.get("/quests", async (c) => {
  const ctx = await humanCtx(c.env);
  const q = c.req.query();
  const args = schemas.search.parse({
    target: "quests",
    keyword: q.keyword || undefined,
    status: q.status ? q.status.split(",") : undefined,
    kind: q.kind || undefined,
    limit: q.limit ? Number(q.limit) : 30,
    offset: q.offset ? Number(q.offset) : 0,
  });
  return c.json(await search(ctx, args));
});

api.get("/quests/:id", async (c) => c.json(await questDetail(await humanCtx(c.env), c.req.param("id"))));

api.get("/events", async (c) => {
  const ctx = await humanCtx(c.env);
  const from = c.req.query("from") ?? ctx.today;
  return c.json({ events: await eventsBetween(ctx, from, c.req.query("to") ?? addDays(from, 30)) });
});

api.get("/history", async (c) => {
  const ctx = await humanCtx(c.env);
  const q = c.req.query();
  return c.json(
    await history(
      ctx,
      schemas.get_history.parse({
        quest_id: q.quest_id || undefined,
        run_id: q.run_id || undefined,
        limit: 30,
        offset: q.offset ? Number(q.offset) : 0,
      }),
    ),
  );
});

api.get("/runs", async (c) => c.json(await runs(c.env.DB, 20, Number(c.req.query("offset") ?? 0))));

api.get("/settings", async (c) => {
  const ctx = await humanCtx(c.env);
  return c.json({
    settings: ctx.settings,
    recurring: await recurringList(ctx.db),
    calendar: await calendarStatus(c.env),
    ai: await aiState(c.env),
  });
});

/** 人が画面から行える操作。提案を出す・取り下げるのはAIの役目なので含めない */
const HUMAN_BLOCKED = new Set(["propose", "withdraw_proposal"]);

api.post("/op/:name", async (c) => {
  const name = c.req.param("name");
  if (!isWriteOp(name) || HUMAN_BLOCKED.has(name)) return c.json({ error: M.error.badRequest }, 404);
  const ctx = await humanCtx(c.env);
  const args = await c.req.json().catch(() => ({}));
  const result = await runOp(name, args, ctx);
  // AIを呼ぶきっかけ：アプリからの入力、提案の却下
  const rejected = name === "resolve_proposal" && (args as { decision?: string }).decision === "reject";
  if (name === "add_input" || rejected) c.executionCtx.waitUntil(requestAi(c.env));
  return c.json(result ?? { ok: true });
});

// 更新ボタン
api.post("/refresh", async (c) => {
  await requestAi(c.env);
  return c.json(await aiState(c.env));
});

api.post("/calendar/sync", async (c) => {
  const ctx = await humanCtx(c.env);
  await syncCalendar(c.env, ctx.settings.timezone);
  return c.json(await calendarStatus(c.env));
});

api.post("/calendar/disconnect", async (c) => {
  await disconnect(c.env);
  return c.json(await calendarStatus(c.env));
});

app.route("/api", api);

// ---------- Googleカレンダーの接続 ----------

app.get("/google/connect", async (c) => {
  if (!(await hasSession(c.env, c.req.raw))) return c.redirect("/");
  if (!googleReady(c.env)) return c.html(messagePage(M.ui.settings.calendarNotReady), 503);
  return c.redirect(await connectUrl(c.env, new URL(c.req.url).origin));
});

app.get("/google/callback", async (c) => {
  if (!(await hasSession(c.env, c.req.raw))) return c.redirect("/");
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.redirect("/settings");
  try {
    await finishConnect(c.env, new URL(c.req.url).origin, code, state);
  } catch (e) {
    console.error("google connect failed", e);
    return c.html(messagePage(M.error.unknown), 400);
  }
  const ctx = await makeCtx(c.env, "system");
  c.executionCtx.waitUntil(syncCalendar(c.env, ctx.settings.timezone));
  return c.redirect("/settings");
});

// ---------- MCPの接続許可 ----------
// claude.ai などのMCPクライアントが接続するときに開く画面。パスワードで本人を確かめ、許可したら接続用のトークンを発行する。

const SECURE_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function authorizationFailure(e: unknown): Response {
  if (e instanceof AuthorizationError) {
    if (e.redirectTo) return Response.redirect(e.redirectTo, 302);
    return new Response(e.description, { status: 400 });
  }
  throw e;
}

app.get("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const authRequest = await oauth.parseAuthRequest(c.req.raw);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    const page = authorizePage({
      clientName: details.clientName,
      clientDomain: details.clientDomain,
      redirectHost: details.redirectHost,
      handle: consent.handle,
      needPassword: !(await hasSession(c.env, c.req.raw)),
    });
    const headers = new Headers(consent.headers);
    headers.set("Content-Type", "text/html; charset=utf-8");
    for (const [k, v] of Object.entries(SECURE_HEADERS)) headers.set(k, v);
    return new Response(String(await page), { headers });
  } catch (e) {
    return authorizationFailure(e);
  }
});

app.post("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  const form = await c.req.formData();
  const handle = String(form.get("handle") ?? "");
  try {
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (!(await hasSession(c.env, c.req.raw))) {
      try {
        await checkPassword(c.env, String(form.get("password") ?? ""));
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        // 許可の手続きは使い切りなので、クライアント側から接続をやり直してもらう
        return c.html(messagePage(e.message), e.status as 401);
      }
    }
    const approved = await oauth.approveConsent(c.req.raw, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      metadata: {},
      scope: approved.request.scope,
      props: { userId: "owner" },
    });
    const headers = new Headers(approved.headers);
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return authorizationFailure(e);
  }
});

// それ以外は画面（静的ファイル）
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
