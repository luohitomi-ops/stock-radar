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

// 監控所有熱門 20 族群（hot:true，與 index.html sectorData 同步）
const WATCH_SECTORS = [
  { sector:'台股 AI 伺服器 / ODM',        driveIndex:'SOX',  stocks:['2382.TW','2356.TW'] },
  { sector:'台股 CoWoS 先進封裝',          driveIndex:'SOX',  stocks:['2330.TW','3711.TW'] },
  { sector:'台股 AI 散熱 / 液冷',          driveIndex:'SOX',  stocks:['3017.TW','1590.TW'] },
  { sector:'台股 交換器 / 網通設備',        driveIndex:'SOX',  stocks:['2345.TW','3596.TW'] },
  { sector:'台股 IC 設計 / 繪圖晶片',      driveIndex:'SOX',  stocks:['2454.TW','2379.TW'] },
  { sector:'台股 ASIC / 客製晶片',         driveIndex:'SOX',  stocks:['2454.TW','3443.TW'] },
  { sector:'台股 ABF 載板 / PCB',          driveIndex:'SOX',  stocks:['3037.TW','8046.TWO'] },
  { sector:'台股 矽光子 / CPO',            driveIndex:'SOX',  stocks:['2330.TW','3711.TW'] },
  { sector:'台股 電力設備 / 變壓器',        driveIndex:'SOX',  stocks:['1519.TW','1513.TW'] },
  { sector:'台股 鴻海 / 代工龍頭',         driveIndex:'SPX',  stocks:['2317.TW','2357.TW'] },
  { sector:'台股 光學鏡頭',                driveIndex:'N225', stocks:['3008.TW','3406.TW'] },
  { sector:'台股 機器人 / 精密傳動',        driveIndex:'N225', stocks:['2049.TW','1590.TW'] },
  { sector:'台股 ETF / 大盤追蹤',          driveIndex:'SPX',  stocks:['0050.TW','2330.TW'] },
  { sector:'台股 壽險 / 金控',             driveIndex:'SPX',  stocks:['2882.TW','2881.TW'] },
  { sector:'台股 功率半導體 / 電源管理',    driveIndex:'N225', stocks:['6415.TW','8081.TW'] },
  { sector:'台股 HBM / 高頻寬記憶體',      driveIndex:'SOX',  stocks:['2408.TW','2344.TW'] },
  { sector:'台股 被動元件',                driveIndex:'SOX',  stocks:['2327.TW','2351.TW'] },
  { sector:'台股 NOR Flash / 利基記憶體',  driveIndex:'SOX',  stocks:['2337.TW','2344.TW'] },
  { sector:'台股 EV 充電樁 / 充電設備',    driveIndex:'N225', stocks:['2308.TW','2301.TW'] },
  { sector:'台股 貨櫃航運',                driveIndex:'SPX',  stocks:['2603.TW','2609.TW'] },
];

const VIX_SYMBOL = '^VIX';

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
  const result = data?.chart?.result?.[0];
  const meta   = result?.meta;
  if (!meta) throw new Error(`No meta for ${symbol}`);

  // 用 close series 最後兩根算 1 日報酬（避免 chartPreviousClose 是 5 天前的坑）
  const closes = result?.indicators?.quote?.[0]?.close?.filter(v => v != null);
  let chgPct;
  if (closes && closes.length >= 2) {
    const prev = closes[closes.length - 2];
    const last = closes[closes.length - 1];
    chgPct = ((last - prev) / prev) * 100;
  } else {
    // fallback：用 meta.previousClose（1日前），不用 chartPreviousClose（5日前）
    const price     = meta.regularMarketPrice;
    const prevClose = meta.previousClose;
    if (!price || !prevClose) throw new Error(`No price data for ${symbol}`);
    chgPct = ((price - prevClose) / prevClose) * 100;
  }

  const marketTime = meta.regularMarketTime ?? null;
  return { symbol, price: meta.regularMarketPrice, chgPct, marketTime };
}

