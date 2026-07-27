/**
 * api/beta-sync.js — Vercel Serverless Function
 *
 * 用途：讓網站前端算出的「真實 OLS beta」（BetaEngine，用 3 個月歷史報酬回歸）
 * 同步存進 Redis，給 notify.js / snapshot.js 讀取，取代原本寫死的
 * BETA_MAP（SOX=0.8/SPX=0.6/N225=0.7，不分族群）。
 *
 * 背景：前端每次算的 Gap 用的是每個族群自己的真實 beta，
 * 但 TG 通知跟盤後快照過去一直用同一組固定常數，導致同一族群
 * 同一天，TG 報的 Gap 跟網站顯示的可能對不上。
 *
 * GET  /api/beta-sync          → { ok, betas: { sector: {beta, r2, updatedAt} } }
 * POST /api/beta-sync  body: { betas: { sector: {beta, r2} } }  → 合併寫入 Redis
 */

const REDIS_KEY = 'betas:latest';
const TTL_SECONDS = 86400 * 14; // 14 天沒更新就過期，避免用太舊的 beta

async function kvGet(url, token, key) {
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function kvSet(url, token, key, value, exSeconds) {
  await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', exSeconds]]),
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kvUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ ok: false, error: 'Upstash not configured' });

  if (req.method === 'GET') {
    try {
      const betas = (await kvGet(kvUrl, kvToken, REDIS_KEY)) || {};
      return res.status(200).json({ ok: true, betas });
    } catch (e) {
      return res.status(200).json({ ok: false, betas: {}, error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const incoming = req.body?.betas;
      if (!incoming || typeof incoming !== 'object') {
        return res.status(400).json({ ok: false, error: 'Missing betas object' });
      }
      const existing = (await kvGet(kvUrl, kvToken, REDIS_KEY)) || {};
      const now = Date.now();
      let merged = { ...existing };
      let count = 0;
      for (const [sector, v] of Object.entries(incoming)) {
        if (typeof v?.beta !== 'number' || isNaN(v.beta)) continue;
        merged[sector] = { beta: v.beta, r2: typeof v.r2 === 'number' ? v.r2 : null, updatedAt: now };
        count++;
      }
      await kvSet(kvUrl, kvToken, REDIS_KEY, merged, TTL_SECONDS);
      return res.status(200).json({ ok: true, updated: count });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
