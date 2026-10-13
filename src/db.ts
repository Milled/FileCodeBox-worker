import type { FileRecord } from './types';

/** 初始化数据库表（幂等，可多次调用） */
export async function initDB(db: D1Database): Promise<void> {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS fc_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT DEFAULT 'application/octet-stream',
      expire_at TEXT NOT NULL,
      download_count INTEGER DEFAULT 0,
      max_downloads INTEGER DEFAULT -1,
      created_at TEXT NOT NULL,
      ip TEXT DEFAULT ''
    )`,
    'CREATE INDEX IF NOT EXISTS idx_fc_code ON fc_files(code)',
    'CREATE INDEX IF NOT EXISTS idx_fc_expire ON fc_files(expire_at)',
    `CREATE TABLE IF NOT EXISTS fc_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ];
  const migrations = [
    'ALTER TABLE fc_files ADD COLUMN is_text INTEGER DEFAULT 0',
  ];
  for (const s of stmts) {
    try { await db.prepare(s).run(); } catch { /* ignore */ }
  }
  for (const m of migrations) {
    try { await db.prepare(m).run(); } catch { /* column already exists — ok */ }
  }

  // 取件码使用记录表：记录所有曾经使用过的取件码（含已过期/已删除），防止重复占用
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS fc_used_codes (
      code TEXT PRIMARY KEY
    )`).run();
  } catch { /* ignore */ }
}

// ---- 文件查询 ----

export async function getFileByCode(
  db: D1Database,
  code: string,
): Promise<FileRecord | null> {
  return db
    .prepare("SELECT * FROM fc_files WHERE code = ? AND datetime(expire_at) > datetime('now')")
    .bind(code)
    .first<FileRecord>();
}

export async function getFileById(
  db: D1Database,
  id: number,
): Promise<FileRecord | null> {
  return db.prepare('SELECT * FROM fc_files WHERE id = ?').bind(id).first<FileRecord>();
}

export async function isCodeTaken(db: D1Database, code: string): Promise<boolean> {
  // 单次查询：合并历史记录和活跃文件检查
  const row = await db
    .prepare(`
      SELECT 1 FROM fc_used_codes WHERE code = ?
      UNION ALL
      SELECT 1 FROM fc_files WHERE code = ? AND datetime(expire_at) > datetime('now')
      LIMIT 1
    `)
    .bind(code, code)
    .first();
  return row !== null;
}

/**
 * 原子抢占取件码：INSERT OR IGNORE + changes 判定。
 * 并发同码时仅一个请求返回 true，消除 check-then-act 竞态窗口。
 */
export async function claimCode(db: D1Database, code: string): Promise<boolean> {
  const result = await db
    .prepare('INSERT OR IGNORE INTO fc_used_codes(code) VALUES (?)')
    .bind(code)
    .run();
  return result.meta.changes === 1;
}

/** 释放取件码（删除/过期后允许复用） */
export async function releaseCode(db: D1Database, code: string): Promise<void> {
  await db.prepare('DELETE FROM fc_used_codes WHERE code = ?').bind(code).run();
}

// ---- 插入 ----

export async function insertFile(
  db: D1Database,
  file: {
    code: string;
    filename: string;
    size: number;
    mimeType: string;
    expireAt: string;
    maxDownloads: number;
    isText?: number;
    clientIp?: string;
  },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO fc_files(code, filename, size, mime_type, expire_at, max_downloads, created_at, ip, is_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      file.code,
      file.filename,
      file.size,
      file.mimeType,
      file.expireAt,
      file.maxDownloads,
      new Date().toISOString(),
      file.clientIp ?? '',
      file.isText ?? 0,
    )
    .run();
}

// ---- 下载计数 ----

export async function incrementDownload(
  db: D1Database,
  code: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE fc_files SET download_count = download_count + 1
       WHERE code = ? AND (max_downloads < 0 OR download_count < max_downloads)`,
    )
    .bind(code)
    .run();
  return result.meta.changes > 0;
}

// ---- 删除 ----

export async function deleteFileRecord(
  db: D1Database,
  id: number,
): Promise<FileRecord | null> {
  const file = await getFileById(db, id);
  if (file) {
    await db.prepare('DELETE FROM fc_files WHERE id = ?').bind(id).run();
    await releaseCode(db, file.code);
  }
  return file;
}