// ── 批次取報價（並行，分批避免 rate limit，追蹤失敗）──
async function fetchAll(symbols, batchSize = 6, delayMs = 200) {
  const result = {};
  const failed = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    await Promise.all(batch.map(async sym => {
      try {
        result[sym] = await fetchQuote(sym);
      } catch (e) {
        console.warn(`fetchQuote failed: ${sym}`, e.message);
        result[sym] = null;
        failed.push(`${sym}(${e.message.slice(0, 40)})`);
      }
    }));
    if (i + batchSize < symbols.length) {
      await new Promise(r => setTimeout(r, delayMs));
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

// ── 從 Redis 取近期快照，計算各族群連續同向天數 ──
async function fetchStreaks(kvUrl, kvToken) {
  if (!kvUrl || !kvToken) return {};
  try {
    const keysRes  = await fetch(`${kvUrl}/keys/snapshot:2*`, {
      headers: { Authorization: `Bearer ${kvToken}` },
      signal: AbortSignal.timeout(5000),
    });
    const keysData = await keysRes.json();
    const keys = (keysData.result || [])
      .filter(k => /^snapshot:\d{4}-\d{2}-\d{2}$/.test(k))
      .sort()
      .slice(-5); // 只取最近 5 天

    if (!keys.length) return {};

    const pipeline = keys.map(k => ['GET', k]);
    const pipeRes  = await fetch(`${kvUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(5000),
    });
    const pipeData = await pipeRes.json();

    const days = [];
    keys.forEach((k, i) => {
      const val = pipeData[i]?.result;
      if (val) try { days.push({ date: k.replace('snapshot:', ''), snap: JSON.parse(val) }); } catch {}
    });
    days.sort((a, b) => a.date.localeCompare(b.date));

    const streaks = {};
    const allSectors = new Set(days.flatMap(d => Object.keys(d.snap)));
    for (const sector of allSectors) {
      const series = days.map(d => d.snap[sector]).filter(v => v !== undefined);
      if (!series.length) continue;
      const last = series[series.length - 1];
      let count = 1;
      for (let i = series.length - 2; i >= 0; i--) {
        if ((series[i] >= 0) === (last >= 0)) count++;
        else break;
      }
      streaks[sector] = { count, positive: last >= 0 };
    }
    return streaks;
  } catch (e) {
    console.warn('[notify] fetchStreaks failed:', e.message);
    return {};
  }
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
function formatMessage(alerts, threshold, streaks = {}, vixLevel = null, driveStatus = {}) {
  // 手動建構台灣時間字串，避免 zh-TW locale 在 Vercel 環境回傳錯誤日期
  const nowTW = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const pad = n => String(n).padStart(2, '0');
  const now = `${nowTW.getFullYear()}/${pad(nowTW.getMonth()+1)}/${pad(nowTW.getDate())} ${pad(nowTW.getHours())}:${pad(nowTW.getMinutes())}`;

  const lines = alerts.map(a => {
    const icon    = a.gap > 0 ? '🔴' : '🟢';
    const gapStr  = a.gap > 0 ? `+${a.gap}pp` : `${a.gap}pp`;
    const driveStr = `${a.driveName} ${a.driveChg > 0 ? '+' : ''}${a.driveChg}%`;
    const streak   = streaks[a.sector];
    const streakTag = streak && streak.count >= 2 ? ` ⚡連續${streak.count}日` : '';
    // 雙指數確認
    const SECONDARY = { SOX: 'SPX', SPX: 'SOX', N225: 'SPX' };
    const secKey  = SECONDARY[a.driveName];
    const secChg  = secKey ? parseFloat(driveStatus[secKey]?.chg) : null;
    const priDir  = a.driveChg >= 0;
    let confirmTag = '';
    if (secChg !== null && !isNaN(secChg)) {
      confirmTag = (secChg >= 0) === priDir
        ? ` ✅雙確認`
        : ` ⚠️單指數`;
    }
    return `${icon} <b>${a.sector.replace('台股 ', '')}${streakTag}${confirmTag}</b>\n   Gap: <b>${gapStr}</b>　驅動: ${driveStr}\n   預期: ${a.exp > 0 ? '+' : ''}${a.exp}%　實際: ${a.act > 0 ? '+' : ''}${a.act}%`;
  });

  const vixLine = vixLevel != null
    ? vixLevel >= 25
      ? `🛑 VIX ${vixLevel.toFixed(1)}（高恐慌）— 訊號可靠度低，建議觀望`
      : vixLevel >= 20
      ? `⚠️ VIX ${vixLevel.toFixed(1)}（偏高）— 需搭配量能確認`
      : null
    : null;

  return [
    `📡 <b>Stock Radar Gap 警示</b>`,
    `閾值 ±${threshold}pp 以上共 ${alerts.length} 個族群`,
    vixLine ? `\n${vixLine}` : '',
    ``,
    lines.join('\n\n'),
    ``,
    `⏰ ${now}`,
    `🔴 = 補漲空間　🟢 = 已超漲`,
    ``,
    driveContext(alerts),
  ].filter(x => x !== '').join('\n');
}

// ── 主 Handler ──
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 環境變數
  const TOKEN     = process.env.TELEGRAM_TOKEN;
  const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
  const SECRET    = process.env.NOTIFY_SECRET || 'stockradar2026';
  const THRESHOLD = parseFloat(process.env.GAP_THRESHOLD || '2.0');
  const kvUrl     = process.env.UPSTASH_REDIS_REST_URL;
  const kvToken   = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!TOKEN || !CHAT_ID) {
    return res.status(500).json({ error: 'TELEGRAM_TOKEN or TELEGRAM_CHAT_ID not set' });
  }

  // 安全驗證：手動觸發需要 ?secret=xxx，Cron Job 由 Vercel 自動帶 header
  // Vercel 2024+ 改用 Authorization: Bearer <CRON_SECRET>，舊版用 x-vercel-cron: 1
  const cronSecret   = process.env.CRON_SECRET;
  const authHeader   = req.headers['authorization'];
  // x-vercel-cron 可能是 '1' 或其他 truthy 值（不同 Vercel 版本不同）
  const isVercelCron = req.headers['x-vercel-cron'] !== undefined ||
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    authHeader === `Bearer ${SECRET}`; // fallback：用 NOTIFY_SECRET 也能當 cron auth
  const manualSecret = req.query?.secret;

  if (!isVercelCron && manualSecret !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log(`[notify] triggered at ${new Date().toISOString()}`);

    const { alerts, allGaps, failed, driveStatus } = await computeGaps(THRESHOLD);
    const streaks  = await fetchStreaks(kvUrl, kvToken);

    // VIX 絕對值（單獨抓，不影響 gap 計算）
    let vixLevel = null;
    try {
      const vq = await fetchQuote(VIX_SYMBOL);
      vixLevel = vq?.price ?? null;
    } catch { /* ignore */ }

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
      let message = formatMessage(alerts, THRESHOLD, streaks, vixLevel, driveStatus);
      if (failed.length || staleWarning.length) {
        const warn = [];
        if (staleWarning.length) warn.push(`⚠️ 數據可能過時：${staleWarning.join('/')} 超過 4 天未更新`);
        if (failed.length) warn.push(`⚠️ ${failed.length} 個 symbol 抓取失敗：${failed.join(', ')}`);
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
      failed.length ? `\n⚠️ ${failed.length} 個 symbol 抓取失敗：${failed.join(', ')}` : '',
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
 
