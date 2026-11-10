// サーバーが直接返す小さなページ（MCPの接続許可）。hono の html で値を必ずエスケープする。

import { html } from "hono/html";
import { M } from "../shared/messages";

const U = M.ui.authorize;

export function authorizePage(o: {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  handle: string;
  needPassword: boolean;
  error?: string;
}) {
  return html`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${U.title} - ${M.appName}</title>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body>
    <main class="auth-card">
      <h1>${U.title}</h1>
      <p>${U.lead(o.clientDomain ? `${o.clientName}（${o.clientDomain}）` : o.clientName)}</p>
      <p class="muted">${U.redirect}：${o.redirectHost}</p>
      ${o.error ? html`<p class="error">${o.error}</p>` : ""}
      <form method="post" action="/authorize">
        <input type="hidden" name="handle" value="${o.handle}" />
        ${o.needPassword
          ? html`<label>${M.ui.login.password}<input type="password" name="password" autocomplete="current-password" required autofocus /></label>`
          : ""}
        <div class="row">
          <button class="primary" name="decision" value="approve">${U.approve}</button>
          <button name="decision" value="deny" formnovalidate>${U.deny}</button>
        </div>
      </form>
    </main>
  </body>
</html>`;
}

export function messagePage(message: string) {
  return html`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${M.appName}</title>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body>
    <main class="auth-card">
      <p>${message}</p>
      <p><a href="/">${M.appName}</a></p>
    </main>
  </body>
</html>`;
}
