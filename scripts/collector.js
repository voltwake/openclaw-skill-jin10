#!/usr/bin/env node
/**
 * collector.js — 金十快讯采集服务（基础层）
 * 
 * 职责：轮询金十 API → 清洗内容 → 过滤广告/汇总 → 写入 SQLite
 * 
 * 用法：
 *   node collector.js                # 启动常驻采集
 *   node collector.js --test         # 拉一次看数据质量
 *   node collector.js --stats        # 数据库统计
 *   node collector.js --health       # 健康检查
 * 
 * 环境变量：
 *   POLL_INTERVAL=15    轮询间隔秒数（默认15）
 *   DB_PATH=...         自定义数据库路径
 *   DRY_RUN=1           只打印不入库
 */

const https = require('https');
const path = require('path');
const fs = require('fs');

// === 路径 ===
const SKILL_DIR = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(SKILL_DIR, 'data', 'jin10.db');

// === 金十 API ===
const JIN10 = {
  hostname: 'flash-api.jin10.com',
  path: '/get_flash_list?channel=-8200&vip=1',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    'x-app-id': 'bVBF4FyRTn5NJF5n',
    'x-version': '1.0.0'
  }
};

// === 内容清洗 ===
function cleanHTML(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .trim();
}

// === 过滤规则（基础层核心：排除无价值内容）===
function shouldSkip(item) {
  // 1. 广告
  if (item.extras?.ad === true) return 'ad';
  
  // 2. HTML 列表/合集（section-news 等）
  const raw = item.data?.content || '';
  if (raw.includes('section-news')) return 'html-list';
  
  // 3. 内容为空或太短
  const content = cleanHTML(raw);
  if (!content || content.length < 5) return 'empty';
  
  // 4. 纯链接诱导（"点击查看…""点击查看..."）
  if (/^.{0,30}点击查看[…\.]{1,3}$/.test(content)) return 'click-bait';
  if (content.length < 30 && /点击查看/.test(content)) return 'click-bait';
  
  // 5. 汇总类快讯（>1000字 且 带编号列表格式）
  if (content.length > 1000 && /^[①②③④⑤\d]+[.、)）]/.test(content)) return 'summary-digest';
  if (content.length > 1000 && /\n[①②③]/.test(content)) return 'summary-digest';
  
  return null; // 保留
}

