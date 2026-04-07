# 介護制度AIチャットボット（legend-chat-api）プロジェクトルール

## 概要
業務ポータル向けチャットウィジェット + Cloud Run APIバックエンド。
他サイトへ埋め込んで使うため、CORS・セキュリティ設定は特に慎重に。

## 技術スタック
- Node.js + Express + Firebase Admin SDK
- Cloud Run（asia-northeast1 / GCPプロジェクト: 936239225906相当）
- Gemini API（pdf-kiriwake-279プロジェクトのキー）
- 本番URL: https://legend-chat-api-936239225906.asia-northeast1.run.app

## ❌ 絶対禁止（理由と代替手段セット）

### 1. tougou-db-f9f9eのGemini APIキーを使わない
**なぜ**: 無料枠0のため即エラーになる（レジェンドケアマネと同じ制約）。
```bash
# ✅ GOOD: pdf-kiriwake-279 のキー（Secret Manager: GEMINI_API_KEY_CHAT）
gcloud secrets versions access latest --secret=GEMINI_API_KEY_CHAT --project=pdf-kiriwake-279
```

### 2. GeminiのエラーメッセージをそのままAPIレスポンスに返さない
**なぜ**: 内部構造・APIキー名・プロジェクト名が漏洩する可能性がある。
```javascript
// ❌ BAD
res.status(500).json({ error: e.message }); // Geminiの生エラーをそのまま返す

// ✅ GOOD
console.error('[legend-chat] Gemini error:', e);
res.status(500).json({ error: 'AIサービスに一時的な問題が発生しました。しばらく待ってから再試行してください。' });
```

### 3. CORSをワイルドカードで許可しない（本番環境）
**なぜ**: 埋め込み先以外のサイトからもAPIが叩けてしまう。
```javascript
// ❌ BAD（開発時のみ許可）
app.use(cors({ origin: '*' }));

// ✅ GOOD: 許可するオリジンを明示
const allowedOrigins = ['https://279portal.web.app', 'https://your-site.com'];
app.use(cors({ origin: allowedOrigins }));
```

### 4. kaigo_saishinjouhouコレクションに書き込まない
**なぜ**: レジェンドケアマネMCPが管理するコレクション。このアプリはread-onlyで使用。

## チャットウィジェット組み込み方法
```html
<script>
  window.LEGEND_CHAT_API_URL = 'https://legend-chat-api-936239225906.asia-northeast1.run.app';
</script>
<script src="https://your-hosting/chat-widget.js"></script>
```

## デプロイ
```bash
gcloud run deploy legend-chat-api \
  --region=asia-northeast1 \
  --project=tougou-db-f9f9e
```
