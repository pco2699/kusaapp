# Chrome extension — Habit Tracker Gauge

[kusaapp](../README.md)（everyday セルフホスト habit tracker）の **API クライアント** として動く Chrome 拡張機能。

Toolbar に「完了した habit の数を中心に、緑の円形ゲージ」を表示する。

## 仕様

- **Toolbar アイコン = 円形ゲージ**
  - 0% → 暗い緑の円（空のトラック）
  - 完了率に応じて、12時方向から時計回りに鮮やかな緑の弧が伸びる
  - 100% → 全部鮮やかな緑 / 60% → 60% だけ鮮やかな緑
- **バッジ = 今日完了した必須 habit の数**
  - `?` = 未設定、`!` = 接続エラー（橙）、数字 = 完了数
- **クリック → ポップアップ**（habit の追加・チェック・削除 + サーバー設定）
- **ゲージの換算対象**:`any_days`（any-of-weekday / 「どれでも」）を除いた
  今日やるべき habit（daily + `all_days` で今日が対象曜日）の完了率。
  `any_days` はリストには出るがゲージには換算しない。

## データの一元化

拡張機能自身はデータを保存しない。すべて kusaapp サーバーの API に問い合わせる:

- `GET /api/state` — habit 一覧 + 今日の完了状態（`done_now`）
- `POST /api/toggle` — チェックの切替
- `POST /api/habits` — 追加（`op:"create"`）・削除（`op:"delete"`）
- 認証は `Authorization: Bearer <token>`

サーバーURL と token はポップアップの「⚙ 設定」で入力し、`chrome.storage.local` に保存する
（拡張機能の設定のみ。habit データはサーバー側）。

## セットアップ

1. kusaapp サーバーを起動（`node server.mjs`）。拡張機能からの接続のため **CORS 有効**
   （`server.mjs` が `Access-Control-Allow-Origin` を返す）。
2. Chrome で `chrome://extensions` → デベロッパーモード ON →
   「パッケージ化されていない拡張機能を読み込む」→ この `chrome-extension/` フォルダを選択。
3. ツールバーアイコンをクリック → ⚙ 設定 → サーバーURL と token を入力 → 保存。

## ファイル構成

- `manifest.json` — MV3（module service worker + `host_permissions`）
- `background.js` — ゲージ描画（OffscreenCanvas）＋バッジ更新
- `common.js` — 設定・API 呼び出し・進捗計算（background / popup 共有）
- `popup.html` / `popup.css` / `popup.js` — ポップアップ UI
