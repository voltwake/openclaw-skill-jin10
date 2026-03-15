#!/usr/bin/env node
/**
 * Jin10 关键词告警
 * 监控最近 N 秒的新快讯，匹配关键词后推送
 * 
 * 用法:
 *   node alert.js --keyword "特朗普" --seconds 120
 *   node alert.js --keyword "特朗普,降息" --seconds 60 --important-only
 *   node alert.js --help
 * 
 * 设计为 cron 定期调用，每次检查最近 N 秒的新快讯
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// --- 参数解析 ---
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Jin10 关键词告警

用法:
  node alert.js --keyword "关键词1,关键词2" [选项]

选项:
  --keyword <words>     关键词，逗号分隔（OR 匹配）
  --seconds <n>         检查最近 N 秒的快讯（默认 120）
  --important-only      只匹配重要快讯
  --json                JSON 格式输出
  --quiet               只输出匹配的内容（用于管道）
  --help                显示帮助

示例:
  node alert.js --keyword "特朗普" --seconds 120
  node alert.js --keyword "降息,加息,利率" --seconds 300
  node alert.js --keyword "黑天鹅,暴跌" --important-only
`);
  process.exit(0);
}

function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}

const keywords = (getArg('--keyword', '') || '').split(',').filter(Boolean);
const seconds = parseInt(getArg('--seconds', '120'));
const importantOnly = args.includes('--important-only');
const jsonOutput = args.includes('--json');
const quiet = args.includes('--quiet');

if (keywords.length === 0) {
  console.error('❌ 请指定 --keyword');
  process.exit(1);
}

// --- 数据库 ---
const dbPaths = [
  path.join(__dirname, '..', 'data', 'jin10.db'),
  path.join(process.cwd(), 'data', 'news-flash.db'),
];
const dbPath = dbPaths.find(p => fs.existsSync(p));
if (!dbPath) {
  console.error('❌ 数据库不存在');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

// --- 查询 ---
const since = new Date(Date.now() - seconds * 1000).toISOString().replace('T', ' ').slice(0, 19);

let sql = `SELECT id, time, content, important FROM flash_news WHERE time >= ?`;
if (importantOnly) sql += ` AND important = 1`;
sql += ` ORDER BY time ASC`;

const rows = db.prepare(sql).all(since);

// --- 关键词匹配 ---
const matched = rows.filter(row => {
  return keywords.some(kw => row.content.includes(kw));
});

db.close();

// --- 输出 ---
if (matched.length === 0) {
  if (!quiet) console.log(`✅ 最近 ${seconds}s 无匹配（关键词: ${keywords.join(',')}）`);
  process.exit(0);
}

if (jsonOutput) {
  console.log(JSON.stringify(matched, null, 2));
} else if (quiet) {
  matched.forEach(m => console.log(`[${m.time}] ${m.content}`));
} else {
  console.log(`🔔 匹配 ${matched.length} 条（关键词: ${keywords.join(',')}）\n`);
  matched.forEach(m => {
    const tag = m.important ? '⭐' : '  ';
    console.log(`${tag}[${m.time}] ${m.content.slice(0, 200)}`);
    console.log('');
  });
}
