import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Firebase Admin SDK 初期化（ADC: Cloud Runでは自動認証）
initializeApp({
  credential: applicationDefault(),
  projectId: process.env.GCP_PROJECT || 'tougou-db-f9f9e',
});

const db = getFirestore();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const app = express();
app.set('trust proxy', 1); // Cloud Run はプロキシ経由のためX-Forwarded-Forを信頼する
app.use(cors());
app.use(express.json());

// レート制限: 1分間に60リクエストまで
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。しばらくしてから再度お試しください。' },
});
app.use('/api/', limiter);

// 静的ファイル配信（チャットウィジェット）
app.use('/widget', express.static(path.join(__dirname, '../chat-widget')));

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'legend-chat-api' });
});

// ポータルトップページ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../chat-widget/index.html'));
});

// Google Sites 埋め込み用ページ
app.get('/embed', (req, res) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.sendFile(path.join(__dirname, '../chat-widget/embed.html'));
});

// 介護制度ナレッジ検索UI
app.get('/knowledge', (req, res) => {
  res.sendFile(path.join(__dirname, '../chat-widget/knowledge.html'));
});

// Webhook管理UI
app.get('/webhooks', (req, res) => {
  res.sendFile(path.join(__dirname, '../chat-widget/webhooks.html'));
});

// キーワード抽出（Gemini）
async function extractKeywords(question) {
  const prompt = `以下の介護・ケアマネジャー関連の質問から、Firestoreの全文検索に使用するキーワードを3〜5個抽出してください。\nキーワードはJSON配列形式で返してください。例: [\"訪問介護\", \"特定事業所加算\", \"人員基準\"]\n\n質問: ${question}\n\nキーワードのみJSON配列で返答してください（説明不要）:`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    // JSON配列を抽出
    const match = text.match(/\[.*\]/s);
    if (match) {
      return JSON.parse(match[0]);
    }
    // フォールバック: 質問をスペースで分割
    return question.split(/[\s　、。]+/).filter(k => k.length >= 2).slice(0, 5);
  } catch (e) {
    console.error('キーワード抽出エラー:', e);
    return question.split(/[\s　、。]+/).filter(k => k.length >= 2).slice(0, 5);
  }
}

// Firestore検索
async function searchDocuments(keywords) {
  const results = [];
  const seenIds = new Set();

  // array-contains-any は最大10要素まで
  const searchKeywords = keywords.slice(0, 10);

  const collections = [
    { name: 'kaigo_saishinjouhou', titleField: 'title', urlField: 'source_url', volField: 'vol' },
    { name: 'mhlw_kaigo_minutes', titleField: 'title', urlField: 'source_url', volField: null },
  ];

  for (const col of collections) {
    try {
      // relevance_to_caremanager == "high" のものを優先検索
      let query = db.collection(col.name)
        .where('keywords', 'array-contains-any', searchKeywords)
        .where('relevance_to_caremanager', '==', 'high')
        .limit(3);

      let snapshot = await query.get();

      // highが少ない場合は追加検索
      if (snapshot.size < 2) {
        const allQuery = db.collection(col.name)
          .where('keywords', 'array-contains-any', searchKeywords)
          .limit(5);
        const allSnapshot = await allQuery.get();
        allSnapshot.forEach(doc => {
          if (!seenIds.has(doc.id)) {
            seenIds.add(doc.id);
            const data = doc.data();
            results.push({
              id: doc.id,
              collection: col.name,
              title: data[col.titleField] || data.title || '不明',
              url: data[col.urlField] || data.url || '',
              vol: col.volField ? data[col.volField] : null,
              summary: data.summary || data.description || '',
              key_points: data.key_points || [],
              relevance: data.relevance_to_caremanager || 'normal',
            });
          }
        });
      } else {
        snapshot.forEach(doc => {
          if (!seenIds.has(doc.id)) {
            seenIds.add(doc.id);
            const data = doc.data();
            results.push({
              id: doc.id,
              collection: col.name,
              title: data[col.titleField] || data.title || '不明',
              url: data[col.urlField] || data.url || '',
              vol: col.volField ? data[col.volField] : null,
              summary: data.summary || data.description || '',
              key_points: data.key_points || [],
              relevance: data.relevance_to_caremanager || 'high',
            });
          }
        });
      }
    } catch (e) {
      console.error(`${col.name} 検索エラー:`, e.message);
    }
  }

  // relevance: high を先に並べて最大5件
  results.sort((a, b) => (a.relevance === 'high' ? -1 : 1));
  return results.slice(0, 5);
}

