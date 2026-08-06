# GitHub Pages Retrieval MCP

GitHub 認証・SAML・MFA が必要な Private GitHub Pages を、認証済みの専用ブラウザプロファイル経由で取得するローカル stdio MCP サーバーです。取得元はレンダリング済みの Pages サイトだけに限定し、ソースリポジトリや GitHub API は利用しません。

Claude Code と GitHub Copilot CLI 向けの Agent Plugin として配布します。MCP 設定と `github-pages-retrieval` スキルを同梱し、どちらのクライアントでも同じローカル stdio プロセスを起動します。

## 提供する機能

- Pages ソースごとの専用・永続ブラウザプロファイル
- GitHub、SAML、MFA に対する明示的な対話認証
- Playwright による許可済み Pages オリジンだけの取得
- Cookie や認証情報を MCP に渡さないローカル認証状態管理

## 単体で使う場合の準備

1. Node.js 22 以降をインストールし、`npm install` を実行します。
2. `config.example.json` を `config.local.json` にコピーし、対象 URL とオリジンを設定します。
3. リポジトリ直下で `npm start` を実行します。
4. 起動コマンドをローカル stdio MCP サーバーとして登録します。

## プラグインとしての導入

有効化前に、プラグインディレクトリで一度だけ依存パッケージをインストールしてください。意図しない実行を避けるため、インストールスクリプトは自動実行しません。

### Claude Code

```sh
/plugin marketplace add ma-nakaya/github-pages-retrieval-mcp
/plugin install github-pages-retrieval@github-pages-retrieval-marketplace
```

Claude Code は `CLAUDE_PLUGIN_DATA` を通じてプライベートな永続データディレクトリを提供します。そこに `config.example.json` をもとに `config.local.json` を作成し、同梱スキルから認証を開始します。

### GitHub Copilot CLI

```sh
copilot plugin marketplace add ma-nakaya/github-pages-retrieval-mcp
copilot plugin install github-pages-retrieval@github-pages-retrieval-marketplace
```

プラグイン更新後もブラウザ状態を維持するには、Copilot の MCP サーバー環境変数 `GPR_PLUGIN_DATA` に非公開のローカルディレクトリを設定し、そこへ `config.example.json` をもとに `config.local.json` を作成します。未設定時は、インストール済みプラグインディレクトリ内の `.data/` を使用します。

対象はローカルで実行する Copilot CLI です。Copilot cloud agent と code review は GitHub ホスト環境で動作するため、ユーザーのローカルな GitHub／SAML／MFA 用ブラウザプロファイルを再利用できません。

IDE 上の GitHub Copilot では、インストール済みプラグインディレクトリの同じローカルコマンドを IDE の MCP 設定へ登録してください。同梱プラグインは現在 Copilot CLI で検証しています。

単体利用時の設定例:

```toml
[mcp_servers.github_pages_retrieval]
command = "npm"
args = ["start"]
cwd = "C:/path/to/github-pages-retrieval-mcp"
```

## 認証フロー

1. 対象ソースに `begin_source_reauth` を呼び出します。設定済みの Pages URL を表示したローカルブラウザが開きます。
2. ブラウザで GitHub、SAML、MFA を完了します。サーバーがパスワードや MFA コードを自動操作・受信することはありません。
3. 完了後に `validate_source_auth` を呼び出します。保護された Pages URL を検証し、`ready` または `auth_required` と日時だけを保存します。
4. 許可済み Pages URL に対して `fetch_pages_content` を使用します。

認証の有効期限が切れた場合、`fetch_pages_content` は `auth_required` を記録します。同じ明示的な認証フローをもう一度開始してください。

## セキュリティ境界

- 日常利用のブラウザプロファイルは使わないでください。設定するプロファイルディレクトリには認証情報が含まれます。
- `config.local.json` と `.data/` は非公開で管理してください。どちらも Git の追跡対象外です。
- `allowedOrigins` に GitHub リポジトリ URL を設定しないでください。MCP は設定済みの Pages オリジンだけを受け付けます。
- 初版は 1 ページの取得・返却のみです。クロール、チャンク化、ローカル全文検索・ベクトル検索は、実際の Pages ソースで検証した後に追加します。
