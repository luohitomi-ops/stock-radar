/**
 * api/health.js — 快照健康檢查
 * GET /api/health → 回傳最新快照日期與新鮮度狀態
 */
export default async function handler(req, res) {
  const kvUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!kvUrl || !kvToken) {
    return res.status(200).json({ ok: false, reason: 'not_configured' });
  }

  try {
    const r = await fetch(`${kvUrl}/get/snapshot:latest`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    const data = await r.json();
    const latestDate = data.result ? JSON.parse(data.result) : null;

    if (!latestDate) {
      return res.status(200).json({ ok: false, reason: 'no_data' });
    }

    // 計算距今幾天（台灣時區，比較日期部分，避免跨時區偏差）
    const nowTW = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const nowDate = new Date(nowTW.getFullYear(), nowTW.getMonth(), nowTW.getDate());
    const latest  = new Date(latestDate + 'T00:00:00');  // 強制本地 midnight 比較
    const diffMs   = nowDate - latest;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    return res.status(200).json({
      ok: true,
      latestDate,
      diffDays,
      status: diffDays === 0 ? 'fresh' : diffDays === 1 ? 'yesterday' : 'stale',
    });
  } catch (err) {
    return res.status(200).json({ ok: false, reason: err.message });
  }
}
