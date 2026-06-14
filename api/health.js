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

    // 計算距今幾個「交易日」（台灣時區，跳過週六日）
    const nowTW = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const nowDate = new Date(nowTW.getFullYear(), nowTW.getMonth(), nowTW.getDate());
    const latest  = new Date(latestDate + 'T00:00:00');

    // 從快照日的下一天開始往今天數，只計算平日
    let diffTradingDays = 0;
    const cursor = new Date(latest);
    cursor.setDate(cursor.getDate() + 1);
    while (cursor <= nowDate) {
      const dow = cursor.getDay(); // 0=日, 6=六
      if (dow !== 0 && dow !== 6) diffTradingDays++;
      cursor.setDate(cursor.getDate() + 1);
    }

    return res.status(200).json({
      ok: true,
      latestDate,
      diffDays: diffTradingDays,
      status: diffTradingDays === 0 ? 'fresh' : diffTradingDays === 1 ? 'yesterday' : 'stale',
    });
  } catch (err) {
    return res.status(200).json({ ok: false, reason: err.message });
  }
}
