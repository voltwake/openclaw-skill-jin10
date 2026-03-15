#!/usr/bin/env node
/**
 * query.js — 金十快讯查询（功能层）
 * 
 * 基础查询：
 *   node query.js --hours 8                        过去8小时
 *   node query.js --today                          今天所有
 *   node query.js --important --hours 24           过去24小时重要快讯
 * 
 * 高级搜索：
 *   node query.js --keyword "降息"                 关键词搜索
 *   node query.js --keyword "降息,加息" --hours 48  多关键词（OR）
 *   node query.js --keyword "美联储" --keyword-and "降息"  多关键词（AND）
 *   node query.js --from "2026-03-14 22:00" --to "2026-03-15 08:00"
 *   node query.js --channel 3                      按频道 [1]速报 [2]A股 [3]商品 [4]债券 [5]国际
 *   node query.js --exclude "点击查看"              排除关键词
 * 
 * 输出控制：
 *   node query.js --count                          只输出数量
 *   node query.js --json                           JSON 输出
 *   node query.js --brief                          精简输出（时间+首80字）
 *   node query.js --limit 50                       限制条数
 *   node query.js --desc                           倒序（最新在前）
 */

const path = require('path');
const fs = require('fs');

const SKILL_DIR = path.join(__dirname, '..');

function findDB() {
  const paths = [
    process.env.DB_PATH,
    path.join(SKILL_DIR, 'data', 'jin10.db'),
    path.join(SKILL_DIR, '..', '..', 'data', 'news-flash.db'),
  ].filter(Boolean);
  
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  console.error('❌ 数据库不存在。请先运行 collector.js');
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 500, keywords: [], keywordsAnd: [], excludes: [] };
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--hours': opts.hours = parseFloat(args[++i]); break;
      case '--from': opts.from = args[++i]; break;
      case '--to': opts.to = args[++i]; break;
      case '--keyword': opts.keywords.push(...args[++i].split(',')); break;
      case '--keyword-and': opts.keywordsAnd.push(args[++i]); break;
      case '--exclude': opts.excludes.push(args[++i]); break;
      case '--channel': opts.channel = parseInt(args[++i]); break;
      case '--important': opts.important = true; break;
      case '--today': opts.today = true; break;
      case '--count': opts.count = true; break;
      case '--json': opts.json = true; break;
      case '--brief': opts.brief = true; break;
      case '--desc': opts.desc = true; break;
      case '--limit': opts.limit = parseInt(args[++i]); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1]
          .split('\n').map(l => l.replace(/^ \* ?/, '')).join('\n'));
        process.exit(0);
    }
  }
  
  if (!opts.hours && !opts.from && !opts.today && opts.keywords.length === 0 && !opts.important) {
    opts.hours = 8;
  }
  return opts;
}

function main() {
  const opts = parseArgs();
  const dbPath = findDB();
  
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  
  let where = ["content != ''", "length(content) > 10"];
  let params = {};
  
  if (opts.hours) {
    where.push(`time >= datetime('now', '-${opts.hours} hours', 'localtime')`);
  }
  if (opts.from) { where.push("time >= @from"); params.from = opts.from; }
  if (opts.to) { where.push("time <= @to"); params.to = opts.to; }
  if (opts.today) { where.push("date(time) = date('now', 'localtime')"); }
  if (opts.important) { where.push("important = 1"); }
  
  // OR 关键词
  if (opts.keywords.length > 0) {
    const kws = opts.keywords.map((kw, i) => {
      params[`kw${i}`] = `%${kw.trim()}%`;
      return `content LIKE @kw${i}`;
    });
    where.push(`(${kws.join(' OR ')})`);
  }
  
  // AND 关键词
  for (let i = 0; i < opts.keywordsAnd.length; i++) {
    params[`kwand${i}`] = `%${opts.keywordsAnd[i].trim()}%`;
    where.push(`content LIKE @kwand${i}`);
  }
  
  // 排除
  for (let i = 0; i < opts.excludes.length; i++) {
    params[`exc${i}`] = `%${opts.excludes[i].trim()}%`;
    where.push(`content NOT LIKE @exc${i}`);
  }
  
  // 频道
  if (opts.channel) {
    params.ch = `%${opts.channel}%`;
    where.push("channels LIKE @ch");
  }
  
  const order = opts.desc ? 'DESC' : 'ASC';
  const sql = `SELECT time, content, title, source, important, type, channels, tags
    FROM flash_news WHERE ${where.join(' AND ')} ORDER BY time ${order} LIMIT ${opts.limit}`;
  
  const rows = db.prepare(sql).all(params);
  
  if (opts.count) {
    console.log(rows.length);
    db.close();
    return;
  }
  
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    db.close();
    return;
  }
  
  console.log(`📋 ${rows.length} 条快讯\n`);
  
  for (const r of rows) {
    const tag = r.important ? '⭐' : '  ';
    if (opts.brief) {
      console.log(`${tag}[${r.time}] ${r.content.slice(0, 80)}`);
    } else {
      const title = r.title ? ` 【${r.title}】` : '';
      console.log(`${tag}[${r.time}]${title}`);
      console.log(`  ${r.content.slice(0, 300)}`);
      console.log('');
    }
  }
  
  db.close();
}

main();
