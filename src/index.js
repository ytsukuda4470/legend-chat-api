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
  ];
  const targetCollections = allCollections.filter(
    col => source === 'all' || col.source === source
  );

  const allResults = [];
  const seenIds = new Set();

  try {
    for (const col of targetCollections) {
      try {
        // relevance: high 優先で取得
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`legend-chat-api listening on port ${PORT}`);
});
