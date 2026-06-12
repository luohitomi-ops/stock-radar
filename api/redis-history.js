/**
 * api/redis-history.js — 讀取 Redis 快照歷史
 * GET /api/redis-history → 回傳所有 snapshot:YYYY-MM-DD 的資料
 */
export default async function handler(req, res) {
  // 允許跨來源（前端直接呼叫）
  res.setHeader('Access-Control-Allow-Origin', '*');

  const kvUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!kvUrl || !kvToken) {
    return res.status(200).json({ ok: false, reason: 'not_configured' });
  }

  try {
    // 1. 用 KEYS 找出所有 snapshot:YYYY-MM-DD 的 key
    const keysRes = await fetch(`${kvUrl}/keys/snapshot:2*`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    const keysData = await keysRes.json();
    const keys = (keysData.result || []).filter(k => /^snapshot:\d{4}-\d{2}-\d{2}$/.test(k));

    if (!keys.length) {
      return res.status(200).json({ ok: true, history: {} });
    }

    // 2. 用 pipeline 批次讀取所有 key
    const pipeline = keys.map(k => ['GET', k]);
    const pipeRes = await fetch(`${kvUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kvToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pipeline),
    });
    const pipeData = await pipeRes.json();

    // 3. 組成 { 'YYYY-MM-DD': { sectorName: gapValue, ... }, ... }
    const history = {};
    keys.forEach((k, i) => {
      const date = k.replace('snapshot:', '');
      const val  = pipeData[i]?.result;
      if (val) {
        try { history[date] = JSON.parse(val); } catch {}
      }
    });

    return res.status(200).json({ ok: true, history, days: Object.keys(history).length });
  } catch (err) {
    return res.status(200).json({ ok: false, reason: err.message });
  }
}
