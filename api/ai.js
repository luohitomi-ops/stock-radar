/**
 * api/ai.js  —  Vercel Serverless Function
 *
 * 用途：在伺服器端呼叫 Google Gemini API（免費額度），繞過瀏覽器 CORS 限制
 * 呼叫方式：POST /api/ai  body: { prompt: string }
 *
 * 環境變數：GEMINI_API_KEY（在 Vercel 設定）
 * 改用 Gemini 原因：原 Anthropic API 額度用罄（按量計費，與 Claude Pro 訂閱分開），
 *   改用 Gemini 免費額度（gemini-2.0-flash）取代，前端呼叫介面不變。
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  // 字數保護：prompt 超過 2000 字就截斷，避免意外過量
  const safePrompt = prompt.slice(0, 2000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: safePrompt }] }],
          generationConfig: { maxOutputTokens: 300 },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err?.error?.message || 'Gemini API error' });
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.status(200).json({ text });

  } catch (err) {
    console.error('AI proxy error:', err.message);
    return res.status(502).json({ error: 'AI service unavailable' });
  }
}
