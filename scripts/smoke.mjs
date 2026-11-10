// 動作確認用：ローカルで動かしたサーバー（npm run dev）に対して、画面のAPIとMCPをひと通り呼ぶ。
// 使い方：  node scripts/smoke.mjs [http://localhost:8787] [パスワード] [--readonly]
// --readonly を付けると、ログインと MCP の接続・読み出しだけを確かめる（データを書かない。本番の確認用）。
// パスワードは環境変数 CQ_PASSWORD でも渡せる。
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const READONLY = process.argv.includes("--readonly");
const BASE = argv[0] ?? "http://localhost:8787";
const PASSWORD = process.env.CQ_PASSWORD ?? argv[1] ?? "devpass";
let cookie = "";
let failures = 0;

function check(name, cond, detail) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`  NG  ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600));
  }
}

async function web(path, body) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: BASE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
const op = (name, args) => web(`/api/op/${name}`, args);

// ---- MCPの接続（OAuth：クライアント登録 → 許可 → トークン） ----
async function connectMcp() {
  const redirect = "http://localhost:9999/callback";
  const reg = await (
    await fetch(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "smoke test", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    })
  ).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: reg.client_id, redirect_uri: redirect, state: "s1",
    code_challenge: challenge, code_challenge_method: "S256", resource: `${BASE}/mcp`,
  });
  const page = await fetch(`${BASE}/authorize?${q}`);
  const html = await page.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  check("許可画面が出る", page.status === 200 && !!handle && html.includes("smoke test"), html.slice(0, 300));
  const consentCookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  const bad = await fetch(`${BASE}/authorize`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: consentCookie, Origin: BASE },
    body: new URLSearchParams({ handle, decision: "approve", password: "wrong" }),
  });
  check("パスワード違いは拒否", bad.status === 401, bad.status);

  // やり直し（許可の手続きは使い切り）
  const page2 = await fetch(`${BASE}/authorize?${q}`);
  const handle2 = (await page2.text()).match(/name="handle" value="([^"]+)"/)?.[1];
  const cookie2 = (page2.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const ok = await fetch(`${BASE}/authorize`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie2, Origin: BASE },
    body: new URLSearchParams({ handle: handle2, decision: "approve", password: PASSWORD }),
  });
  const code = new URL(ok.headers.get("location") ?? "http://x").searchParams.get("code");
  check("許可すると認可コードが返る", ok.status === 302 && !!code, [ok.status, ok.headers.get("location")]);
  const token = await (
    await fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.client_id,
        code_verifier: verifier, resource: `${BASE}/mcp`,
      }),
    })
  ).json();
  check("トークンが発行される", !!token.access_token, token);

  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
    }),
  );
  return client;
}

async function main() {
  console.log("== 画面のログイン");
  check("未ログインは401", (await web("/api/home")).status === 401);
  check("ログイン", (await web("/api/login", { password: PASSWORD })).status === 200);

  if (READONLY) {
    const home = await web("/api/home");
    check("ホームが読める", home.status === 200 && !!home.body?.today, home);
    const mcp = await connectMcp();
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    check("操作は16個", tools.length === 16, tools);
    const r = await mcp.callTool({ name: "get_overview", arguments: {} });
    check("概要が読める", !r.isError && JSON.parse(r.content[0].text).today === home.body.today, r);
    await mcp.close();
    console.log(failures ? `\n${failures} 件失敗` : "\n全て成功");
    process.exit(failures ? 1 : 0);
  }

  const input = await op("add_input", { body: "来週の金曜までに見積書を作って送る。あと毎日ゴミ出し" });
  check("入力を保存", !!input.body?.input_id, input);

  console.log("== MCP");
  const noAuth = await fetch(`${BASE}/mcp`, { method: "POST" });
  check("トークンなしのMCPは401", noAuth.status === 401);
  const mcp = await connectMcp();
  const call = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    return r.isError ? { error: text } : JSON.parse(text);
  };

  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  check("操作は16個", tools.length === 16, tools);
  check("完了の操作はない", !tools.some((t) => t.includes("complete")), tools);

  const ov = await call("get_overview");
  check("概要に未整理の入力が出る", ov.unprocessed_inputs?.some((i) => i.id === input.body.input_id), ov);

  const quest = await call("create_quest", {
    title: "見積書を送る", completion_condition: "見積書を送付し、受領の返事をもらう", due: "2026-12-31",
    requester: "取引先A", required_env: "PC",
    tasks: [{ title: "見積書を作る" }, { title: "メールで送る", required_env: "PC" }],
    source_input_ids: [input.body.input_id],
  });
  check("クエスト作成", !!quest.quest_id && quest.task_ids?.length === 2, quest);

  const rec = await call("set_recurring", { title: "ゴミ出し", rule_type: "daily" });
  check("繰り返しの定義", !!rec.recurring_id, rec);
  const daily = await call("add_tasks", { daily_date: ov.today, tasks: [{ title: "牛乳を買う" }] });
  check("デイリーにタスク追加", daily.task_ids?.length === 1, daily);

  const noComplete = await call("set_quest_status", { quest_id: quest.quest_id, status: "completed", reason: "x" });
  check("AIは完了にできない", !!noComplete.error || noComplete.status !== "completed", noComplete);
  const noProposeComplete = await call("propose", {
    kind: "do", target_type: "quest", target_id: quest.quest_id, reason: "x",
    action: { op: "set_quest_status", args: { quest_id: quest.quest_id, status: "completed", reason: "x" } },
  });
  check("完了の提案は出せない", !!noProposeComplete.error, noProposeComplete);

  const proposal = await call("propose", {
    kind: "dont", target_type: "quest", target_id: quest.quest_id, reason: "先方の返事待ちのため",
    action: { op: "set_quest_status", args: { quest_id: quest.quest_id, status: "on_hold", reason: "先方の返事待ち", resume_on: "2026-12-01" } },
  });
  check("提案を出す", proposal.status === "pending", proposal);
  const dup = await call("propose", {
    kind: "dont", target_type: "quest", target_id: quest.quest_id, reason: "もう一度",
    action: { op: "set_quest_status", args: { resume_on: "2026-12-01", quest_id: quest.quest_id, status: "on_hold", reason: "先方の返事待ち" } },
  });
  check("同じ提案は重ねて出せない", !!dup.error, dup);

  const found = await call("search", { target: "tasks", keyword: "見積" });
  check("タスク検索（期限・依頼主はクエストから引き継ぐ）", found.tasks?.[0]?.due === "2026-12-31" && found.tasks[0].requester === "取引先A", found);
  const detail = await call("get_quest", { quest_id: quest.quest_id });
  check("クエスト詳細", detail.tasks?.length === 2 && detail.current_objective?.title === "見積書を作る" && detail.proposals?.length === 1, detail);

  console.log("== 画面");
  let home = (await web("/api/home")).body;
  check("入力が処理済みになった", home.pending_inputs.length === 0, home.pending_inputs);
  check("トラッカーに出る", home.tracker.some((q) => q.id === quest.quest_id), home.tracker);
  const titles = home.daily.tasks.map((t) => t.title);
  check("今日のデイリーに繰り返しと追加分", titles.includes("ゴミ出し") && titles.includes("牛乳を買う"), titles);
  check("提案が出る", home.proposals.length === 1 && home.proposals[0].action_text.includes("保留"), home.proposals);

  const blocked = await op("propose", {});
  check("人は提案を出せない（AIの役目）", blocked.status === 404, blocked);

  const approved = await op("resolve_proposal", { proposal_id: proposal.proposal_id, decision: "approve" });
  check("提案を承認", approved.body?.status === "approved", approved);
  let q = (await web(`/api/quests/${quest.quest_id}`)).body;
  check("承認で保留になる", q.status === "on_hold" && q.resume_on === "2026-12-01" && q.journal.length === 1, q);

  await op("set_quest_status", { quest_id: quest.quest_id, status: "active", reason: "返事が来た" });
  for (const id of quest.task_ids) await op("set_task_status", { task_id: id, status: "done" });
  home = (await web("/api/home")).body;
  const tracked = home.tracker.find((x) => x.id === quest.quest_id);
  check("タスクが全部終わると報告待ち", tracked?.awaiting_report === true && home.tracker[0].id === quest.quest_id, tracked);
  const stalled = await call("propose", {
    kind: "stalled", target_type: "quest", target_id: quest.quest_id, reason: "x",
    action: { op: "append_journal", args: { quest_id: quest.quest_id, body: "x" } },
  });
  check("報告待ちは急かせない", !!stalled.error, stalled);

  const done = await op("complete_quest", { quest_id: quest.quest_id });
  check("人が完了にする", done.body?.status === "completed", done);

  console.log("== 履歴と取り消し");
  const hist = (await web(`/api/history?quest_id=${quest.quest_id}`)).body;
  check("履歴に誰の操作か残る", hist.operations.some((o) => o.actor === "ai") && hist.operations.some((o) => o.actor === "human"), hist.operations.map((o) => [o.actor, o.op]));
  const completeOp = hist.operations.find((o) => o.op === "complete_quest");
  const undone = await op("undo", { operation_id: completeOp.id });
  check("完了を取り消す", undone.body?.undone === 1, undone);
  q = (await web(`/api/quests/${quest.quest_id}`)).body;
  check("受注中に戻る", q.status === "active", q.status);

  const runList = (await web("/api/runs")).body;
  check("AIの実行が1件にまとまる", runList.runs.length === 1 && runList.runs[0].operations >= 3, runList);
  const undoRun = await op("undo", { run_id: runList.runs[0].id });
  check("AIの実行をまとめて取り消す", undoRun.body?.undone >= 3, undoRun);
  const gone = await web(`/api/quests/${quest.quest_id}`);
  check("作成が取り消されクエストが見えなくなる", gone.status === 404, gone);
  home = (await web("/api/home")).body;
  check("入力が未整理に戻る", home.pending_inputs.length === 1, home.pending_inputs);
  check("取り消しで繰り返しのタスクも消える", !home.daily.tasks.some((t) => t.title === "ゴミ出し"), home.daily.tasks);

  if (BASE.includes("localhost")) {
    console.log("== 日付の切り替え（ローカルのみ：データベースの日付を1日ずらして確かめる）");
    const again = await call("set_recurring", { title: "皿洗い", rule_type: "daily" });
    const t2 = await call("add_tasks", { daily_date: home.today, tasks: [{ title: "郵便を出す" }] });
    const yesterday = new Date(Date.parse(`${home.today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const sql = [
      `UPDATE quests SET daily_date = '${yesterday}' WHERE kind = 'daily' AND daily_date = '${home.today}'`,
      `UPDATE tasks SET generated_date = '${yesterday}' WHERE generated_date = '${home.today}'`,
      `UPDATE settings SET value = '${yesterday}' WHERE key = 'last_rollover_date'`,
    ].join("; ");
    execSync(`npx wrangler d1 execute DB --local --command "${sql}"`, { stdio: "ignore" });
    home = (await web("/api/home")).body;
    const carried = home.daily.tasks.find((t) => t.id === t2.task_ids[0]);
    check("未完了が翌日に繰り越され、回数が数えられる", carried?.carryover_count === 1, home.daily.tasks);
    const dishes = home.daily.tasks.filter((t) => t.title === "皿洗い");
    check("繰り越した繰り返しタスクは重ねて出さない", dishes.length === 1 && dishes[0].carryover_count === 1, dishes);
    await call("set_recurring", { recurring_id: again.recurring_id, active: false });
  }

  await mcp.close();
  console.log(failures ? `\n${failures} 件失敗` : "\n全て成功");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