// RAG回答生成（Gemini）
async function generateAnswer(question, documents) {
  let context = '';
  if (documents.length > 0) {
    context = documents.map((doc, i) => {
      const keyPoints = Array.isArray(doc.key_points) ? doc.key_points.join('\n- ') : '';
      return `【資料${i + 1}】${doc.title}${doc.vol ? ` (Vol.${doc.vol})` : ''}\n概要: ${doc.summary}\n${keyPoints ? `ポイント:\n- ${keyPoints}` : ''}`;
    }).join('\n\n');
  }

  const prompt = context
    ? `あなたは介護保険制度に詳しいケアマネジャー支援AIです。以下の参考資料をもとに、質問に対して正確かつわかりやすく回答してください。\n\n参考資料:\n${context}\n\n質問: ${question}\n\n回答（400字程度、箇条書き可）:`
    : `あなたは介護保険制度に詳しいケアマネジャー支援AIです。以下の質問に対して、一般的な知識に基づいて回答してください。参考資料は見つかりませんでしたが、できる限り正確な情報を提供してください。\n\n質問: ${question}\n\n回答（400字程度）:`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (e) {
    console.error('回答生成エラー:', e);
    throw e;
  }
}

// ==============================
// Webhook管理API
// ==============================

// GET /api/webhooks — 全件取得
app.get('/api/webhooks', async (req, res) => {
  try {
    const snapshot = await db.collection('chat_webhooks').orderBy('created_at', 'desc').get();
    const webhooks = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.json(webhooks);
  } catch (e) {
    console.error('Webhook取得エラー:', e);
    res.status(500).json({ error: 'Webhookの取得に失敗しました', detail: e.message });
  }
});

// POST /api/webhooks — 新規登録
app.post('/api/webhooks', async (req, res) => {
  const { name, webhook_url, content_types, enabled } = req.body;

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name は必須です' });
  }
  if (!webhook_url || typeof webhook_url !== 'string' || !webhook_url.startsWith('https://chat.googleapis.com/')) {
    return res.status(400).json({ error: 'webhook_url は https://chat.googleapis.com/ で始まる必要があります' });
  }

  try {
    const data = {
      name: name.trim(),
      webhook_url,
      content_types: Array.isArray(content_types) ? content_types : [],
      enabled: typeof enabled === 'boolean' ? enabled : true,
      created_at: new Date().toISOString(),
    };
    const docRef = await db.collection('chat_webhooks').add(data);
    res.status(201).json({ id: docRef.id, ...data });
  } catch (e) {
    console.error('Webhook登録エラー:', e);
    res.status(500).json({ error: 'Webhookの登録に失敗しました', detail: e.message });
  }
});

// PUT /api/webhooks/:id — 更新
app.put('/api/webhooks/:id', async (req, res) => {
  const { id } = req.params;
  const { name, webhook_url, content_types, enabled } = req.body;

  if (webhook_url !== undefined && (typeof webhook_url !== 'string' || !webhook_url.startsWith('https://chat.googleapis.com/'))) {
    return res.status(400).json({ error: 'webhook_url は https://chat.googleapis.com/ で始まる必要があります' });
  }

  const updates = {};
  if (name !== undefined) updates.name = String(name).trim();
  if (webhook_url !== undefined) updates.webhook_url = webhook_url;
  if (content_types !== undefined) updates.content_types = Array.isArray(content_types) ? content_types : [];
  if (enabled !== undefined) updates.enabled = Boolean(enabled);

  try {
    const docRef = db.collection('chat_webhooks').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: '指定されたWebhookが見つかりません' });
    }
    await docRef.update(updates);
    res.json({ id, ...doc.data(), ...updates });
  } catch (e) {
    console.error('Webhook更新エラー:', e);
    res.status(500).json({ error: 'Webhookの更新に失敗しました', detail: e.message });
  }
});