/**
 * 清理 fc_used_codes 中已无对应文件的记录（含已过期未清理的）。
 * 作为防御性清理：若某次删除中途失败导致 releaseCode 未执行，
 * 此函数可在下次 scheduled 时补清，防止取件码被永久占用。
 */
export async function cleanupUsedCodes(db: D1Database): Promise<number> {
  const result = await db
    .prepare(`
      DELETE FROM fc_used_codes
      WHERE code NOT IN (
        SELECT code FROM fc_files
      )
    `)
    .run();
  return result.meta?.changes ?? 0;
}

// ---- 分页 ----

/**
 * 分页 + 高级筛选（关键词 / 日期范围 / 排序）
 * sort 支持：newest（默认）/ oldest / largest / smallest / mostDownloaded / leastDownloaded
 */
export async function listFilesAdvanced(
  db: D1Database,
  page: number,
  size: number,
  keyword: string,
  dateFrom: string,
  dateTo: string,
  sort: string,
): Promise<{ files: FileRecord[]; total: number }> {
  const offset = (page - 1) * size;
  const kw = keyword.trim();
  const conditions: string[] = [];
  const bindArgs: (string | number)[] = [];

  if (kw) {
    conditions.push('filename LIKE ?');
    bindArgs.push(`%${kw}%`);
  }
  if (dateFrom) {
    conditions.push("date(created_at) >= ?");
    bindArgs.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("date(created_at) <= ?");
    bindArgs.push(dateTo);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortMap: Record<string, string> = {
    newest:    'id DESC',
    oldest:    'id ASC',
    largest:   'size DESC',
    smallest:  'size ASC',
    mostDownloaded: 'download_count DESC',
    leastDownloaded: 'download_count ASC',
  };
  const orderBy = sortMap[sort] ?? 'id DESC';

  const [rows, countRow] = await Promise.all([
    db
      .prepare(`SELECT * FROM fc_files ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .bind(...bindArgs, size, offset)
      .all<FileRecord>(),
    db
      .prepare(`SELECT COUNT(*) as count FROM fc_files ${where}`)
      .bind(...bindArgs)
      .first<{ count: number }>(),
  ]);
  return { files: rows.results ?? [], total: countRow?.count ?? 0 };
}

/** 仪表盘统计 */
export async function getDashboardStats(db: D1Database): Promise<{
  totalFiles: number;
  totalSize: number;
  todayCount: number;
  todaySize: number;
  yesterdayCount: number;
  yesterdaySize: number;
}> {
  const [total, today, yesterday] = await Promise.all([
    db
      .prepare('SELECT COUNT(*) as count, COALESCE(SUM(size),0) as size FROM fc_files')
      .first<{ count: number; size: number }>(),
    db
      .prepare("SELECT COUNT(*) as count, COALESCE(SUM(size),0) as size FROM fc_files WHERE date(created_at) = date('now')")
      .first<{ count: number; size: number }>(),
    db
      .prepare("SELECT COUNT(*) as count, COALESCE(SUM(size),0) as size FROM fc_files WHERE date(created_at) = date('now', '-1 day')")
      .first<{ count: number; size: number }>(),
  ]);
  return {
    totalFiles: total?.count ?? 0,
    totalSize: total?.size ?? 0,
    todayCount: today?.count ?? 0,
    todaySize: today?.size ?? 0,
    yesterdayCount: yesterday?.count ?? 0,
    yesterdaySize: yesterday?.size ?? 0,
  };
}

// ---- 过期清理 ----

export async function cleanupExpired(
  db: D1Database,
  bucket: R2Bucket,
): Promise<{ expiredCount: number; cleanedCodes: number }> {
  const expired = await db
    .prepare("SELECT * FROM fc_files WHERE datetime(expire_at) <= datetime('now')")
    .all<FileRecord>();
  const files = expired.results ?? [];
  if (files.length === 0) return { expiredCount: 0, cleanedCodes: 0 };

  // 批量删除 R2 对象（每批最多 1000 键），避免逐个请求的 RTT
  const keys = files.map((f) => `file:${f.code}`);
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }

  // 先删记录，再释放取件码（并行执行，释放顺序不影响结果）
  await db.prepare("DELETE FROM fc_files WHERE datetime(expire_at) <= datetime('now')").run();
  await Promise.all(files.map((f) => releaseCode(db, f.code)));

  const cleanedCodes = await cleanupUsedCodes(db);

  return { expiredCount: files.length, cleanedCodes };
}

// ---- 设置 ----

export async function getSetting(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM fc_settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(
  db: D1Database,
  key: string,
  value: string,
): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO fc_settings(key, value) VALUES(?, ?)')
    .bind(key, value)
    .run();
}

// ---- 速率限制（D1 存储） ----

const RATE_WINDOW = 60_000; // 60 秒窗口

/**
 * 检查并记录某类限流计数（登录/上传共用）。返回 true 表示允许继续，false 表示已限流。
 * 关键：无论是否通过，只要窗口未过期都会递增计数，
 *       防止攻击者在窗口重置后获得额外尝试次数。
 */
export async function checkRateLimit(
  db: D1Database,
  keyPrefix: string,
  ip: string,
  max: number,
): Promise<boolean> {
  const key = `${keyPrefix}:${ip}`;
  const now = Date.now();
  const raw = await getSetting(db, key);

  let count = 0;
  let windowStart = now;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { count: number; windowStart: number };
      if (now - parsed.windowStart < RATE_WINDOW) {
        count = parsed.count;
        windowStart = parsed.windowStart;
      }
    } catch { /* 损坏则重置 */ }
  }

  const newCount = count + 1;
  await setSetting(db, key, JSON.stringify({ count: newCount, windowStart }));

  return newCount <= max;
}

/**
 * 清理已过窗口的限流键，防止 fc_settings 表随访问 IP 无限增长。
 * 由 scheduled 定期调用；损坏记录一并清除。
 */
export async function cleanupRateLimitEntries(db: D1Database): Promise<number> {
  const rows = await db
    .prepare(
      "SELECT key, value FROM fc_settings WHERE key LIKE 'login_ratelimit:%' OR key LIKE 'upload_ratelimit:%'",
    )
    .all<{ key: string; value: string }>();
  const now = Date.now();
  let removed = 0;
  for (const row of rows.results ?? []) {
    try {
      const parsed = JSON.parse(row.value) as { windowStart: number };
      if (now - parsed.windowStart > RATE_WINDOW) {
        await db.prepare('DELETE FROM fc_settings WHERE key = ?').bind(row.key).run();
        removed++;
      }
    } catch {
      await db.prepare('DELETE FROM fc_settings WHERE key = ?').bind(row.key).run();
      removed++;
    }
  }
  return removed;
}

// ---- 孤儿 R2 对象清理 ----

/**
 * 列出 R2 中所有 file:* 前缀的对象，对比 D1 记录，删除孤儿对象。
 * 每批最多处理 1000 个键（R2 list 上限），超量时保留到下次 scheduled。
 */
export async function cleanupOrphanedR2Objects(
  db: D1Database,
  bucket: R2Bucket,
): Promise<{ scanned: number; removed: number }> {
  // cursor 翻页收集全部 file: 对象（4 位码全空间上限约 1 万个 ≈ 11 页），
  // 只扫首页会永久漏扫字典序靠后的 key
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: 'file:', cursor });
    objects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  const keys = objects.map((o) => o.key);
  if (keys.length === 0) return { scanned: 0, removed: 0 };

  // 批量查询 D1 中存在的取件码（D1 单条查询绑定变量上限 100）
  const BATCH = 100;
  const activeCodes = new Set<string>();
  for (let i = 0; i < keys.length; i += BATCH) {
    // R2 key 带 file: 前缀，D1 code 无前缀，查询前必须剥离
    const batch = keys.slice(i, i + BATCH).map((k) => k.replace('file:', ''));
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db
      .prepare(`SELECT code FROM fc_files WHERE code IN (${placeholders})`)
      .bind(...batch)
      .all<{ code: string }>();
    for (const row of rows.results ?? []) activeCodes.add(row.code);
  }

  // 删除孤儿对象（不在 D1 中的）。宽限期 1 小时：上传先写 R2 后写 D1，
  // 窗口内的正常对象无 D1 记录，过早清理会静默丢数据
  const GRACE_MS = 3_600_000;
  const now = Date.now();
  const orphans = objects
    .filter((o) => !activeCodes.has(o.key.replace('file:', '')) && now - o.uploaded.getTime() > GRACE_MS)
    .map((o) => o.key);
  if (orphans.length === 0) return { scanned: keys.length, removed: 0 };

  await Promise.all(orphans.map((k) => bucket.delete(k)));
  return { scanned: keys.length, removed: orphans.length };
}
