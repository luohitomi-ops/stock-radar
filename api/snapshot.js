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
  const secret = req.query.secret;
  const isCron = req.headers['x-vercel-cron'] === '1';
  if (!isCron && secret !== (process.env.NOTIFY_SECRET || 'stockradar2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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

    // 2. 族群資料（51 個，跟 index.html 一致）
    // beta 依驅動指數分類：SOX=0.8 / SPX=0.6 / N225=0.7
    const BETA_MAP = { SOX: 0.8, SPX: 0.6, N225: 0.7 };
    const SECTOR_CONFIG = [
      // ── 熱門 20 個 ──
      { sector:'台股 AI 伺服器 / ODM',        driveIndex:'SOX', stockSymbols:['2382.TW','2356.TW','2324.TW'] },
      { sector:'台股 CoWoS 先進封裝',          driveIndex:'SOX', stockSymbols:['2330.TW','3711.TW','6239.TW'] },
      { sector:'台股 AI 散熱 / 液冷',          driveIndex:'SOX', stockSymbols:['3017.TW','1590.TW','2049.TW'] },
      { sector:'台股 HBM / 高頻寬記憶體',      driveIndex:'SOX', stockSymbols:['2408.TW','2344.TW','6770.TW'] },
      { sector:'台股 ABF 載板 / PCB',          driveIndex:'SOX', stockSymbols:['3037.TW','8046.TWO','3189.TW'] },
      { sector:'台股 矽光子 / CPO',            driveIndex:'SOX', stockSymbols:['2330.TW','3711.TW','3014.TW'] },
      { sector:'台股 交換器 / 網通設備',        driveIndex:'SOX', stockSymbols:['2345.TW','3596.TW','4524.TWO'] },
      { sector:'台股 IC 設計 / 繪圖晶片',      driveIndex:'SOX', stockSymbols:['2454.TW','2379.TW','3443.TW'] },
      { sector:'台股 ASIC / 客製晶片',         driveIndex:'SOX', stockSymbols:['2454.TW','3443.TW','5347.TW'] },
      { sector:'台股 功率半導體 / 電源管理',    driveIndex:'N225', stockSymbols:['6415.TW','8081.TW','2308.TW'] },
      { sector:'台股 貨櫃航運',                driveIndex:'SPX', stockSymbols:['2603.TW','2609.TW','2615.TW'] },
      { sector:'台股 壽險 / 金控',             driveIndex:'SPX', stockSymbols:['2882.TW','2881.TW','2891.TW'] },
      { sector:'台股 光學鏡頭',                driveIndex:'N225', stockSymbols:['3008.TW','3406.TW'] },
      { sector:'台股 被動元件',                driveIndex:'SOX', stockSymbols:['2327.TW','2351.TW'] },
      { sector:'台股 NOR Flash / 利基記憶體',  driveIndex:'SOX', stockSymbols:['2337.TW','2344.TW','8299.TW'] },
      { sector:'台股 EV 充電樁 / 充電設備',    driveIndex:'N225', stockSymbols:['2308.TW','2301.TW','1590.TW'] },
      { sector:'台股 鴻海 / 代工龍頭',         driveIndex:'SPX', stockSymbols:['2317.TW','2357.TW','3231.TW'] },
      { sector:'台股 電信 / 防禦型',           driveIndex:'SPX', stockSymbols:['2412.TW','4904.TW'] },
      { sector:'台股 機器人 / 精密傳動',        driveIndex:'N225', stockSymbols:['2049.TW','1590.TW'] },
      { sector:'台股 ETF / 大盤追蹤',          driveIndex:'SPX', stockSymbols:['0050.TW','2330.TW'] },
      // ── 次熱門 31 個 ──
      { sector:'台股 矽晶圓',                  driveIndex:'SOX', stockSymbols:['6488.TWO','3450.TW'] },
      { sector:'台股 IC 測試 / 封測',          driveIndex:'SOX', stockSymbols:['3711.TW','6239.TW','6515.TW'] },
      { sector:'台股 PCB 一般板',              driveIndex:'SOX', stockSymbols:['3044.TW','2374.TW'] },
      { sector:'台股 低軌衛星 / 天線',         driveIndex:'SPX', stockSymbols:['6814.TWO','2441.TW','3023.TW'] },
      { sector:'台股 車用鏡頭 / ADAS',         driveIndex:'N225', stockSymbols:['3008.TW','3406.TW'] },
      { sector:'台股 散裝航運',                driveIndex:'SPX', stockSymbols:['2603.TW','2609.TW'] },
      { sector:'台股 航空',                    driveIndex:'SPX', stockSymbols:['2618.TW','2610.TW'] },
      { sector:'台股 鋼鐵',                    driveIndex:'SPX', stockSymbols:['2002.TW'] },
      { sector:'台股 石化 / 塑化',             driveIndex:'SPX', stockSymbols:['1301.TW','1303.TW'] },
      { sector:'台股 工業電腦 / 嵌入式',       driveIndex:'SPX', stockSymbols:['2382.TW','2353.TW'] },
      { sector:'台股 連接器 / 線材',           driveIndex:'SOX', stockSymbols:['2308.TW','2301.TW'] },
      { sector:'台股 汽車電子 / 車用 IC',      driveIndex:'N225', stockSymbols:['6415.TW','2301.TW'] },
      { sector:'台股 太陽能 / 綠能',           driveIndex:'SPX', stockSymbols:['2308.TW','2301.TW'] },
      { sector:'台股 伺服器 / 機櫃',           driveIndex:'SOX', stockSymbols:['2356.TW','3017.TW'] },
      { sector:'台股 NAND Flash / SSD 控制',   driveIndex:'SOX', stockSymbols:['8299.TW','3260.TW'] },
      { sector:'台股 探針卡 / 半導體設備',      driveIndex:'SOX', stockSymbols:['6515.TW','3016.TW'] },
      { sector:'台股 成熟製程代工',             driveIndex:'SOX', stockSymbols:['2303.TW','5347.TW'] },
      { sector:'台股 電源供應器 / UPS',         driveIndex:'SOX', stockSymbols:['2308.TW','6415.TW'] },
      { sector:'台股 筆電 / NB 品牌',          driveIndex:'SPX', stockSymbols:['2357.TW','2353.TW'] },
      { sector:'台股 元宇宙 / AR 顯示',        driveIndex:'SOX', stockSymbols:['3008.TW','2454.TW'] },
      { sector:'台股 資安 / 雲端服務',         driveIndex:'SPX', stockSymbols:['2382.TW','2353.TW'] },
      { sector:'台股 ABF 材料 / 基板材料',     driveIndex:'SOX', stockSymbols:['6274.TWO','3189.TW'] },
      { sector:'台股 技嘉 / 主板顯卡',         driveIndex:'SOX', stockSymbols:['2376.TW','2357.TW'] },
      { sector:'台股 液態冷卻 / 冷板',         driveIndex:'SOX', stockSymbols:['3324.TW','3017.TW','2421.TW'] },
      { sector:'台股 高速傳輸 / 光纖模組',     driveIndex:'SOX', stockSymbols:['3536.TW','3664.TWO','3630.TWO'] },
      { sector:'台股 軍工 / 國防',             driveIndex:'SPX', stockSymbols:['2634.TW','8048.TWO','1568.TW'] },
      { sector:'台股 醫療器材 / 生技',         driveIndex:'SPX', stockSymbols:['6510.TWO','4707.TWO','4107.TWO'] },
      { sector:'台股 IP 授權 / 矽智財',        driveIndex:'SOX', stockSymbols:['6643.TWO','3661.TW','3051.TW'] },
      { sector:'台股 玻璃基板 / 先進封裝材料', driveIndex:'SOX', stockSymbols:['2383.TW','6213.TW','8046.TWO'] },
      { sector:'台股 工業自動化 / 機器手臂',   driveIndex:'N225', stockSymbols:['2049.TW','1590.TW','2308.TW'] },
    ];

    // 3. 抓各族群個股報價並計算 Gap
    const snap = {};
    await Promise.all(SECTOR_CONFIG.map(async cfg => {
      const quotes = await Promise.all(cfg.stockSymbols.map(s => fetchQuote(s)));
      const valid  = quotes.filter(q => q && q.chgPct != null);
      if (!valid.length) return;
      const act = valid.reduce((s, q) => s + q.chgPct, 0) / valid.length;
      const driveChg = macroResults[cfg.driveIndex] ?? null;
      // beta 依驅動指數查表（SOX=0.8 / SPX=0.6 / N225=0.7）
      const beta = BETA_MAP[cfg.driveIndex] ?? 0.6;
      const gap = driveChg != null ? parseFloat((driveChg * beta - act).toFixed(2)) : null;
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

    // 5. 發 Telegram 確認通知
    const tgToken  = process.env.TELEGRAM_TOKEN;
    const tgChatId = process.env.TELEGRAM_CHAT_ID;
    if (tgToken && tgChatId) {
      const sampleText = Object.entries(snap)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 3)
        .map(([k, v]) => `  ${k.replace('台股 ','')}：${v > 0 ? '+' : ''}${v}pp`)
        .join('\n');
      const msg = `✅ 盤後快照完成 ${today}\n族群數：${Object.keys(snap).length} 個\n\n前三名 Gap：\n${sampleText}`;
      try {
        await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tgChatId, text: msg }),
        });
      } catch (e) {
        console.warn('[Snapshot] Telegram notify failed:', e.message);
      }
    }

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
