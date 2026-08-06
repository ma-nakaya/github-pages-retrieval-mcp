# GitHub Pages Retrieval MCP

GitHub 認証・SAML・MFA が必要な Private GitHub Pages を、認証済みの専用ブラウザプロファイル経由で取得するローカル stdio MCP サーバーです。取得元はレンダリング済みの Pages サイトだけに限定し、ソースリポジトリや GitHub API は利用しません。

Claude Code と GitHub Copilot CLI 向けの Agent Plugin として配布します。MCP 設定と `github-pages-retrieval` スキルを同梱し、どちらのクライアントでも同じローカル stdio プロセスを起動します。

## 提供する機能

- Pages ソースごとの専用・永続ブラウザプロファイル
- GitHub、SAML、MFA に対する明示的な対話認証
- Playwright による許可済み Pages オリジンだけの取得
- Cookie や認証情報を MCP に渡さないローカル認証状態管理
- DOMリンク巡回によるサイト構成の自動検出と差分更新
- SQLite FTS5 trigram による多言語の見出し単位検索
- 検索スニペットと節単位取得によるトークン量の抑制
- ユーザー指定URLからの初回ソース設定

## 単体で使う場合の準備

1. Node.js 22.5 以降をインストールし、`npm install` を実行します。
2. リポジトリ直下の `npm start` を、ローカル stdio MCP サーバーの起動コマンドとして登録します。
3. MCPの `list_pages_sources` を呼び出し、未設定ならユーザーから対象サイトURLを受け取って `configure_pages_source` で保存します。`config.example.json` から手動作成する方法も利用できます。

## プラグインとしての導入

初回起動時に依存パッケージが未導入なら、プラグインが `npm ci` を自動実行します。さらに、Playwright 用 Chromium が未導入なら自動でダウンロードしてから MCP サーバーを起動します。Node.js パッケージは `package-lock.json` に固定された依存関係だけを導入します。

### Claude Code

```sh
/plugin marketplace add ma-nakaya/github-pages-retrieval-mcp
/plugin install github-pages-retrieval@github-pages-retrieval-marketplace
```

Claude Code は `CLAUDE_PLUGIN_DATA` を通じてプライベートな永続データディレクトリを提供します。初回利用時は同梱スキルがサイトURLを確認し、そこへ `config.local.json` と専用ブラウザプロファイルを作成します。

### GitHub Copilot CLI

```sh
copilot plugin marketplace add ma-nakaya/github-pages-retrieval-mcp
copilot plugin install github-pages-retrieval@github-pages-retrieval-marketplace
```

プラグイン更新後もブラウザ状態を維持するには、Copilot の MCP サーバー環境変数 `GPR_PLUGIN_DATA` に非公開のローカルディレクトリを設定します。初回利用時はサイトURLから設定を自動作成します。データディレクトリ未指定時は、インストール済みプラグインディレクトリ内の `.data/` を使用します。

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

1. `list_pages_sources` を呼び出します。ソースがなければユーザーに正確なPagesサイトURLを質問し、回答後に `configure_pages_source` を呼び出します。
2. 対象ソースに `begin_source_reauth` を呼び出します。設定済みの Pages URL を表示したローカルブラウザが開きます。
3. ブラウザで GitHub、SAML、MFA を完了します。サーバーがパスワードや MFA コードを自動操作・受信することはありません。
4. 完了後に `validate_source_auth` を呼び出します。保護された Pages URL を検証し、`ready` または `auth_required` と日時だけを保存します。
5. 許可済み Pages URL に対して索引・検索ツールを使用します。

`configure_pages_source` はHTTPS URLから正確なオリジンだけを許可し、ソースIDと専用プロファイルパスを生成します。同一オリジンが登録済みなら既存ソースを返し、既存設定を置換しません。壊れた設定ファイルも自動上書きせず、修正が必要なエラーとして返します。

認証の有効期限が切れた場合、`fetch_pages_content` は `auth_required` を記録します。同じ明示的な認証フローをもう一度開始してください。

## ローカル索引と検索

認証が `ready` になった後、次の順序で使用します。

1. `refresh_pages_index` で並列バックグラウンド索引更新を開始します。ツールはすぐにジョブ情報を返します。既定の `concurrency` は12で、端末負荷に応じて1〜32に調整できます。
2. `get_pages_index` で `refresh.status` が `completed` または `failed` になるまで進捗を確認し、言語別件数やURL一覧を取得します。通常は小さい `limit`、`locale`、`pathContains` を指定します。
3. `search_pages_index` で必要なコンポーネント、API、設定を検索します。結果は上位のURL、見出し、短いスニペットだけです。`locale` は `all`、`default`、`en`、`ja`、または検出済みの言語コードを指定できます。
4. `fetch_indexed_section` に検索結果のURLと見出しを渡し、必要な節だけ取得します。同名見出しがある場合は `heading` に検索結果の `anchor` を渡します。

索引は `stateDir/pages-index.sqlite` に逐次保存されます。再実行時は内容ハッシュで追加・変更・未変更を判定し、巡回が最後まで成功した場合だけサイトから消えたページを削除します。sitemap に依存せず、現在のナビゲーションリンクから構成を再検出します。MCPクライアントの通常のリクエストタイムアウトを避けるため、長い巡回はバックグラウンドで実行します。

コンポーネントガイド（438ページ）では、認証済みSPA遷移と12並列巡回により約30〜50秒で索引を更新できました（同じ環境の逐次巡回は約5分半）。所要時間は端末性能、ネットワーク、認証サービスの応答によって変わります。

初回またはサイト更新時だけ `refresh_pages_index` を実行し、通常の質問では `search_pages_index` → `fetch_indexed_section` を使うことで、モデルへ渡す本文量を抑えられます。`locale: all` は全言語横断、`locale: default` は接尾辞なしの標準言語版を意味します。

## セキュリティ境界

- 日常利用のブラウザプロファイルは使わないでください。設定するプロファイルディレクトリには認証情報が含まれます。
- `config.local.json`、ブラウザプロファイル、SQLite索引を含む `.data/` は非公開で管理してください。どちらも Git の追跡対象外です。
- `allowedOrigins` に GitHub リポジトリ URL を設定しないでください。MCP は設定済みの Pages オリジンだけを受け付けます。
- 巡回対象は設定済み Pages オリジン内のHTMLページだけです。外部リンク、スクリプト、画像、PDFなどは索引しません。
- 現在はローカル全文検索です。外部の埋め込みAPIやベクトルDBへ本文を送信しません。
