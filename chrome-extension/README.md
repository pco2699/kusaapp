# Chrome extension — Habit Tracker Gauge

[kusaapp](../README.md)（everyday セルフホスト habit tracker）のリポジトリに含まれる Chrome 拡張機能。

Toolbar に「完了した habit の数を中心に、緑の円形ゲージ」を表示する。

## 仕様（要件に沿った実装）

- **Toolbar アイコン = 円形ゲージ**
  - 0% → 暗い緑の円（空のトラック）
  - 完了率に応じて、12時方向から時計回りに鮮やかな緑の弧が伸びる
  - 100% → 全部鮮やかな緑 / 60% → 60% だけ鮮やかな緑
- **バッジ = 今日完了した必須 habit の数**（ツールバー右下の数字）
  - 小さいアイコンに数字を描くと潰れて読めないため、Chrome の badge 機能で数値を表示
- **クリック → ポップアップ**（habit の追加・チェック・削除）
- **「平日どれでも」habit はゲージの分母・分子に換算しない**（`flexible` フラグ）

## インストール方法

1. Chrome で `chrome://extensions` を開く
2. 右上「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」→ この `chrome-extension/` フォルダを選択

## データモデル（現状）

```js
{
  id: string,
  name: string,
  days: number[],        // 対象曜日 0=日 .. 6=土
  flexible: boolean,     // true = 平日どれでも（ゲージ非換算）
  completedDates: string[] // 'YYYY-MM-DD'
}
```

## 現状の制限 / ロードマップ

- **現在は自己完結**（`chrome.storage.local` に保存）。kusaapp サーバーの API
  （`GET /api/state` / `POST /api/toggle`）には未接続。
- kusaapp 側の `any_days`（any-of-weekday）概念と、こちらの `flexible`（平日どれでも）は
  対応関係にあり、API 接続時に統合できる。
