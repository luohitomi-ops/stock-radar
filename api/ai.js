/**
 * api/ai.js  —  Vercel Serverless Function
 *
 * 用途：在伺服器端呼叫 Anthropic API，繞過瀏覽器 CORS 限制
 * 呼叫方式：POST /api/ai  body: { prompt: string }
 *
 * 環境變數：ANTHROPIC_API_KEY（在 Vercel 設定）
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  // 字數保護：prompt 超過 2000 字就截斷，避免意外高費用
  const safePrmopt = prompt.slice(0, 2000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',  // 用 Haiku，更便宜，摘要夠用
        max_tokens: 300,
        messages: [{ role: 'user', content: safePrmopt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err?.error?.message || 'Anthropic API error' });
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text || '';
    return res.status(200).json({ text });

  } catch (err) {
    console.error('AI proxy error:', err.message);
    return res.status(502).json({ error: 'AI service unavailable' });
  }
}
