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

// GET /api/search?q={query}&source={wam|mhlw|all}&limit={number}
app.get('/api/search', async (req, res) => {
  const { q, source = 'all', limit: limitParam } = req.query;

  if (!q || typeof q !== 'string' || q.trim().length === 0) {
    return res.status(400).json({ error: 'クエリパラメータ q は必須です' });
  }
  if (!['wam', 'mhlw', 'all'].includes(source)) {
    return res.status(400).json({ error: 'source は wam / mhlw / all のいずれかを指定してください' });
  }
  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);

  // クエリをキーワード分割（スペース・読点・句点で区切り、2文字以上を採用）
  const keywords = q.trim().split(/[\s　、。]+/).filter(k => k.length >= 2).slice(0, 10);
  if (keywords.length === 0) {
    return res.status(400).json({ error: '有効なキーワードが含まれていません' });
  }

  const allCollections = [
    { name: 'kaigo_saishinjouhou', source: 'wam',  titleField: 'title', urlField: 'source_url', dateField: 'published_date', volField: 'vol' },
    { name: 'mhlw_kaigo_minutes',  source: 'mhlw', titleField: 'title', urlField: 'source_url', dateField: 'date',            volField: null },
  ];
  const targetCollections = allCollections.filter(
    col => source === 'all' || col.source === source
  );

  const results = [];
  const seenIds = new Set();

  try {
    for (const col of targetCollections) {
      try {
        // relevance: high 優先
        const highSnapshot = await db.collection(col.name)
          .where('keywords', 'array-contains-any', keywords)
          .where('relevance_to_caremanager', '==', 'high')
          .limit(limit)
          .get();

        highSnapshot.forEach(doc => {
          if (!seenIds.has(doc.id)) {
            seenIds.add(doc.id);
            const data = doc.data();
            results.push({
              id: doc.id,
              title: data[col.titleField] || data.title || '不明',
              summary: data.summary || data.description || '',
              date: data[col.dateField] || data.date || data.published_date || null,
              source: col.source,
              url: data[col.urlField] || data.url || '',
              relevance_score: 0.9,
            });
          }
        });

        // high が limit 未満なら通常関連度でも補充
        const currentCount = results.filter(r => r.source === col.source).length;
        if (currentCount < limit) {
          const normalSnapshot = await db.collection(col.name)
            .where('keywords', 'array-contains-any', keywords)
            .limit(limit)
            .get();

          normalSnapshot.forEach(doc => {
            if (!seenIds.has(doc.id)) {
              seenIds.add(doc.id);
              const data = doc.data();
              results.push({
                id: doc.id,
                title: data[col.titleField] || data.title || '不明',
                summary: data.summary || data.description || '',
                date: data[col.dateField] || data.date || data.published_date || null,
                source: col.source,
                url: data[col.urlField] || data.url || '',
                relevance_score: 0.6,
              });
            }
          });
        }
      } catch (e) {
        console.error(`${col.name} 検索エラー:`, e.message);
      }
    }

    results.sort((a, b) => b.relevance_score - a.relevance_score);
    const paged = results.slice(0, limit);

    res.json({ results: paged, total: paged.length, query: q.trim() });
  } catch (e) {
    console.error('検索エラー:', e);
    res.status(500).json({ error: '検索中にエラーが発生しました', detail: e.message });
  }
});

// POST /api/chat
app.post('/api/chat', async (req, res) => {
  const { question } = req.body;

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: '質問を入力してください' });
  }

  try {
    // Step 1: キーワード抽出
    const keywords = await extractKeywords(question);
    console.log('抽出キーワード:', keywords);

    // Step 2: Firestore検索
    const documents = await searchDocuments(keywords);
    console.log(`検索結果: ${documents.length}件`);

    // Step 3: RAG回答生成
    const answer = await generateAnswer(question, documents);

    // Step 4: sources整形
    const sources = documents.map(doc => ({
      title: doc.title,
      url: doc.url,
      vol: doc.vol,
      summary: doc.summary,
    }));

    res.json({ answer, sources, keywords });
  } catch (e) {
    console.error('チャットエラー:', e);
    res.status(500).json({ error: '回答生成中にエラーが発生しました', detail: e.message });
  }
});

// GET /api/search
app.get('/api/search', async (req, res) => {
  const {
    q,
    category,
    relevance,
    source = 'all',
    limit: limitParam = '20',
    offset: offsetParam = '0',
  } = req.query;

  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);
  const offset = parseInt(offsetParam, 10) || 0;

  // キーワード配列（スペース区切り、最大10件）
  const keywords = q
    ? q.split(/[\s　]+/).filter(k => k.length >= 1).slice(0, 10)
    : [];

  const collections = [];
  if (source === 'kaigo' || source === 'all') {
    collections.push({ name: 'kaigo_saishinjouhou', sourceLabel: 'kaigo' });
  }
  if (source === 'mhlw' || source === 'all') {
    collections.push({ name: 'mhlw_kaigo_minutes', sourceLabel: 'mhlw' });
  }

  const allResults = [];

  for (const col of collections) {
    try {
      let query = db.collection(col.name);

      if (keywords.length > 0) {
        query = query.where('keywords', 'array-contains-any', keywords);
      }

      if (category) {
        query = query.where('category', '==', category);
      }

      if (relevance === 'high' && col.name === 'kaigo_saishinjouhou') {
        query = query.where('relevance_to_caremanager', '==', 'high');
      }

      query = query.orderBy('date', 'desc').limit(offset + limit);

      const snapshot = await query.get();
      let i = 0;
      snapshot.forEach(doc => {
        if (i < offset) { i++; return; }
        const data = doc.data();
        allResults.push({
          id: doc.id,
          vol: col.name === 'kaigo_saishinjouhou' ? (data.vol || null) : undefined,
          date: data.date || '',
          title: data.title || '',
          summary: data.summary || data.description || '',
          key_points: data.key_points || [],
          keywords: data.keywords || [],
          category: data.category || '',
          relevance_to_caremanager: col.name === 'kaigo_saishinjouhou' ? (data.relevance_to_caremanager || '') : undefined,
          url: data.source_url || data.url || '',
          source: col.sourceLabel,
        });
        i++;
      });
    } catch (e) {
      console.error(`${col.name} 検索エラー:`, e.message);
    }
  }

  // source=all の場合は date 降順でマージ
  allResults.sort((a, b) => {
    if (a.date > b.date) return -1;
    if (a.date < b.date) return 1;
    return 0;
  });

  const results = allResults.slice(0, limit);

  res.json({
    results,
    total: allResults.length,
    query: q || '',
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`legend-chat-api listening on port ${PORT}`);
});
