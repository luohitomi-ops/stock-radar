/** 
 * api/notify.js  —  Vercel Serverless + Cron Job
 *
 * 觸發方式：
 *   1. Vercel Cron Job 每天 UTC 00:30（台灣 08:30）週一到週五（vercel.json 設定）
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

const BETA_MAP = { SOX: 0.8, SPX: 0.6, N225: 0.7 };

// 只監控熱門族群（避免 API 請求過多）
const WATCH_SECTORS = [
  { sector:'台股 AI 伺服器 / ODM',      driveIndex:'SOX', stocks:['2382.TW','2356.TW'] },
  { sector:'台股 CoWoS 先進封裝',        driveIndex:'SOX', stocks:['2330.TW','3711.TW'] },
  { sector:'台股 AI 散熱 / 液冷',        driveIndex:'SOX', stocks:['3017.TW','1590.TW'] },
  { sector:'台股 HBM / 高頻寬記憶體',    driveIndex:'SOX', stocks:['2408.TW','2344.TW'] },
  { sector:'台股 ABF 載板 / PCB',        driveIndex:'SOX', stocks:['3037.TW','8046.TWO'] },
  { sector:'台股 矽光子 / CPO',          driveIndex:'SOX', stocks:['2330.TW','3711.TW'] },
  { sector:'台股 交換器 / 網通設備',     driveIndex:'SOX', stocks:['2345.TW','3596.TW'] },
  { sector:'台股 IC 設計 / 繪圖晶片',    driveIndex:'SOX', stocks:['2454.TW','2379.TW'] },
  { sector:'台股 功率半導體 / 電源管理', driveIndex:'N225',stocks:['6415.TW','8081.TW'] },
  { sector:'台股 貨櫃航運',             driveIndex:'SPX', stocks:['2603.TW','2609.TW'] },
  { sector:'台股 壽險 / 金控',          driveIndex:'SPX', stocks:['2882.TW','2881.TW'] },
];

// ── Yahoo Finance 抓報價（含新鮮度資訊）──
async function fetchQuote(symbol) {
  // range=5d 比 2d 更容易取到有效資料，避免週末邊界問題
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
  const res  = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         'https://finance.yahoo.com/',
      'Origin':          'https://finance.yahoo.com',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`No meta for ${symbol}`);
  const price     = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose;
  if (!price || !prevClose) throw new Error(`No price data for ${symbol}`);
  const chgPct = ((price - prevClose) / prevClose) * 100;
  // regularMarketTime 用來驗證數據新鮮度（Unix timestamp）
  const marketTime = meta.regularMarketTime ?? null;
  return { symbol, price, chgPct, marketTime };
}

// ── 批次取報價（串行，追蹤失敗）──
async function fetchAll(symbols) {
  const result  = {};
  const failed  = [];
  for (const sym of symbols) {
    try {
      result[sym] = await fetchQuote(sym);
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn(`fetchQuote failed: ${sym}`, e.message);
      result[sym] = null;
      failed.push(`${sym}(${e.message.slice(0, 40)})`);
    }
  }
  return { quotes: result, failed };
}

// ── 驗證數據是否新鮮（最近 3 個交易日內）──
function isStaleData(marketTime) {
  if (!marketTime) return true;
  const diffDays = (Date.now() / 1000 - marketTime) / 86400;
  return diffDays > 4; // 週末最多差 3 天（週五→週一）
}

// ── 計算各族群 gap ──
async function computeGaps(threshold) {
  const allStockSyms = [...new Set(WATCH_SECTORS.flatMap(s => s.stocks))];
  const allDriveSyms = [...new Set(WATCH_SECTORS.map(s => DRIVE_SYMBOLS[s.driveIndex]))];
  const allSyms      = [...allStockSyms, ...allDriveSyms];

  const { quotes, failed } = await fetchAll(allSyms);

  // 驗證驅動指數是否有效
  const driveStatus = {};
  for (const [name, sym] of Object.entries(DRIVE_SYMBOLS)) {
    const q = quotes[sym];
    driveStatus[name] = q
      ? { chg: q.chgPct.toFixed(2), stale: isStaleData(q.marketTime) }
      : { chg: null, stale: true };
  }

  const alerts = [];
  const allGaps = []; // 收集全部 gap 供「無警示摘要」使用

  for (const sector of WATCH_SECTORS) {
    const driveSym = DRIVE_SYMBOLS[sector.driveIndex];
    const driveQ   = quotes[driveSym];
    if (!driveQ) continue;

    const stockChgs = sector.stocks
      .map(s => quotes[s]?.chgPct)
      .filter(v => v !== null && v !== undefined && !isNaN(v));
    if (!stockChgs.length) continue;

    const act  = stockChgs.reduce((a, b) => a + b, 0) / stockChgs.length;
    const beta = BETA_MAP[sector.driveIndex] ?? 0.6;
    const exp  = driveQ.chgPct * beta;
    const gap  = parseFloat((exp - act).toFixed(2));
    const entry = {
      sector:    sector.sector,
      gap,
      act:       parseFloat(act.toFixed(2)),
      exp:       parseFloat(exp.toFixed(2)),
      driveChg:  parseFloat(driveQ.chgPct.toFixed(2)),
      driveName: sector.driveIndex,
    };
    allGaps.push(entry);
    if (Math.abs(gap) >= threshold) alerts.push(entry);
  }

  alerts.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  allGaps.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

  return { alerts, allGaps, failed, driveStatus };
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

// ── 依驅動幅度判斷 Gap 可信度 ──
function driveContext(alerts) {
  const maxAbs = Math.max(...alerts.map(a => Math.abs(a.driveChg)));
  if (maxAbs >= 5)
    return `⚡ 驅動幅度異常（最大 ${maxAbs.toFixed(1)}%），可能有重大消息面（財報/Fed/政策），建議開盤前確認來源再操作`;
  if (maxAbs >= 3)
    return `📊 驅動幅度中等（最大 ${maxAbs.toFixed(1)}%），Gap 機會可信度普通，建議搭配開盤量能確認`;
  return `📉 驅動幅度偏小（${maxAbs.toFixed(1)}%），Gap 機會需特別確認是否有持續性`;
}

// ── 格式化通知訊息 ──
function formatMessage(alerts, threshold) {
  // 手動建構台灣時間字串，避免 zh-TW locale 在 Vercel 環境回傳錯誤日期
  const nowTW = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const pad = n => String(n).padStart(2, '0');
  const now = `${nowTW.getFullYear()}/${pad(nowTW.getMonth()+1)}/${pad(nowTW.getDate())} ${pad(nowTW.getHours())}:${pad(nowTW.getMinutes())}`;

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
    ``,
    driveContext(alerts),
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

    const { alerts, allGaps, failed, driveStatus } = await computeGaps(THRESHOLD);

    const nowTW = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const pad = n => String(n).padStart(2, '0');
    const now = `${nowTW.getFullYear()}/${pad(nowTW.getMonth()+1)}/${pad(nowTW.getDate())} ${pad(nowTW.getHours())}:${pad(nowTW.getMinutes())}`;

    // ── 情況 1：驅動指數全部拿不到 → 系統錯誤通知 ──
    const driveAllFailed = Object.values(driveStatus).every(d => d.chg === null);
    if (driveAllFailed) {
      const errMsg = [
        `⚠️ <b>Stock Radar 系統錯誤</b>`,
        `⏰ ${now}`,
        ``,
        `無法取得海外指數數據（SOX / SPX / N225 全部失敗）`,
        `可能原因：Yahoo Finance API 被封鎖 / Vercel 網路異常`,
        ``,
        failed.length ? `失敗清單（前 5）：\n${failed.slice(0,5).join('\n')}` : '',
        ``,
        `請手動查閱後操作，或至 Vercel Logs 確認錯誤詳情。`,
      ].filter(Boolean).join('\n');
      await sendTelegram(TOKEN, CHAT_ID, errMsg);
      console.error('[notify] drive indices all failed');
      return res.status(200).json({ sent: true, type: 'error', failed });
    }

    // ── 情況 2：數據有效但有部分失敗 → 附帶警告 ──
    const staleWarning = Object.entries(driveStatus)
      .filter(([, v]) => v.stale && v.chg !== null)
      .map(([k]) => k);

    // ── 情況 3：有 Gap 警示 → 正常發送 ──
    if (alerts.length) {
      let message = formatMessage(alerts, THRESHOLD);
      if (failed.length || staleWarning.length) {
        const warn = [];
        if (staleWarning.length) warn.push(`⚠️ 數據可能過時：${staleWarning.join('/')} 超過 4 天未更新`);
        if (failed.length) warn.push(`⚠️ ${failed.length} 個 symbol 抓取失敗`);
        message += `\n\n${warn.join('\n')}`;
      }
      await sendTelegram(TOKEN, CHAT_ID, message);
      console.log(`[notify] sent ${alerts.length} alerts`);
      return res.status(200).json({ sent: true, alerts: alerts.length, sectors: alerts.map(a => a.sector) });
    }

    // ── 情況 4：無警示（低於閾值）→ 發平靜摘要 ──
    const driveLines = Object.entries(driveStatus)
      .filter(([, v]) => v.chg !== null)
      .map(([k, v]) => `${k} ${parseFloat(v.chg) >= 0 ? '+' : ''}${v.chg}%`)
      .join('　');
    const top3 = allGaps.slice(0, 3).map(a =>
      `${a.gap > 0 ? '🔴' : '🟢'} ${a.sector.replace('台股 ','')}：${a.gap > 0 ? '+' : ''}${a.gap}pp`
    ).join('\n');
    const quietMsg = [
      `📊 <b>Stock Radar 今日掃描完成</b>`,
      `⏰ ${now}`,
      ``,
      `海外今日：${driveLines}`,
      ``,
      `無族群超過 ±${THRESHOLD}pp 閾值，市場今日平靜。`,
      top3 ? `\n最大 Gap（僅供參考）：\n${top3}` : '',
      failed.length ? `\n⚠️ ${failed.length} 個 symbol 抓取失敗` : '',
    ].filter(Boolean).join('\n');
    await sendTelegram(TOKEN, CHAT_ID, quietMsg);
    console.log(`[notify] quiet — no alerts above ${THRESHOLD}pp`);
    return res.status(200).json({ sent: true, type: 'quiet', allGaps: allGaps.length });

  } catch (err) {
    console.error('[notify] error:', err.message);
    // 即使 handler 崩潰也發 TG
    try {
      await sendTelegram(TOKEN, CHAT_ID,
        `🔴 <b>Stock Radar 執行錯誤</b>\n${err.message}\n請至 Vercel Logs 查詳情`);
    } catch { /* ignore */ }
    return res.status(500).json({ error: err.message });
  }
}
 
