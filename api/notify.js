/** 
 * api/notify.js  —  Vercel Serverless + Cron Job
 *
 * 觸發方式：
 *   1. Vercel Cron Job 每 30 分鐘自動觸發（vercel.json 設定）
 *   2. 手動 GET /api/notify?secret=YOUR_SECRET 觸發（測試用）
 *
 * 環境變數（在 Vercel Dashboard 設定）：
 *   TELEGRAM_TOKEN   — Bot Token
 *   TELEGRAM_CHAT_ID — Chat ID
 *   NOTIFY_SECRET    — 手動觸發的保護密鑰（自訂任意字串）
 *   GAP_THRESHOLD    — 觸發通知的 gap 閾值（pp），預設 2.0
 */

// ── 族群設定（與前端 CONFIG.sectorData 同步）──
// driveIndex → Yahoo Finance symbol
const DRIVE_SYMBOLS = {
  SOX:  '^SOX',
  SPX:  '^GSPC',
  N225: '^N225',
};

// 只監控熱門族群（避免 API 請求過多）
const WATCH_SECTORS = [
  { sector:'台股 AI 伺服器 / ODM',      driveIndex:'SOX', stocks:['2382.TW','2356.TW'] },
  { sector:'台股 CoWoS 先進封裝',        driveIndex:'SOX', stocks:['2330.TW','3711.TW'] },
  { sector:'台股 AI 散熱 / 液冷',        driveIndex:'SOX', stocks:['3017.TW','1590.TW'] },
  { sector:'台股 HBM / 高頻寬記憶體',    driveIndex:'SOX', stocks:['2408.TW','2344.TW'] },
  { sector:'台股 ABF 載板 / PCB',        driveIndex:'SOX', stocks:['3037.TW','8046.TW'] },
  { sector:'台股 矽光子 / CPO',          driveIndex:'SOX', stocks:['2330.TW','3711.TW'] },
  { sector:'台股 交換器 / 網通設備',     driveIndex:'SOX', stocks:['2345.TW','3596.TW'] },
  { sector:'台股 IC 設計 / 繪圖晶片',    driveIndex:'SOX', stocks:['2454.TW','2379.TW'] },
  { sector:'台股 功率半導體 / 電源管理', driveIndex:'N225',stocks:['6415.TW','8081.TW'] },
  { sector:'台股 貨櫃航運',             driveIndex:'SPX', stocks:['2603.TW','2609.TW'] },
  { sector:'台股 壽險 / 金控',          driveIndex:'SPX', stocks:['2882.TW','2881.TW'] },
];

// ── Yahoo Finance 抓報價 ──
async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2d`;
  const res  = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept':     'application/json',
      'Referer':    'https://finance.yahoo.com/',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`No meta for ${symbol}`);
  const price    = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose;
  const chgPct   = ((price - prevClose) / prevClose) * 100;
  return { symbol, price, chgPct };
}

// ── 批次取報價（串行，避免被封）──
async function fetchAll(symbols) {
  const result = {};
  for (const sym of symbols) {
    try {
      result[sym] = await fetchQuote(sym);
      await new Promise(r => setTimeout(r, 300)); // 每次間隔 300ms
    } catch (e) {
      console.warn(`fetchQuote failed: ${sym}`, e.message);
      result[sym] = null;
    }
  }
  return result;
}

// ── 計算各族群 gap ──
async function computeGaps(threshold) {
  // 1. 收集所有需要的 symbols
  const allStockSyms = [...new Set(WATCH_SECTORS.flatMap(s => s.stocks))];
  const allDriveSyms = [...new Set(WATCH_SECTORS.map(s => DRIVE_SYMBOLS[s.driveIndex]))];
  const allSyms      = [...allStockSyms, ...allDriveSyms];

  // 2. 拉報價
  const quotes = await fetchAll(allSyms);

  // 3. 計算每個族群的 act / exp / gap
  const alerts = [];
  for (const sector of WATCH_SECTORS) {
    const driveSym  = DRIVE_SYMBOLS[sector.driveIndex];
    const driveQ    = quotes[driveSym];
    if (!driveQ) continue;

    const stockChgs = sector.stocks
      .map(s => quotes[s]?.chgPct)
      .filter(v => v !== null && v !== undefined && !isNaN(v));

    if (!stockChgs.length) continue;

    const act = stockChgs.reduce((a, b) => a + b, 0) / stockChgs.length;

    // 簡化 beta = 0.8（後端無法跑 OLS，用保守估算值）
    // 未來可以把 beta 存到 KV storage
    const beta = 0.8;
    const exp  = driveQ.chgPct * beta;
    const gap  = parseFloat((exp - act).toFixed(2));

    if (Math.abs(gap) >= threshold) {
      alerts.push({
        sector:   sector.sector,
        gap,
        act:      parseFloat(act.toFixed(2)),
        exp:      parseFloat(exp.toFixed(2)),
        driveChg: parseFloat(driveQ.chgPct.toFixed(2)),
        driveName: sector.driveIndex,
      });
    }
  }

  // 按 gap 絕對值排序
  return alerts.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
}

// ── 發送 Telegram 訊息 ──
async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    chatId,
      text,
      parse_mode: 'HTML',
    }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error: ${data.description}`);
  return data;
}

