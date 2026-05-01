@~/.claude/shared/APP_BASE.md

---

# 介護制度AIチャットボット（legend-chat-api）プロジェクトルール

## アプリ間連携設定

handoff-id: legend-chat

このIDは ytsukuda4470/279-app-handoffs（中央受信箱）で他アプリと連携するための識別子です。
変更しないこと。

他アプリへの依頼は `gh issue create --repo ytsukuda4470/279-app-handoffs --label "to:相手id,from:legend-chat"` で送る。
自分宛Issueの確認は `gh issue list --repo ytsukuda4470/279-app-handoffs --label "to:legend-chat" --state open` で行う。

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

---

## デザインシステム（改修前に必ず確認）

**UIコンポーネントを変更・追加する前に必ずdesign-MCPに相談すること。**

### このアプリのデザイン登録情報

| 項目 | 値 |
|---|---|
| アプリ番号 | No.15 |
| プライマリカラー | `未登録（次回 create_app_design で発行）` |
| アイコンファイル | `15-chat-ai.svg` |
| デザイン管理リポジトリ | `279-design-management/brand-assets/icons/` |

### 改修前の必須手順

```bash
# 1. デザインポリシー確認（カラー・タイポ・コンポーネントルール）
→ design-MCP: get_design_policy

# 2. このアプリのCSS変数を取得
→ design-MCP: create_app_design appName="介護制度AIチャット"

# 3. 実装チェックリスト確認
→ design-MCP: get_implementation_checklist
```

### 共通デザインルール（全アプリ統一）

- フォント: Noto Sans JP（Google Fonts）
- サイドバー幅: 240px（PC固定）、モバイルはハンバーガー
- ヘッダー高さ: 48px、フォントサイズ最小: 13px
- テーブルヘッダー: `#238e3a`（コーポレートグリーン）
- アクセント: `#febe0f`（イエロー）
- 削除操作: 必ず確認ダイアログを実装

## ⚠️ 一部レガシー技術の移行を検討
このアプリはNode.js + Expressを使用しています。
改修のタイミングで以下を検討してください：
- Express API → Next.js API Routes or Cloud Run直接
- 参照: 279推奨スタック https://279-dev-dashboard.web.app (技術標準タブ)