// DELETE /api/webhooks/:id — 削除
app.delete('/api/webhooks/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const docRef = db.collection('chat_webhooks').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: '指定されたWebhookが見つかりません' });
    }
    await docRef.delete();
    res.json({ success: true, id });
  } catch (e) {
    console.error('Webhook削除エラー:', e);
    res.status(500).json({ error: 'Webhookの削除に失敗しました', detail: e.message });
  }
});

// POST /api/webhooks/:id/test — テスト送信
app.post('/api/webhooks/:id/test', async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await db.collection('chat_webhooks').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: '指定されたWebhookが見つかりません' });
    }
    const { webhook_url, name } = doc.data();

    const response = await fetch(webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '✅ レジェンドケアマネからのテスト送信です' }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(502).json({ error: 'Webhookへの送信に失敗しました', detail: errorText });
    }

    res.json({ success: true, message: `「${name}」へのテスト送信が完了しました` });
  } catch (e) {
    console.error('Webhookテスト送信エラー:', e);
    res.status(500).json({ error: 'テスト送信中にエラーが発生しました', detail: e.message });
  }
});

// Google Chat Webhook に全文送信
async function notifyGoogleChat(question, answer, sources) {
  try {
    const snapshot = await db.collection('chat_webhooks')
      .where('enabled', '==', true)
      .get();
    if (snapshot.empty) return;

    const sourceText = sources.length > 0
      ? '\n\n📚 *参考資料*\n' + sources.map(s => `• ${s.title}${s.vol ? ` Vol.${s.vol}` : ''}${s.url ? `\n  ${s.url}` : ''}`).join('\n')
      : '';

    const text = `💬 *質問*\n${question}\n\n🤖 *回答*\n${answer}${sourceText}`;

    await Promise.allSettled(
      snapshot.docs.map(doc => {
        const { webhook_url } = doc.data();
        return fetch(webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
      })
    );
  } catch (e) {
    console.error('[legend-chat] Google Chat通知エラー:', e.message);
  }
}

// POST /api/chat — チャット回答生成（RAGストリーミング）
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message は必須です' });
  }

  // SSE ヘッダー
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // キーワード抽出（Gemini不使用・高速化）
    const keywords = message.split(/[\s　、。？！]+/).filter(k => k.length >= 2).slice(0, 8);

    // Firestore検索
    const documents = await searchDocuments(keywords);
    const sources = documents.map(doc => ({ title: doc.title, url: doc.url, vol: doc.vol }));

    // プロンプト生成
    let context = '';
    if (documents.length > 0) {
      context = documents.map((doc, i) => {
        const keyPoints = Array.isArray(doc.key_points) ? doc.key_points.join('\n- ') : '';
        return `【資料${i + 1}】${doc.title}${doc.vol ? ` (Vol.${doc.vol})` : ''}\n概要: ${doc.summary}\n${keyPoints ? `ポイント:\n- ${keyPoints}` : ''}`;
      }).join('\n\n');
    }
    const prompt = context
      ? `あなたは介護保険制度に詳しいケアマネジャー支援AIです。以下の参考資料をもとに、質問に対して正確かつわかりやすく回答してください。\n\n参考資料:\n${context}\n\n質問: ${message}\n\n回答（400字程度、箇条書き可）:`
      : `あなたは介護保険制度に詳しいケアマネジャー支援AIです。以下の質問に対して、一般的な知識に基づいて回答してください。\n\n質問: ${message}\n\n回答（400字程度）:`;

    // Gemini ストリーミング
    const result = await model.generateContentStream(prompt);
    let fullAnswer = '';

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        fullAnswer += text;
        send({ type: 'text', text });
      }
    }

    // 完了通知（sources含む）
    send({ type: 'done', sources });
    res.end();

    // Google Chat Webhook に非同期送信
    notifyGoogleChat(message, fullAnswer, sources);

  } catch (e) {
    console.error('[legend-chat] /api/chat エラー:', e);
    send({ type: 'error', error: 'AIサービスに一時的な問題が発生しました。しばらく待ってから再試行してください。' });
    res.end();
  }
});

