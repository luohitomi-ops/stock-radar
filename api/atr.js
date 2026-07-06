/**
 * api/atr.js — Vercel Serverless Function
 * 用途：給模擬倉「智慧動態出場」算 ATR14（14 日平均真實波幅），
 *       作為動態停損距離的依據，取代固定百分比停損。
 *
 * GET /api/atr?symbols=2330.TW,2345.TW
 * 回傳：{ ok, results: { '2330.TW': { atr14, lastClose }, ... } }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbols } = req.query;
  if (!symbols) {
    return res.status(400).json({ ok: false, error: 'symbols is required' });
  }
  const syms = symbols.split(',').filter(Boolean).slice(0, 10);

  const results = {};
  await Promise.all(syms.map(async sym => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=30d`;
      const r = await fetch(url, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer':         'https://finance.yahoo.com/',
          'Origin':          'https://finance.yahoo.com',
        },
        signal: AbortSignal.timeout(10000),
      });
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      const quote  = result?.indicators?.quote?.[0];
      if (!quote) return;

      const highs  = quote.high  || [];
      const lows   = quote.low   || [];
      const closes = quote.close || [];

      // 逐日算 True Range = max(高-低, |高-前收|, |低-前收|)
      const trList = [];
      for (let i = 1; i < closes.length; i++) {
        if (highs[i] == null || lows[i] == null || closes[i-1] == null) continue;
        const tr = Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i-1]),
          Math.abs(lows[i]  - closes[i-1]),
        );
        trList.push(tr);
      }
      if (trList.length < 5) return; // 資料太少不可靠，交給前端 fallback

      const last14 = trList.slice(-14);
      const atr14  = last14.reduce((a, b) => a + b, 0) / last14.length;
      const lastClose = closes.filter(c => c != null).slice(-1)[0] ?? null;

      results[sym] = { atr14: parseFloat(atr14.toFixed(2)), lastClose };
    } catch (e) {
      console.warn('[atr] failed:', sym, e.message);
    }
  }));

  return res.status(200).json({ ok: true, results });
}