// === SQLite ===
let db;
function initDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  let Database;
  try { Database = require('better-sqlite3'); } catch (e) {
    console.error('❌ npm install better-sqlite3');
    process.exit(1);
  }
  
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS flash_news (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      content TEXT NOT NULL,
      title TEXT DEFAULT '',
      source TEXT DEFAULT '',
      important INTEGER DEFAULT 0,
      type INTEGER DEFAULT 0,
      channels TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_time ON flash_news(time DESC);
    CREATE INDEX IF NOT EXISTS idx_important ON flash_news(important);
    CREATE INDEX IF NOT EXISTS idx_content ON flash_news(content);
    
    CREATE TABLE IF NOT EXISTS collector_stats (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      polls INTEGER DEFAULT 0,
      saves INTEGER DEFAULT 0,
      skips INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      last_poll TEXT,
      last_error TEXT,
      started_at TEXT
    );
    INSERT OR IGNORE INTO collector_stats (id, polls, saves, skips, errors, started_at)
      VALUES (1, 0, 0, 0, 0, datetime('now', 'localtime'));
  `);
  return db;
}

// === 网络请求 ===
function fetchJin10() {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: JIN10.hostname, path: JIN10.path,
      headers: JIN10.headers, timeout: 10000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 200 && Array.isArray(json.data)) resolve(json.data);
          else reject(new Error(`Jin10 status=${json.status}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// === 入库 ===
function save(item) {
  const content = cleanHTML(item.data?.content || '');
  db.prepare(`INSERT OR IGNORE INTO flash_news (id,time,content,title,source,important,type,channels,tags)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    item.id, item.time || '', content,
    (item.data?.title || '').trim(), item.data?.source || '',
    item.important || 0, item.type || 0,
    JSON.stringify(item.channel || []), JSON.stringify(item.tags || [])
  );
}

// === 轮询 ===
let seenIds = new Set();
let stats = { polls: 0, saved: 0, skipped: 0, errors: 0 };

async function poll() {
  stats.polls++;
  try {
    const items = await fetchJin10();
    let newSaved = 0, newSkipped = 0;
    
    for (const item of items) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      
      const skipReason = shouldSkip(item);
      if (skipReason) {
        newSkipped++;
        stats.skipped++;
        continue;
      }
      
      if (!process.env.DRY_RUN) save(item);
      newSaved++;
      stats.saved++;
    }
    
    if (newSaved > 0 || newSkipped > 0) {
      console.log(`[${new Date().toLocaleTimeString()}] +${newSaved} saved, ${newSkipped} skipped | total: ${seenIds.size}`);
    }
    
    // 持久化统计
    if (db) {
      db.prepare(`UPDATE collector_stats SET polls=polls+1, saves=saves+@s, skips=skips+@k, last_poll=datetime('now','localtime') WHERE id=1`)
        .run({ s: newSaved, k: newSkipped });
    }
    
    if (seenIds.size > 5000) seenIds = new Set([...seenIds].slice(-2000));
  } catch (e) {
    stats.errors++;
    if (stats.errors % 10 === 1) console.error(`[ERR #${stats.errors}] ${e.message}`);
    if (db) {
      try {
        db.prepare(`UPDATE collector_stats SET polls=polls+1, errors=errors+1, last_error=@err WHERE id=1`)
          .run({ err: `${new Date().toISOString()} ${e.message}` });
      } catch (_) {}
    }
  }
}

// === CLI ===
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--test')) {
    const items = await fetchJin10();
    let saved = 0, skipped = 0;
    for (const item of items) {
      const reason = shouldSkip(item);
      if (reason) {
        console.log(`  ⛔ [${reason}] ${cleanHTML(item.data?.content || '').slice(0, 60)}`);
        skipped++;
      } else {
        const tag = item.important ? '⭐' : '  ';
        console.log(`  ${tag} [${item.time}] ${cleanHTML(item.data?.content || '').slice(0, 80)}`);
        saved++;
      }
    }
    console.log(`\nTotal: ${items.length} | Keep: ${saved} | Skip: ${skipped}`);
    return;
  }
  
  initDB();
  
  if (args.includes('--stats') || args.includes('--health')) {
    const total = db.prepare('SELECT COUNT(*) as c FROM flash_news').get().c;
    const imp = db.prepare('SELECT COUNT(*) as c FROM flash_news WHERE important=1').get().c;
    const today = db.prepare("SELECT COUNT(*) as c FROM flash_news WHERE date(time)=date('now','localtime')").get().c;
    const first = db.prepare('SELECT MIN(time) as t FROM flash_news').get().t;
    const last = db.prepare('SELECT MAX(time) as t FROM flash_news').get().t;
    const size = fs.existsSync(DB_PATH) ? (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1) : '0';
    
    console.log(`📊 Jin10 Database`);
    console.log(`   Records: ${total} (important: ${imp}) | Today: ${today}`);
    console.log(`   Range: ${first || 'empty'} ~ ${last || 'empty'}`);
    console.log(`   Size: ${size} MB | Path: ${DB_PATH}`);
    
    if (args.includes('--health')) {
      // 最近入库时间
      if (last) {
        const ago = (Date.now() - new Date(last + '+08:00').getTime()) / 60000;
        const status = ago > 5 ? '⚠️ STALE' : ago > 2 ? '🟡 SLOW' : '✅ OK';
        console.log(`   Health: ${status} (last entry ${ago.toFixed(0)} min ago)`);
      } else {
        console.log(`   Health: ❌ EMPTY (no data)`);
      }
      
      // 过去1小时采集量
      const lastHour = db.prepare("SELECT COUNT(*) as c FROM flash_news WHERE time >= datetime('now', '-1 hour', 'localtime')").get().c;
      const lastHourImp = db.prepare("SELECT COUNT(*) as c FROM flash_news WHERE time >= datetime('now', '-1 hour', 'localtime') AND important=1").get().c;
      console.log(`   Last 1h: ${lastHour} entries (${lastHourImp} important)`);
      
      // 采集统计（从 collector_stats 表读）
      try {
        const cs = db.prepare('SELECT * FROM collector_stats WHERE id=1').get();
        if (cs) {
          console.log(`   Collector: ${cs.polls} polls, ${cs.saves} saved, ${cs.skips} skipped, ${cs.errors} errors`);
          if (cs.started_at) console.log(`   Running since: ${cs.started_at}`);
          if (cs.last_error) console.log(`   Last error: ${cs.last_error}`);
        }
      } catch (_) {
        console.log(`   Collector: no stats yet (start collector first)`);
      }
    }
    db.close();
    return;
  }
  
  // 常驻采集
  const interval = parseInt(process.env.POLL_INTERVAL || '15') * 1000;
  console.log(`🚀 Jin10 Collector`);
  console.log(`   Interval: ${interval/1000}s | DB: ${DB_PATH}`);
  console.log(`   Filter: ads, html-lists, click-bait, summary-digests\n`);
  
  try {
    const rows = db.prepare('SELECT id FROM flash_news ORDER BY time DESC LIMIT 500').all();
    for (const r of rows) seenIds.add(r.id);
    console.log(`   Loaded ${seenIds.size} existing IDs\n`);
  } catch (e) {}
  
  await poll();
  setInterval(poll, interval);
  
  const stop = () => {
    console.log(`\n🛑 Saved: ${stats.saved} | Skipped: ${stats.skipped} | Errors: ${stats.errors}`);
    db?.close(); process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
