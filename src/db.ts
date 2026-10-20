import type { ChunkTask, FileRecord } from './types';

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
    // 分片上传：会话与已传片分两张表。每片一行而不是把 etag 存成 JSON 数组，
    // 是因为前端会并发上传同一次会话的多片，JSON 的读改写会互相覆盖丢 etag
    `CREATE TABLE IF NOT EXISTS fc_chunk_uploads (
      upload_id TEXT PRIMARY KEY,
      session_id TEXT,
      code TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      part_size INTEGER NOT NULL,
      total_parts INTEGER NOT NULL,
      mime_type TEXT DEFAULT 'application/octet-stream',
      expire_at TEXT NOT NULL,
      max_downloads INTEGER DEFAULT -1,
      created_at TEXT NOT NULL,
      ip TEXT DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS fc_chunk_parts (
      upload_id TEXT NOT NULL,
      part_number INTEGER NOT NULL,
      etag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (upload_id, part_number)
    )`,
  ];
  const migrations = [
    'ALTER TABLE fc_files ADD COLUMN is_text INTEGER DEFAULT 0',
    'ALTER TABLE fc_files ADD COLUMN has_thumb INTEGER DEFAULT 0',
    ADD_SESSION_COLUMN,
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

/** 该取件码是否已有文件记录（含已过期的）。释放码之前必须查一次，否则会误放行复用 */
export async function hasFileRecord(db: D1Database, code: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS hit FROM fc_files WHERE code = ?').bind(code).first();
  return row !== null;
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

/**
 * 找一段连续且未被占用的 4 位取件码（多文件批次用），环形取模所以 9998 后面可以是 9999/0000。
 * 只查询、不抢占：真正的占用仍走上传时的 claimCode。预占会把 check-then-act 的窗口
 * 从毫秒拉长到「用户把 N 个文件传完」，中途 Cron 一跑就把码释放掉，反而重新制造撞码。
 */
export async function findCodeRun(db: D1Database, count: number): Promise<string[] | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = Math.floor(Math.random() * 10000);
    const run: string[] = [];
    for (let i = 0; i < count; i++) run.push(String((base + i) % 10000).padStart(4, '0'));
    const placeholders = run.map(() => '?').join(',');
    const taken = await db
      .prepare(`
        SELECT code FROM fc_used_codes WHERE code IN (${placeholders})
        UNION
        SELECT code FROM fc_files WHERE code IN (${placeholders}) AND datetime(expire_at) > datetime('now')
      `)
      .bind(...run, ...run)
      .all<{ code: string }>();
    if ((taken.results ?? []).length === 0) return run;
  }
  return null;
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
  // 新记录即新占用。计数器只在 insertFile / deleteFileRecord / cleanupExpired
  // 这三个唯一出入口上增减，避免漏记与重复记
  await adjustStorageUsed(db, file.size);
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

// ---- 已用空间计数器 ----

/**
 * 调整 storage_used 计数器（delta 可为负）。
 * 用 SQL 表达式做读改写而不是先查再写，避免并发上传互相覆盖计数；
 * 下限夹到 0，防止异常路径把计数器压成负数后配额形同虚设。
 */
export async function adjustStorageUsed(db: D1Database, delta: number): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  await db
    .prepare(`
      INSERT INTO fc_settings(key, value) VALUES('storage_used', ?)
      ON CONFLICT(key) DO UPDATE SET value = CAST(
        MAX(0, CAST(COALESCE(fc_settings.value, '0') AS INTEGER) + ?) AS TEXT)
    `)
    .bind(String(delta), delta)
    .run();
}

