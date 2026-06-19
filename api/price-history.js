/**
 * api/price-history.js
 * 用途：給 signal.html autoFillPrice() 呼叫
 * GET /api/price-history?symbols=2345.TW,3596.TW&from=2026-06-11
 * 回傳：{ ok, results: { '2345.TW': pctChange, ... } }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbols, from } = req.query;
  if (!symbols || !from) {
    return res.status(400).json({ ok: false, error: 'symbols and from are required' });
  }

  const syms = symbols.split(',').filter(Boolean).slice(0, 10);
  const fromTs = new Date(from).getTime() / 1000;

  const results = {};
  await Promise.all(syms.map(async sym => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=60d`;
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
      if (!result) return;

      const ts     = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];

      // 找 from 日期當天或之後第一個有效收盤（進場價）
      let entryClose = null;
      let latestClose = null;
      for (let i = 0; i < ts.length; i++) {
        if (closes[i] == null) continue;
        if (ts[i] >= fromTs && entryClose === null) entryClose = closes[i];
        latestClose = closes[i];
      }
      if (entryClose == null || latestClose == null) return;
      results[sym] = parseFloat(((latestClose - entryClose) / entryClose * 100).toFixed(2));
    } catch (e) {
      console.warn('[price-history] failed:', sym, e.message);
    }
  }));

  return res.status(200).json({ ok: true, results });
}
