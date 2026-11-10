// MCPサーバー（16操作）。操作の中身は core/ にあり、ここは入口だけ。
// 「誰が」は自己申告ではなく、この入口を通ったこと自体で ai と記録する。

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env as globalEnv } from "cloudflare:workers";
import { makeCtx, resolveRun } from "../core/context";
import { ensureDay } from "../core/daily";
import { acknowledgeInputs, runOp } from "../core/ops";
import { MCP_OPS, schemas, type OpName } from "../core/schemas";
import { OpError, type Ctx } from "../core/store";
import { history, overview, questDetail, runs, search } from "../core/views";
import type { Env } from "../env";
import { M } from "../shared/messages";
import { MCP_INSTRUCTIONS } from "./instructions";

type McpOp = (typeof MCP_OPS)[number];

const DESCRIPTIONS: Record<McpOp, string> = {
  get_overview:
    "全体の概要を読む。未整理の入力、今日のデイリー、受注中・保留のクエスト（現在の目的・期限・最終更新つき）、報告待ち、止まっているもの、今日と近日の予定、承認待ち・最近却下された提案、繰り返しの定義。最初に必ず読む",
  get_quest: "1つのクエストの全情報（タスク、ジャーナル、前提クエスト、紐づく予定、そのクエストへの提案）を読む",
  search: "クエスト・タスク・予定を条件で探す（状態、種類、期限、依頼主、必要な環境、最終更新、繰り越し回数、キーワード）",
  create_quest:
    "クエストを作る。完了条件・最初のタスク群・置き場所（受注中かQuest Board）を同時に指定できる。期限が近い・やると言い切ったものは受注中、「いつか」程度のものはQuest Boardに置く",
  update_quest: "クエストの完了条件・期限・場所・依頼主・必要な環境・紐づく予定・前提クエスト・トラッカー表示を変える。タイトルは変えられない",
  set_quest_status: "クエストを受注／保留／破棄／Quest Boardへ戻す。理由が必須。完了にはできない（完了は利用者だけが行う）",
  append_journal: "クエストのジャーナル（経緯の記録）に追記する。後から読んで再開できるよう、決まったこと・分かったことを書く",
  add_tasks: "タスクをまとめて追加する。追加先はクエスト（quest_id）か、デイリーの日付（daily_date）",
  update_task: "タスクのタイトル・依頼主・場所・期限・必要な環境・紐づく予定を変える",
  set_task_status: "タスクを完了／やめた／未完了に戻す。完了は利用者が終わったと報告したときだけ",
  move_tasks: "タスクの並べ替え、別クエストへの移動、デイリーの日付への予約",
  set_recurring: "繰り返しの定義（デイリーに毎回出すタスクのひな形）を作成・変更・停止する",
  get_history: "変更履歴を読む（クエスト単位・AIの実行単位・期間で絞り込み）",
  undo: "変更1件、またはAIの1回の実行をまとめて取り消す",
  propose:
    "フォローアップの提案を出す（やる／やらない／止まっている）。利用者が画面で承認するとシステムが action を実行する。クエストの完了は提案できない。同じ提案が承認待ち・最近却下済みならエラーになる",
  withdraw_proposal: "状況が変わって不要になった承認待ちの提案を取り下げる",
};

const READ_ONLY = new Set<McpOp>(["get_quest", "search", "get_history"]);

async function execute(env: Env, name: McpOp, args: unknown): Promise<unknown> {
  const ctx: Ctx = await makeCtx(env, "ai");
  await ensureDay(ctx);
  ctx.runId = await resolveRun(ctx.db, ctx.now);
  const parsed = schemas[name].parse(args ?? {});
  switch (name) {
    case "get_overview": {
      const a = parsed as { acknowledge_input_ids?: string[] };
      if (a.acknowledge_input_ids?.length) await acknowledgeInputs(ctx, a.acknowledge_input_ids);
      return overview(ctx);
    }
    case "get_quest":
      return questDetail(ctx, (parsed as { quest_id: string }).quest_id);
    case "search":
      return search(ctx, parsed as Parameters<typeof search>[1]);
    case "get_history": {
      const a = parsed as Parameters<typeof history>[1];
      const result = await history(ctx, a);
      return a.quest_id || a.run_id ? result : { ...result, recent_runs: (await runs(ctx.db, 10, 0)).runs };
    }
    default:
      return runOp(name as OpName, parsed, ctx);
  }
}

function createServer(): McpServer {
  const env = globalEnv as unknown as Env;
  const server = new McpServer({ name: "conquest", version: "0.1.0" }, { instructions: MCP_INSTRUCTIONS });
  for (const name of MCP_OPS) {
    server.registerTool(
      name,
      {
        description: DESCRIPTIONS[name],
        inputSchema: schemas[name],
        annotations: { readOnlyHint: READ_ONLY.has(name), destructiveHint: false, openWorldHint: false },
      },
      async (args: unknown) => {
        try {
          const result = await execute(env, name, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (e) {
          if (!(e instanceof OpError)) console.error("mcp tool error", name, e);
          const message = e instanceof OpError ? e.message : M.error.unknown;
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }
  return server;
}

export const mcpHandler = createMcpHandler(createServer);
