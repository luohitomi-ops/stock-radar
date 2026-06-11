/**
 * api/snapshot.js — Vercel Serverless Function
 *
 * 用途：每天台股收盤後自動抓取所有族群 Gap 快照，存入 Upstash Redis
 * 觸發方式：
 *   1. Vercel Cron Job（每天 UTC 08:00 = 台灣 16:00，收盤後一小時）
 *   2. 手動 GET /api/snapshot?secret=stockradar2026（測試用）
 *
 * Redis Key 設計：
 *   snapshot:YYYY-MM-DD → JSON string { sectorName: gapValue, ... }
 *   snapshot:latest     → 最新一天的日期字串
 */

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// 從 Redis 讀取
// Upstash REST API 格式: GET /GET/key
async function kvGet(url, token, key) {
  const encodedKey = encodeURIComponent(key);
  const res = await fetch(`${url}/get/${encodedKey}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

// 寫入 Redis（帶 TTL，使用 pipeline 避免 URL 過長）
async function kvSet(url, token, key, value, exSeconds = 7776000) {
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      ['SET', key, JSON.stringify(value), 'EX', exSeconds]
    ]),
  });
  return res.ok;
}

// 抓單一股票報價
async function fetchQuote(symbol) {
  try {
    const res = await fetch(`${YAHOO_BASE}/${symbol}?interval=1d&range=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    const prev  = meta.chartPreviousClose || meta.previousClose;
    return { price, chgPct: prev ? ((price - prev) / prev * 100) : null };
  } catch { return null; }
}

// 宏觀指數設定（跟主頁一致）
const MACRO_SYMBOLS = [
  { label:'TWII', symbol:'^TWII' },
  { label:'SPX',  symbol:'^GSPC' },
  { label:'SOX',  symbol:'^SOX'  },
  { label:'NASDAQ', symbol:'^IXIC' },
  { label:'DJIA', symbol:'^DJI'  },
  { label:'VIX',  symbol:'^VIX'  },
  { label:'N225', symbol:'^N225' },
];

// 計算單一族群 Gap
function calcGap(stocks, driveChgPct, beta) {
  if (driveChgPct == null || beta == null) return null;
  const validStocks = stocks.filter(s => s.chgPct != null);
  if (!validStocks.length) return null;
  const act = validStocks.reduce((s, x) => s + x.chgPct, 0) / validStocks.length;
  const exp = driveChgPct * beta;
  return parseFloat((exp - act).toFixed(2));
}

export default async function handler(req, res) {
  // 驗證
  // 暫時開放測試，之後再加驗證
  // const secret = req.query.secret;
  // if (secret !== 'stockradar2026') return res.status(401).json({ error: 'Unauthorized' });

  const kvUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: 'Upstash not configured' });
  }

  try {
    // 1. 抓宏觀指數
    const macroResults = {};
    await Promise.all(MACRO_SYMBOLS.map(async m => {
      const q = await fetchQuote(m.symbol);
      if (q) macroResults[m.label] = q.chgPct;
    }));

    // 2. 族群資料（靜態定義，跟 index.html 一致）
    // 只存 driveIndex 和 beta，Gap 用即時計算
    const SECTOR_CONFIG = [
      { sector:'台股 AI 伺服器/ODM',      driveIndex:'SOX', stockSymbols:['2317.TW','2382.TW','3231.TW'] },
      { sector:'台股 CoWoS 先進封裝',     driveIndex:'SOX', stockSymbols:['2330.TW','3711.TW','2303.TW'] },
      { sector:'台股 HBM 高頻寬記憶體',   driveIndex:'SOX', stockSymbols:['2330.TW','2408.TW'] },
      { sector:'台股 矽光子/CPO',          driveIndex:'SOX', stockSymbols:['3484.TW','2455.TW'] },
      { sector:'台股 ASIC 客製晶片',       driveIndex:'SOX', stockSymbols:['3661.TW','2454.TW'] },
      { sector:'台股 散熱/熱管理',         driveIndex:'SOX', stockSymbols:['3017.TW','3324.TW','2421.TW'] },
      { sector:'台股 IC 設計',             driveIndex:'SOX', stockSymbols:['2454.TW','2379.TW','2303.TW'] },
      { sector:'台股 ABF 載板/PCB',        driveIndex:'SOX', stockSymbols:['3037.TW','2383.TW','8046.TWO'] },
      { sector:'台股 被動元件',            driveIndex:'SPX', stockSymbols:['2327.TW','2308.TW'] },
      { sector:'台股 鴻海生態系',          driveIndex:'SPX', stockSymbols:['2317.TW','2354.TW'] },
    ];

    // 3. 抓各族群個股報價並計算 Gap
    const snap = {};
    await Promise.all(SECTOR_CONFIG.map(async cfg => {
      const quotes = await Promise.all(cfg.stockSymbols.map(s => fetchQuote(s)));
      const valid  = quotes.filter(q => q && q.chgPct != null);
      if (!valid.length) return;
      const act = valid.reduce((s, q) => s + q.chgPct, 0) / valid.length;
      const driveChg = macroResults[cfg.driveIndex] ?? null;
      // beta 用固定值 0.5 作為保守估算（真實 beta 需要歷史資料）
      const gap = driveChg != null ? parseFloat((driveChg * 0.5 - act).toFixed(2)) : null;
      if (gap != null) snap[cfg.sector] = gap;
    }));

    if (!Object.keys(snap).length) {
      return res.status(200).json({ ok: false, message: '無法取得資料，可能是非交易日' });
    }

    // 4. 存入 Redis
    const today = new Date().toLocaleDateString('zh-TW', {
      timeZone: 'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit'
    }).replace(/\//g, '-');

    await kvSet(kvUrl, kvToken, `snapshot:${today}`, snap);
    await kvSet(kvUrl, kvToken, 'snapshot:latest', today, 86400 * 7); // latest 7天TTL

    console.log(`[Snapshot] ${today} saved ${Object.keys(snap).length} sectors`);
    return res.status(200).json({
      ok: true,
      date: today,
      sectors: Object.keys(snap).length,
      sample: Object.entries(snap).slice(0, 3),
    });

  } catch (err) {
    console.error('[Snapshot] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
