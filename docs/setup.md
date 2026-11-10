# 使い始めるまでの手順

ComQuest を自分の Cloudflare アカウントに置いて使い始めるまでの手順。上から順に進める。
1〜3 はコマンドを打つ作業（Claude Code に頼める）、4〜7 はブラウザでの作業。

必要なもの：Node.js 22 以上、Cloudflare のアカウント、Claude の有料プラン。

## 1. Cloudflare にログインする

```
npx wrangler login
```

ブラウザが開くので「Allow（許可）」を押す。

（APIトークンを使う場合：Cloudflare の画面右上の人型アイコン → My Profile → API Tokens → Create Token →「Edit Cloudflare Workers」のテンプレートを選び、D1 の Edit 権限を足して作成。表示されたトークンを `CLOUDFLARE_API_TOKEN` という環境変数に入れてからコマンドを実行する。）

## 2. 置く（デプロイ）

```
npm install
npx wrangler deploy
npx wrangler d1 migrations apply DB --remote
```

- 初回はデータベースなどの置き場所が自動で作られる。
- 終わると `https://comquest.<自分のサブドメイン>.workers.dev` というアドレスが表示される。これが ComQuest のアドレス。

## 3. パスワードなどを登録する

```
npx wrangler secret put OWNER_PASSWORD     # 画面のログインと、Claude からの接続許可に使うパスワード（長めのもの）
npx wrangler secret put ENCRYPTION_KEY     # 適当な長い文字列（例：openssl rand -base64 32 の出力）。覚えなくてよい
```

アドレスをブラウザで開き、パスワードでログインできれば完了。スマホでは共有メニューの「ホーム画面に追加」でアプリのように使える。

## 4. claude.ai にコネクタとして追加する

1. claude.ai の 設定 → コネクタ →「カスタムコネクタを追加」
2. 名前：`ComQuest`、URL：`https://comquest.<自分のサブドメイン>.workers.dev/mcp`
3. 「接続」を押すと ComQuest の許可画面が開く。パスワードを入れて「許可する」。

これで Claude のチャット（スマホの音声入力も）から「〜をやることに追加して」「今日やること教えて」と話しかけられる。

## 5. スケジュール済みタスクを作る（アプリの入力欄からAIを動かす）

1. https://claude.ai/code/routines を開き、新しいタスクを作る。
2. プロンプトに `prompts/routine.md` の「プロンプト本文」より下を全部貼る。
3. トリガーで **API** を選ぶ。作成すると **トークンが1度だけ表示される**のでコピーする。あわせて **Fire URL** もコピーする。
4. 同じタスクにトリガーをもう1つ足し、**スケジュール**（毎日。おすすめは朝）を選ぶ。これが1日1回の棚卸しになる。
5. コネクタは **ComQuest**（と、使うなら Googleカレンダー）だけ残し、他は外す。リポジトリは選ばなくてよい。
6. コピーした2つをサーバーに登録する。

```
npx wrangler secret put ROUTINE_FIRE_URL   # Fire URL（https://api.anthropic.com/v1/claude_code/routines/…/fire）
npx wrangler secret put ROUTINE_TOKEN      # トークン
```

設定画面の「AIの自動起動」が「設定済み」になれば完了。入力欄から送ると、約30秒後にAIが整理を始める。

## 6. Googleカレンダーの読み取りを許可する

Google Cloud で「このアプリがカレンダーを読んでよい」という設定を作る。

1. https://console.cloud.google.com/ で新しいプロジェクトを作る（名前は何でもよい）。
2. 「APIとサービス」→「ライブラリ」で **Google Calendar API** を探して「有効にする」。
3. 「APIとサービス」→「OAuth 同意画面」（Google Auth Platform）を設定する。
   - 対象：**外部**。アプリ名とメールアドレスを入れる。
   - 「対象」のテストユーザーに自分の Google アカウントを追加する。
   - 公開ステータスを **「本番環境」** にする（「テスト」のままだと7日ごとに接続が切れる）。自分しか使わないので審査は不要。接続時に「このアプリは確認されていません」と出たら「詳細」→「移動」で進む。
4. 「クライアント」→「クライアントを作成」→ 種類は **ウェブ アプリケーション**。
   - 承認済みのリダイレクト URI：`https://comquest.<自分のサブドメイン>.workers.dev/google/callback`
5. 表示された **クライアントID** と **クライアント シークレット** を登録する。

```
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

6. ComQuest の 設定 → Googleカレンダー →「接続する」。Google の画面で許可する。

取り込むのは、Googleカレンダーの画面でチェックを入れて表示しているカレンダー。15分ごとに読み直す。ComQuest から予定を書き換えることはない。

## 7. 更新するとき

```
git pull
npm install
npx wrangler deploy
npx wrangler d1 migrations apply DB --remote
```

## 手元で動かす（開発用）

```
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npm run dev                     # http://localhost:8787
node scripts/smoke.mjs          # 別のターミナルで。通しの動作確認
```
