/**
 * api/sync.js — 跨裝置資料同步
 * 統一讀寫 Redis，供 portfolio.html 和 signal.html 使用
 *
 * GET  /api/sync?key=portfolio  → 讀取
 * POST /api/sync?key=portfolio  → 寫入（body: { data: ... }）
 *
 * 支援的 key：
 *   portfolio_active   — 模擬倉位持倉中
 *   portfolio_history  — 模擬倉位歷史出場
 *   signal_journal     — 訊號追蹤簿
 */

const ALLOWED_KEYS = ['portfolio_active', 'portfolio_history', 'signal_journal'];
const TTL = 86400 * 365; // 1 年

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

  // ── GET：讀取 ──
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

  // ── POST：寫入 ──
  if (req.method === 'POST') {
    try {
      const body = req.body;
      const value = body?.data;
      if (value === undefined) return res.status(400).json({ ok: false, reason: 'missing data' });

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
      return res.status(200).json({ ok: r.ok });
    } catch (err) {
      return res.status(200).json({ ok: false, reason: err.message });
    }
  }

  return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
}
