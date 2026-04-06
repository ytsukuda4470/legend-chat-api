import express from 'express';
import cors from 'cors';
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'legend-chat-api' });
});

// キーワード抽出（Gemini）
async function extractKeywords(question) {
  const prompt = `以下の介護・ケアマネジャー関連の質問から、Firestoreの全文検索に使用するキーワードを3〜5個抽出してください。
キーワードはJSON配列形式で返してください。例: ["訪問介護", "特定事業所加算", "人員基準"]

質問: ${question}

キーワードのみJSON配列で返答してください（説明不要）:`;

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
      return `【資料${i + 1}】${doc.title}${doc.vol ? ` (Vol.${doc.vol})` : ''}
概要: ${doc.summary}
${keyPoints ? `ポイント:\n- ${keyPoints}` : ''}`;
    }).join('\n\n');
  }

  const prompt = context
    ? `あなたは介護保険制度に詳しいケアマネジャー支援AIです。以下の参考資料をもとに、質問に対して正確かつわかりやすく回答してください。

参考資料:
${context}

質問: ${question}

回答（400字程度、箇条書き可）:`
    : `あなたは介護保険制度に詳しいケアマネジャー支援AIです。以下の質問に対して、一般的な知識に基づいて回答してください。参考資料は見つかりませんでしたが、できる限り正確な情報を提供してください。

質問: ${question}

回答（400字程度）:`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (e) {
    console.error('回答生成エラー:', e);
    throw e;
  }
}

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`legend-chat-api listening on port ${PORT}`);
});