/** 当前计数器值；未初始化或对账前可能为 0 */
export async function getStorageUsed(db: D1Database): Promise<number> {
  const raw = await getSetting(db, 'storage_used');
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 对账：把计数器整体改写为 R2 实测值 */
export async function setStorageUsed(db: D1Database, bytes: number): Promise<void> {
  await setSetting(db, 'storage_used', String(Math.max(0, Math.floor(bytes))));
}

// ---- 缩略图 ----

/** 缩略图已写入 R2，标记记录以便页面输出 <img>（否则每次开页都会请求一个必然 404 的地址） */
export async function markThumb(db: D1Database, code: string): Promise<void> {
  const sql = 'UPDATE fc_files SET has_thumb = 1 WHERE code = ?';
  try {
    await db.prepare(sql).bind(code).run();
  } catch {
    // 老库还没补上 has_thumb 列（initDB 只由 Cron 触发，最长要等 30 分钟）。
    // 不就地补列的话缩略图会静默丢失，表现成「图片就是不显示预览」
    await db.prepare('ALTER TABLE fc_files ADD COLUMN has_thumb INTEGER DEFAULT 0').run();
    await db.prepare(sql).bind(code).run();
  }
}

// ---- 分片上传会话 ----

/**
 * session_id 是后加的一列。已部署的库里可能还没有它 —— initDB 只由 Cron 触发，
 * 最长要等 30 分钟才补列，期间第一次分片 init 必须自己补上，否则整个分片通道都是 500
 */
const ADD_SESSION_COLUMN = 'ALTER TABLE fc_chunk_uploads ADD COLUMN session_id TEXT';

export async function insertChunkTask(db: D1Database, t: ChunkTask): Promise<void> {
  const stmt = () =>
    db
      .prepare(
        `INSERT INTO fc_chunk_uploads(upload_id, session_id, code, filename, size, part_size, total_parts, mime_type, expire_at, max_downloads, created_at, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        t.upload_id, t.session_id, t.code, t.filename, t.size, t.part_size, t.total_parts,
        t.mime_type, t.expire_at, t.max_downloads, t.created_at, t.ip,
      );
  try {
    await stmt().run();
  } catch (e: any) {
    // 只补「列不存在」这一种失败，其余原样抛出，别让取件码冲突被掩盖成建列错误。
    // SQLite 对 INSERT 的说法是 "table X has no column named Y"，对 WHERE 才是 "no such column"
    if (!/has no column named|no such column/i.test(String(e?.message ?? e))) throw e;
    await db.prepare(ADD_SESSION_COLUMN).run();
    await stmt().run();
  }
}

/** 按客户端句柄取会话。句柄是服务端自生成的 32 位十六进制，不含 R2 的原始 uploadId */
export async function getChunkTaskBySession(db: D1Database, sessionId: string): Promise<ChunkTask | null> {
  const row = await getChunkTaskStatement(db, sessionId).first<ChunkTask>();
  return row ?? null;
}

/** 语句版本：分片路径要把「取会话」和「读限流窗口」并进同一次 batch */
export function getChunkTaskStatement(db: D1Database, sessionId: string): D1PreparedStatement {
  return db.prepare('SELECT * FROM fc_chunk_uploads WHERE session_id = ?').bind(sessionId);
}

export async function getChunkTask(db: D1Database, uploadId: string): Promise<ChunkTask | null> {
  return db.prepare('SELECT * FROM fc_chunk_uploads WHERE upload_id = ?').bind(uploadId).first<ChunkTask>();
}

/** 记录一片的 etag。重复上传同一片（客户端重试）用 REPLACE 覆盖，幂等 */
export async function saveChunkPart(db: D1Database, uploadId: string, partNumber: number, etag: string): Promise<void> {
  await saveChunkPartStatement(db, uploadId, partNumber, etag).run();
}

/** 语句版本：分片路径要把记账和限流写回塞进同一次 batch，见 chunkPut */
export function saveChunkPartStatement(db: D1Database, uploadId: string, partNumber: number, etag: string): D1PreparedStatement {
  return db
    .prepare('INSERT OR REPLACE INTO fc_chunk_parts(upload_id, part_number, etag, created_at) VALUES (?, ?, ?, ?)')
    .bind(uploadId, partNumber, etag, new Date().toISOString());
}

export async function listChunkParts(
  db: D1Database,
  uploadId: string,
): Promise<Array<{ part_number: number; etag: string }>> {
  const rows = await db
    .prepare('SELECT part_number, etag FROM fc_chunk_parts WHERE upload_id = ? ORDER BY part_number')
    .bind(uploadId)
    .all<{ part_number: number; etag: string }>();
  return rows.results ?? [];
}

export async function deleteChunkTask(db: D1Database, uploadId: string): Promise<void> {
  await db.prepare('DELETE FROM fc_chunk_parts WHERE upload_id = ?').bind(uploadId).run();
  await db.prepare('DELETE FROM fc_chunk_uploads WHERE upload_id = ?').bind(uploadId).run();
}

/**
 * 未完成会话声明的总字节数。
 * 配额预检要把它算进去：否则几个 300MB 的会话可以各自通过预检，最后合计爆掉。
 */
export async function getPendingChunkBytes(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(SUM(size), 0) AS pending FROM fc_chunk_uploads')
    .first<{ pending: number | string }>();
  const n = Number(row?.pending ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 全部进行中的会话，后台列表用（管理员要能立刻放弃，不能只等超时） */
export async function listChunkTasks(db: D1Database): Promise<Array<ChunkTask & { parts_done: number }>> {
  const rows = await db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM fc_chunk_parts p WHERE p.upload_id = u.upload_id) AS parts_done
       FROM fc_chunk_uploads u ORDER BY datetime(u.created_at) DESC`,
    )
    .all<ChunkTask & { parts_done: number }>();
  return rows.results ?? [];
}

/** 超时未完成的会话（供 cron abort，避免已传分片一直计费） */
export async function listStaleChunkTasks(db: D1Database, olderThanMs: number): Promise<ChunkTask[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = await db
    .prepare('SELECT * FROM fc_chunk_uploads WHERE datetime(created_at) <= datetime(?)')
    .bind(cutoff)
    .all<ChunkTask>();
  return rows.results ?? [];
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
    await adjustStorageUsed(db, -file.size);
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

  // 批量删除 R2 对象（每批最多 1000 键），避免逐个请求的 RTT。
  // 缩略图是内容的第二份副本，必须与主文件同时销毁，否则过期后仍能看图
  const keys = files.flatMap((f) => [`file:${f.code}`, `thumb:${f.code}`]);
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }

  // 先删记录，再释放取件码（并行执行，释放顺序不影响结果）
  await db.prepare("DELETE FROM fc_files WHERE datetime(expire_at) <= datetime('now')").run();
  await adjustStorageUsed(db, -files.reduce((s, f) => s + (f.size || 0), 0));
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
  await setSettingStatement(db, key, value).run();
}

