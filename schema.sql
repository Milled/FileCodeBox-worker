-- FileCodeBox 表结构（对齐 src/db.ts 的 initDB()，全部语句幂等，可重复执行）
--
-- 用途：npm run provision 会在建好 D1 后自动执行本文件；
--       也可手动执行：npx wrangler d1 execute filecodebox-db --remote --file=./schema.sql
--
-- 为什么需要它：Worker 运行时的 initDB() 由 Cron 每 30 分钟触发，而 /api/init 需要管理员登录、
-- 登录又要读 fc_settings 表 —— 全新数据库因此存在「建表前无法登录、不登录又无法建表」的窗口。
-- provisioning 阶段先把表建好即可绕开。
--
-- 注意：旧库若缺少 is_text 列，由 initDB() 的 ALTER 语句补齐（本文件只负责新库一次成型）。

CREATE TABLE IF NOT EXISTS fc_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT DEFAULT 'application/octet-stream',
  expire_at TEXT NOT NULL,
  download_count INTEGER DEFAULT 0,
  max_downloads INTEGER DEFAULT -1,
  created_at TEXT NOT NULL,
  ip TEXT DEFAULT '',
  is_text INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_fc_code ON fc_files(code);
CREATE INDEX IF NOT EXISTS idx_fc_expire ON fc_files(expire_at);

CREATE TABLE IF NOT EXISTS fc_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fc_used_codes (
  code TEXT PRIMARY KEY
);