// GET /api/search?q=...&source=all|wam|mhlw&sort=date_desc|date_asc|relevance&limit=20&offset=0
app.get('/api/search', async (req, res) => {
  const {
    q,
    source = 'all',
    sort = 'relevance',
    limit: limitParam = '20',
    offset: offsetParam = '0',
  } = req.query;

  if (!q || typeof q !== 'string' || q.trim().length === 0) {
    return res.status(400).json({ error: 'クエリパラメータ q は必須です' });
  }
  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);
  const offset = Math.max(parseInt(offsetParam, 10) || 0, 0);

  const keywords = q.trim().split(/[\s　、。]+/).filter(k => k.length >= 1).slice(0, 10);
  if (keywords.length === 0) {
    return res.status(400).json({ error: '有効なキーワードが含まれていません' });
  }

  const allCollections = [
    { name: 'kaigo_saishinjouhou', source: 'wam'  },
    { name: 'mhlw_kaigo_minutes',  source: 'mhlw' },
    { name: 'kaigo_news',          source: 'news' },
  ];
  const targetCollections = allCollections.filter(
    col => source === 'all' || col.source === source
  );

  const allResults = [];
  const seenIds = new Set();

  try {
    for (const col of targetCollections) {
      try {
        if (col.source === 'news') {
          // kaigo_news は care_manager_impact フィールドを使用
          const highSnap = await db.collection(col.name)
            .where('keywords', 'array-contains-any', keywords)
            .where('care_manager_impact', '==', 'high')
            .limit(offset + limit)
            .get();

          highSnap.forEach(doc => {
            if (!seenIds.has(doc.id)) {
              seenIds.add(doc.id);
              const d = doc.data();
              allResults.push({
                id: doc.id,
                title: d.title || '不明',
                summary: d.summary || '',
                date: d.date || '',
                vol: null,
                source: col.source,
                url: d.url || '',
                relevance_score: 0.9,
              });
            }
          });

          if (allResults.filter(r => r.source === col.source).length < offset + limit) {
            const normalSnap = await db.collection(col.name)
              .where('keywords', 'array-contains-any', keywords)
              .limit(offset + limit)
              .get();

            normalSnap.forEach(doc => {
              if (!seenIds.has(doc.id)) {
                seenIds.add(doc.id);
                const d = doc.data();
                const impact = d.care_manager_impact || 'low';
                const score = impact === 'high' ? 0.9 : impact === 'medium' ? 0.7 : 0.5;
                allResults.push({
                  id: doc.id,
                  title: d.title || '不明',
                  summary: d.summary || '',
                  date: d.date || '',
                  vol: null,
                  source: col.source,
                  url: d.url || '',
                  relevance_score: score,
                });
              }
            });
          }
        } else {
          // kaigo_saishinjouhou / mhlw_kaigo_minutes は relevance_to_caremanager を使用
          const highSnap = await db.collection(col.name)
            .where('keywords', 'array-contains-any', keywords)
            .where('relevance_to_caremanager', '==', 'high')
            .limit(offset + limit)
            .get();

          highSnap.forEach(doc => {
            if (!seenIds.has(doc.id)) {
              seenIds.add(doc.id);
              const d = doc.data();
              allResults.push({
                id: doc.id,
                title: d.title || '不明',
                summary: d.summary || d.description || '',
                date: d.date || '',
                vol: col.name === 'kaigo_saishinjouhou' ? (d.vol || null) : null,
                source: col.source,
                url: d.url || '',
                relevance_score: 0.9,
              });
            }
          });

          // high が足りなければ通常関連度でも補充
          if (allResults.filter(r => r.source === col.source).length < offset + limit) {
            const normalSnap = await db.collection(col.name)
              .where('keywords', 'array-contains-any', keywords)
              .limit(offset + limit)
              .get();

            normalSnap.forEach(doc => {
              if (!seenIds.has(doc.id)) {
                seenIds.add(doc.id);
                const d = doc.data();
                allResults.push({
                  id: doc.id,
                  title: d.title || '不明',
                  summary: d.summary || d.description || '',
                  date: d.date || '',
                  vol: col.name === 'kaigo_saishinjouhou' ? (d.vol || null) : null,
                  source: col.source,
                  url: d.url || '',
                  relevance_score: 0.6,
                });
              }
            });
          }
        }
      } catch (e) {
        console.error(`${col.name} 検索エラー:`, e.message);
      }
    }

    // ソート
    if (sort === 'date_desc') {
      allResults.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
    } else if (sort === 'date_asc') {
      allResults.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
    } else {
      // relevance（デフォルト）
      allResults.sort((a, b) => b.relevance_score - a.relevance_score);
    }

    const total = allResults.length;
    const results = allResults.slice(offset, offset + limit);

    res.json({ results, total, query: q.trim() });
  } catch (e) {
    console.error('検索エラー:', e);
    res.status(500).json({ error: '検索中にエラーが発生しました', detail: e.message });
  }
});

