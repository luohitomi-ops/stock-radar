/**
 * api/sync.js — 跨裝置資料同步
 * GET  /api/sync?key=portfolio_active  → 讀取
 * POST /api/sync?key=portfolio_active  → 寫入
 */

const ALLOWED_KEYS = ['portfolio_active', 'portfolio_history', 'signal_journal'];
const TTL = 86400 * 365;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kvUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(200).json({ ok: false, reason: 'not_configured' });
  }

  const key = req.query.key;
  if (!ALLOWED_KEYS.includes(key)) {
    return res.status(400).json({ ok: false, reason: 'invalid_key' });
  }

  const redisKey = `userdata:${key}`;

  // ── GET ──
  if (req.method === 'GET') {
    try {
      const r = await fetch(`${kvUrl}/get/${encodeURIComponent(redisKey)}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      });
      const d = await r.json();
      const value = d.result ? JSON.parse(d.result) : null;
      return res.status(200).json({ ok: true, data: value });
    } catch (err) {
      return res.status(200).json({ ok: false, reason: err.message });
    }
  }

  // ── POST ──
  if (req.method === 'POST') {
    try {
      // 手動讀取 body（Vercel Serverless 需要）
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {}
      }
      // 若 body 還是 undefined，從 stream 讀取
      if (!body) {
        body = await new Promise((resolve, reject) => {
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => {
            try { resolve(JSON.parse(raw)); }
            catch { resolve({}); }
          });
          req.on('error', reject);
        });
      }

      const value = body?.data;
      if (value === undefined) {
        return res.status(400).json({ ok: false, reason: 'missing data' });
      }

      const r = await fetch(`${kvUrl}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          ['SET', redisKey, JSON.stringify(value), 'EX', TTL]
        ]),
      });
      const result = await r.json();
      return res.status(200).json({ ok: r.ok, result });
    } catch (err) {
      return res.status(200).json({ ok: false, reason: err.message });
    }
  }

  return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
}
