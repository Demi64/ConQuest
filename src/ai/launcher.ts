// AIを起動する部分。ここだけ差し替えれば、別の起動方法（Claude API の直接呼び出しなど）に替えられる。

import type { Env } from "../env";

export interface LaunchResult {
  ok: boolean;
  /** 混雑などで、少し待ってからやり直す価値があるか */
  retryable?: boolean;
  detail?: string;
}

export interface AiLauncher {
  /** 起動先が設定済みか */
  readonly configured: boolean;
  launch(): Promise<LaunchResult>;
}

/**
 * Claude Code の「スケジュール済みタスク」のAPIトリガーを呼ぶ。
 * 入力の本文は送らない（合図だけ送り、AIは MCP の get_overview で入力を読む）。
 * https://code.claude.com/docs/en/routines
 */
class RoutineLauncher implements AiLauncher {
  constructor(private fireUrl: string | undefined, private token: string | undefined) {}

  get configured(): boolean {
    return !!this.fireUrl && !!this.token && this.fireUrl.startsWith("https://api.anthropic.com/");
  }

  async launch(): Promise<LaunchResult> {
    if (!this.configured) return { ok: false, detail: "not configured" };
    const res = await fetch(this.fireUrl!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "ConQuest: there are unprocessed inputs or rejected proposals." }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.text()).slice(0, 300);
    return { ok: false, retryable: res.status === 429 || res.status >= 500, detail: `HTTP ${res.status} ${body}` };
  }
}

export function createLauncher(env: Env): AiLauncher {
  return new RoutineLauncher(env.ROUTINE_FIRE_URL, env.ROUTINE_TOKEN);
}
