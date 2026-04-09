# 介護制度AIチャットボット — システム仕様書

## 概要
スタッフ向けWebチャットUI。legend-caremanager-mcp が収集したナレッジをFirestore経由で参照し介護制度の質問に回答。

## 技術スタック
- Node.js / Express
- Gemini AI
- Cloud Run (tougou-db-f9f9e)

## デプロイ
- URL: https://legend-chat-api-936239225906.asia-northeast1.run.app

## 注意事項
- CORSをワイルドカード(*)で許可禁止
- GeminiエラーをそのままAPIレスポンスに返禁止