// ── 格式化通知訊息 ──
function formatMessage(alerts, threshold) {
  const now = new Date().toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit',
  });

  const lines = alerts.map(a => {
    const icon    = a.gap > 0 ? '🔴' : '🟢';
    const gapStr  = a.gap > 0 ? `+${a.gap}pp` : `${a.gap}pp`;
    const driveStr = `${a.driveName} ${a.driveChg > 0 ? '+' : ''}${a.driveChg}%`;
    return `${icon} <b>${a.sector.replace('台股 ', '')}</b>\n   Gap: <b>${gapStr}</b>　驅動: ${driveStr}\n   預期: ${a.exp > 0 ? '+' : ''}${a.exp}%　實際: ${a.act > 0 ? '+' : ''}${a.act}%`;
  });

  return [
    `📡 <b>Stock Radar Gap 警示</b>`,
    `閾值 ±${threshold}pp 以上共 ${alerts.length} 個族群`,
    ``,
    lines.join('\n\n'),
    ``,
    `⏰ ${now}`,
    `🔴 = 補漲空間　🟢 = 已超漲`,
  ].join('\n');
}

// ── 主 Handler ──
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 環境變數
  const TOKEN     = process.env.TELEGRAM_TOKEN;
  const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
  const SECRET    = process.env.NOTIFY_SECRET;
  const THRESHOLD = parseFloat(process.env.GAP_THRESHOLD || '2.0');

  if (!TOKEN || !CHAT_ID) {
    return res.status(500).json({ error: 'TELEGRAM_TOKEN or TELEGRAM_CHAT_ID not set' });
  }

  // 安全驗證：手動觸發需要 ?secret=xxx，Cron Job 由 Vercel 自動帶 header
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const manualSecret = req.query?.secret;

  if (!isVercelCron && manualSecret !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log(`[notify] triggered at ${new Date().toISOString()}`);

    // 計算 gap
    const alerts = await computeGaps(THRESHOLD);

    if (!alerts.length) {
      console.log(`[notify] no alerts (threshold: ${THRESHOLD}pp)`);
      return res.status(200).json({ sent: false, reason: 'no alerts', threshold: THRESHOLD });
    }

    // 發送 Telegram
    const message = formatMessage(alerts, THRESHOLD);
    await sendTelegram(TOKEN, CHAT_ID, message);

    console.log(`[notify] sent ${alerts.length} alerts`);
    return res.status(200).json({
      sent:    true,
      alerts:  alerts.length,
      sectors: alerts.map(a => a.sector),
    });

  } catch (err) {
    console.error('[notify] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
 
