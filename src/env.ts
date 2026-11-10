import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  AI_QUEUE: DurableObjectNamespace;
  OAUTH_PROVIDER: OAuthHelpers;

  // secrets（wrangler secret put で登録する。docs/setup.md 参照）
  OWNER_PASSWORD?: string;
  ENCRYPTION_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ROUTINE_FIRE_URL?: string;
  ROUTINE_TOKEN?: string;
}
