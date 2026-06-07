/**
 * api/proxy.js  —  Vercel Serverless Function
 *
 * 用途：在伺服器端呼叫 Yahoo Finance，繞過瀏覽器 CORS 限制
 * 呼叫方式：GET /api/proxy?url=<encoded_yahoo_url>
 *
 * 安全限制：只允許打 Yahoo Finance domain，防止被當作開放 proxy 濫用
 */

const ALLOWED_HOSTS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
];

export default async function handler(req, res) {
  // CORS headers（讓同一個 Vercel 專案的前端可以呼叫）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  let parsed;
  try {
    parsed = new URL(decodeURIComponent(url));
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // 安全檢查：只允許 Yahoo Finance
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return res.status(403).json({ error: `Host not allowed: ${parsed.hostname}` });
  }

  try {
    const response = await fetch(parsed.toString(), {
      headers: {
        // 模擬瀏覽器，避免 Yahoo 回 401
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Yahoo returned ${response.status}`,
        status: response.status,
      });
    }

    const data = await response.json();

    // 快取 5 分鐘（Vercel Edge Cache）
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(data);

  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(502).json({ error: 'Upstream fetch failed', detail: err.message });
  }
}
