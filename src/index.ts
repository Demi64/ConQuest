// 入口。全体を OAuthProvider で包み、/mcp だけを接続用トークン必須にする。それ以外（画面・API）は web/api.ts へ。

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { syncCalendar } from "./calendar/google";
import { makeCtx } from "./core/context";
import { ensureDay } from "./core/daily";
import type { Env } from "./env";
import { mcpHandler } from "./mcp/server";
import app from "./web/api";

export { AiQueue } from "./ai/queue";

// 接続用トークンは「このサーバーの /mcp 向け」として発行される。
// デプロイ先のアドレスを設定ファイルに書かずに済むよう、届いたリクエストのアドレスから組み立てる。
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: {
        fetch(request: Request, env: Env, ctx: ExecutionContext) {
          return mcpHandler(request, env, ctx);
        },
      },
      defaultHandler: { fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      resourceMetadata: { resource: `${origin}/mcp` },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },

  // 15分ごと：日付が変わっていればデイリーを切り替え、カレンダーの写しを取り込む
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const ctx = await makeCtx(env, "system");
    await ensureDay(ctx);
    await syncCalendar(env, ctx.settings.timezone);
  },
} satisfies ExportedHandler<Env>;
