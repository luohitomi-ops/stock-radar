/**
 * api/hit-rate.js — Vercel Serverless Function
 *
 * 用途：從 Redis 累積的每日快照，回溯計算各族群「Gap 訊號兌現率」——
 * 當某族群 Gap 觸發警示（|gap|>=threshold）後，隔天 Gap 是否明顯收斂
 * （代表台股真的補漲/補跌了，訊號兌現），或維持發散（訊號沒兌現）。
 *
 * GET /api/hit-rate?threshold=2
 * 回傳：{ ok, days, results: [{ sector, triggers, hits, hitRate, avgNextDayShrink }] }
 *   sorted by hitRate desc（觸發次數太少的排後面，避免小樣本誤導）
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kvUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ ok: false, error: 'Upstash not configured' });

  const threshold = parseFloat(req.query.threshold || '2');

  try {
    // 1. 列出所有 snapshot:YYYY-MM-DD key
    const keysRes  = await fetch(`${kvUrl}/keys/snapshot:2*`, {
      headers: { Authorization: `Bearer ${kvToken}` },
      signal: AbortSignal.timeout(8000),
    });
    const keysData = await keysRes.json();
    const keys = (keysData.result || [])
      .filter(k => /^snapshot:\d{4}-\d{2}-\d{2}$/.test(k))
      .sort();

    if (keys.length < 2) {
      return res.status(200).json({ ok: true, days: keys.length, results: [], message: '快照天數不足，無法計算兌現率' });
    }

    // 2. 批次抓所有快照內容（pipeline，避免逐一 GET）
    const pipeline = keys.map(k => ['GET', k]);
    const pipeRes  = await fetch(`${kvUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(10000),
    });
    const pipeData = await pipeRes.json();

    const days = [];
    keys.forEach((k, i) => {
      const val = pipeData[i]?.result;
      if (val) try { days.push({ date: k.replace('snapshot:', ''), snap: JSON.parse(val) }); } catch {}
    });
    days.sort((a, b) => a.date.localeCompare(b.date));

    // 3. 逐日比對：day[i] 觸發警示 → 看 day[i+1] 是否明顯收斂（|gap|縮小超過 50%，或跨越0反轉）
    const stats = {}; // sector -> { triggers, hits, shrinkSum }
    for (let i = 0; i < days.length - 1; i++) {
      const today = days[i].snap;
      const tomorrow = days[i + 1].snap;
      for (const [sector, gapToday] of Object.entries(today)) {
        if (Math.abs(gapToday) < threshold) continue; // 沒觸發警示，不列入統計
        const gapTomorrow = tomorrow[sector];
        if (gapTomorrow === undefined) continue; // 隔天缺資料，跳過（不算失敗也不算成功）

        if (!stats[sector]) stats[sector] = { triggers: 0, hits: 0, shrinkSum: 0 };
        stats[sector].triggers++;

        // 兌現定義：隔天 |gap| 縮小到原本的 50% 以下（代表台股真的補漲/補跌，Gap 被市場消化）
        const shrinkRatio = 1 - Math.abs(gapTomorrow) / Math.abs(gapToday);
        stats[sector].shrinkSum += shrinkRatio;
        if (Math.abs(gapTomorrow) <= Math.abs(gapToday) * 0.5) stats[sector].hits++;
      }
    }

    const results = Object.entries(stats)
      .map(([sector, s]) => ({
        sector,
        triggers: s.triggers,
        hits: s.hits,
        hitRate: parseFloat(((s.hits / s.triggers) * 100).toFixed(1)),
        avgNextDayShrink: parseFloat(((s.shrinkSum / s.triggers) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.hitRate - a.hitRate || b.triggers - a.triggers);

    return res.status(200).json({ ok: true, days: days.length, threshold, results });
  } catch (err) {
    console.error('[hit-rate] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
