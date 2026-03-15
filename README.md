# Jin10 — 金十快讯采集 + AI 分析

让你的 OpenClaw agent 自动采集金十快讯，支持搜索、时间线总结、事件追踪、健康监控。

## 架构

```
┌─────────────────────────────────────────┐
│  应用层（功能层的组合 + 自动化）           │
│  ├─ 事件追踪 = 搜索 + 总结               │
│  ├─ 关键词告警 = 搜索 + 推送              │
│  ├─ 定时推送 = 总结 + cron               │
│  └─ 热词统计 = 搜索 + 聚合               │
├─────────────────────────────────────────┤
│  功能层（原子能力）                       │
│  ├─ 快讯搜索（基础 + 高级）               │
│  ├─ 时间线总结（V7 简报）                 │
│  └─ 采集健康度查询                        │
├─────────────────────────────────────────┤
│  基础层                                  │
│  ├─ 金十 API 轮询（每15秒）              │
│  ├─ 内容清洗（HTML → 纯文本）            │
│  ├─ 过滤（广告/汇总/点击诱导/空内容）     │
│  └─ SQLite 存储                         │
└─────────────────────────────────────────┘
```

## 快速开始

```bash
# 1. 安装依赖
npm install better-sqlite3

# 2. 测试采集
node skills/jin10/scripts/collector.js --test

# 3. 后台启动采集
nohup node skills/jin10/scripts/collector.js > /tmp/jin10.log 2>&1 &

# 4. 对 agent 说
"过去 8 小时快讯总结"
```

## 功能层：三个开箱即用的原子能力

### 1. 快讯搜索

对 agent 说自然语言，或用 CLI：

```bash
# 基础搜索
node scripts/query.js --hours 8                          # 过去8小时
node scripts/query.js --today --important                # 今天重要快讯

# 高级搜索
node scripts/query.js --keyword "降息,加息"              # 多关键词 OR
node scripts/query.js --keyword "美联储" --keyword-and "降息"  # AND 组合
node scripts/query.js --channel 3 --hours 24             # 按频道（3=商品）
node scripts/query.js --exclude "点击查看"               # 排除词
node scripts/query.js --from "2026-03-14 22:00" --to "2026-03-15 08:00"  # 精确时间段

# 输出控制
--json / --brief / --count / --desc / --limit N
```

### 2. 时间线总结

对 agent 说：
- "过去 8 小时快讯总结"
- "昨晚发生了什么"
- "从昨天下午 3 点到现在的快讯"

Agent 拉取全量数据，去重后按时间线串联因果关系，生成包含导语、事件分析、综合判断的简报。

### 3. 采集健康度

```bash
node scripts/collector.js --health
```

输出：数据库总量、今日采集量、过去1小时采集量、总采集/跳过/失败次数、最近错误信息。

## 应用层：原子能力的组合

### 事件追踪
对 agent 说"帮我追踪一下原油的事件"，自动搜索相关关键词 + 生成专题时间线总结。

### 关键词告警

快讯入库时实时检查关键词，命中就通过 Webhook 推送。支持 Telegram、Discord、飞书、自定义 Webhook。

创建 `data/alerts.json`：

```json
[
  {
    "keyword": "特朗普,降息",
    "webhook": "https://discord.com/api/webhooks/ID/TOKEN",
    "format": "discord"
  },
  {
    "keyword": "黑天鹅,暴跌",
    "webhook": "https://api.telegram.org/bot<TOKEN>/sendMessage",
    "format": "telegram",
    "chatId": "123456"
  },
  {
    "keyword": "央行",
    "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
    "format": "feishu"
  },
  {
    "keyword": "紧急",
    "webhook": "https://your-server.com/alert",
    "format": "plain"
  }
]
```

**配置说明：**
- `keyword`：逗号分隔，任一命中即触发（OR 匹配）
- `format`：`telegram` / `discord` / `feishu`（飞书）/ `plain`（通用 JSON POST）
- `importantOnly`：可选，设为 `true` 只推送重要快讯
- 热加载：修改 alerts.json 后无需重启采集服务

### 定时推送
配合 cron，每天早上自动生成昨晚简报发到指定频道。

### 热词统计
统计过去 24 小时高频词，一眼看出市场焦点在哪。

## 基础层过滤规则

入库前自动排除：
- 广告（extras.ad=true）
- HTML 列表合集（section-news）
- 点击诱导（"点击查看…"）
- 汇总类（>1000字编号列表，是单条快讯的重复合并）
- 空内容 / 极短内容（<5字）

## 数据库

路径：`skills/jin10/data/jin10.db`（SQLite，自动创建）

**flash_news 表：**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 快讯唯一 ID |
| time | TEXT | 发布时间 (YYYY-MM-DD HH:MM:SS) |
| content | TEXT | 正文（纯文本，已清洗） |
| title | TEXT | 标题（部分有） |
| important | INTEGER | 0=普通 1=重要 |
| channels | TEXT | 频道 JSON [1]速报 [2]A股 [3]商品 [4]债券 [5]国际 |

**collector_stats 表：**

| 字段 | 说明 |
|------|------|
| polls | 总采集次数 |
| saves / skips / errors | 保存 / 跳过 / 失败次数 |
| last_poll | 最近采集时间 |
| last_error | 最近错误信息 |
| started_at | 采集服务启动时间 |

## macOS 开机自启

```bash
cat > ~/Library/LaunchAgents/com.openclaw.jin10.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openclaw.jin10</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>$(pwd)/skills/jin10/scripts/collector.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/jin10.log</string>
  <key>StandardErrorPath</key><string>/tmp/jin10.err</string>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.openclaw.jin10.plist
```

## 环境要求

- Node.js 18+
- better-sqlite3
- OpenClaw（任意版本）

## 数据源

金十快讯 (jin10.com)，公开 API，无需 Key。

## License

MIT