// ========================
// チャットフィードバック保存（Phase 2 連携）
// ========================
app.post('/api/chat-feedback', async (req, res) => {
  try {
    const { message_id, tool_call_id, rating, reason, session_id } = req.body || {};
    if (!message_id || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'message_id と rating(1-5) は必須です' });
    }
    await db.collection('tool_feedback').add({
      tool_call_id: tool_call_id || '',
      tool_name: 'legend-chat',
      rating: Number(rating),
      reason: reason || '',
      source: 'chat-widget',
      session_id: session_id || '',
      user_email_hash: '',
      region: 'unknown',
      hokensha_code: '',
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      timestamp: new Date(),
    });
    res.json({ success: true });
  } catch (e) {
    console.error('chat-feedback error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ========================
// 学習状況サマリー API（ウィジェット学習パネル用）
// ========================
app.get('/api/insights-summary', async (req, res) => {
  try {
    // 直近7日分の日次サマリを取得
    const today = new Date();
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      return d.toISOString().slice(0, 10);
    });

    const snaps = await Promise.all(
      dates.map(date => db.collection('tool_insights').doc(`daily/${date}`).get())
    );

    const validDocs = snaps.filter(s => s.exists).map(s => s.data());
    if (validDocs.length === 0) {
      return res.json({ summary: null });
    }

    // 直近1日の集計
    const latest = validDocs[0];
    const toolStats = latest.tool_stats || {};
    const topTools = Object.entries(toolStats)
      .sort(([, a], [, b]) => (b.count || 0) - (a.count || 0))
      .slice(0, 3);

    const totalCalls = validDocs.reduce((s, d) => s + (d.total_calls || 0), 0);

    const toolLabels = {
      assess_needs: 'アセスメント支援',
      draft_careplan: 'ケアプラン作成',
      consult_legend: 'レジェンド相談',
      lookup_regulation: '法令検索',
      support_intake: 'インテーク支援',
    };

    const topHtml = topTools.map(([name, stat]) => {
      const label = toolLabels[name] || name;
      return `<span style="margin-right:8px">• ${label}（${stat.count}回）</span>`;
    }).join('');

    const summary = `<b>直近7日間: ${totalCalls.toLocaleString()}回の質問に回答</b><br>` +
      `よく使われた機能: ${topHtml}<br>` +
      `<span style="color:#64748b;font-size:11px">📍 対応エリア: 札幌・いわき・神奈川県西部・京都</span>`;

    res.json({ summary });
  } catch (e) {
    console.error('insights-summary error:', e.message);
    res.json({ summary: null });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`legend-chat-api listening on port ${PORT}`);
});