/** 语句版本：可与别的写合成一次 batch */
export function setSettingStatement(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db.prepare('INSERT OR REPLACE INTO fc_settings(key, value) VALUES(?, ?)').bind(key, value);
}

// ---- 速率限制（D1 存储） ----

const RATE_WINDOW = 60_000; // 60 秒窗口

/**
 * 检查并记录某类限流计数（登录/上传共用）。返回 true 表示允许继续，false 表示已限流。
 * 关键：无论是否通过，只要窗口未过期都会递增计数，
 *       防止攻击者在窗口重置后获得额外尝试次数。
 */
/**
 * 限流窗口的纯计算部分：给分片路径用。
 * 那里「读窗口」要并进别的读、「写窗口」要并进别的写，中间还夹着一次 R2 写入，
 * 不能像 checkRateLimit 那样读一趟写一趟地串起来（每片多两趟往返）
 */
export function rateVerdict(
  raw: string | null,
  max: number,
  now = Date.now(),
): { allowed: boolean; value: string } {
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
  const next = count + 1;
  return { allowed: next <= max, value: JSON.stringify({ count: next, windowStart }) };
}

export async function checkRateLimit(
  db: D1Database,
  keyPrefix: string,
  ip: string,
  max: number,
): Promise<boolean> {
  const key = `${keyPrefix}:${ip}`;
  const raw = await getSetting(db, key);
  const verdict = rateVerdict(raw, max);
  await setSetting(db, key, verdict.value);
  return verdict.allowed;
}

/**
 * 清理已过窗口的限流键，防止 fc_settings 表随访问 IP 无限增长。
 * 由 scheduled 定期调用；损坏记录一并清除。
 */
export async function cleanupRateLimitEntries(db: D1Database): Promise<number> {
  const rows = await db
    .prepare(
      "SELECT key, value FROM fc_settings WHERE key LIKE 'login_ratelimit:%' OR key LIKE 'upload_ratelimit:%' OR key LIKE 'thumb_ratelimit:%' OR key LIKE 'code_ratelimit:%' OR key LIKE 'chunk_ratelimit:%'",
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
 * 列出 R2 中 file: / thumb: 前缀的对象，对比 D1 记录，删除孤儿对象。
 * 每批最多处理 1000 个键（R2 list 上限），超量时保留到下次 scheduled。
 */
export async function cleanupOrphanedR2Objects(
  db: D1Database,
  bucket: R2Bucket,
): Promise<{ scanned: number; removed: number; usedBytes: number }> {
  // cursor 翻页收集全部对象（4 位码全空间上限约 1 万个 ≈ 11 页 × 2 前缀），
  // 只扫首页会永久漏扫字典序靠后的 key
  const objects: Array<{ key: string; code: string; uploaded: Date; size: number }> = [];
  for (const prefix of ['file:', 'thumb:']) {
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix, cursor });
      objects.push(
        ...listed.objects.map((o) => ({
          key: o.key,
          // R2 key 带前缀，D1 code 无前缀，查询前必须剥离
          code: o.key.slice(prefix.length),
          uploaded: o.uploaded,
          size: o.size,
        })),
      );
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  if (objects.length === 0) return { scanned: 0, removed: 0, usedBytes: 0 };

  // 批量查询 D1 中存在的取件码（D1 单条查询绑定变量上限 100）；
  // 主文件与缩略图共用一个 code，先去重再查，省掉一半绑定量
  const BATCH = 100;
  const codes = [...new Set(objects.map((o) => o.code))];
  const activeCodes = new Set<string>();
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
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
  const orphanKeys = objects
    .filter((o) => !activeCodes.has(o.code) && now - o.uploaded.getTime() > GRACE_MS)
    .map((o) => o.key);
  const removedSet = new Set(orphanKeys);
  // 顺带得出实测占用，供 scheduled 回写计数器做对账（不额外多扫一遍桶）
  const usedBytes = objects.reduce((s, o) => s + (removedSet.has(o.key) ? 0 : o.size), 0);
  if (orphanKeys.length === 0) return { scanned: objects.length, removed: 0, usedBytes };

  await Promise.all(orphanKeys.map((k) => bucket.delete(k)));
  return { scanned: objects.length, removed: orphanKeys.length, usedBytes };
}
