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
    // code 本身是 UNIQUE，已有自动索引；不再重复建 idx_fc_code
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
    // 取件码使用记录表：记录所有曾经使用过的取件码（含已过期/已删除），防止重复占用。
    // created_at 用于回收“抢了码却再没落文件”的泄漏（崩溃、参数校验失败等），
    // 没有它就只能把所有 used_codes 当成永久占用
    `CREATE TABLE IF NOT EXISTS fc_used_codes (
      code TEXT PRIMARY KEY,
      created_at TEXT
    )`,
    // 游客每日上传配额：4 位码只有 10,000 个，没有这层限制时单个 IP
    // 以 10 次/分钟就能在一天内把码池占满。按 IP + UTC 日期计数，Cron 清理旧天
    `CREATE TABLE IF NOT EXISTS fc_upload_quota (
      ip TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ip, day)
    )`,
  ];
  const migrations = [
    'ALTER TABLE fc_files ADD COLUMN is_text INTEGER DEFAULT 0',
    'ALTER TABLE fc_files ADD COLUMN has_thumb INTEGER DEFAULT 0',
    ADD_SESSION_COLUMN,
    // 必须在 ADD_SESSION_COLUMN 之后建，老库否则引用不存在的列
    'CREATE INDEX IF NOT EXISTS idx_chunk_session ON fc_chunk_uploads(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_chunk_created ON fc_chunk_uploads(created_at)',
    ADD_USED_CODES_TS,
  ];
  // 一次 batch 建完全部表/索引：Free 计划每次调用只有 50 个子请求，
  // initDB 每 30 分钟跑一次，不能在这里固定花掉十几次
  await db.batch(stmts.map((s) => db.prepare(s)));
  for (const m of migrations) {
    try {
      await db.prepare(m).run();
    } catch (e: any) {
      // 列已存在是正常情况；其他失败要留痕，别静默到后面才炸
      if (!/duplicate column/i.test(String(e?.message ?? e))) {
        console.error('initDB migration failed:', m, e);
      }
    }
  }
  // 老库的 used_codes 没有时间戳：统一记为“现在”，给部署瞬间正在上传的请求留出宽限期。
  // 之后 cleanupUsedCodes 只会回收超过宽限期、且没有对应文件/分片会话的记录
  try {
    await db.prepare('UPDATE fc_used_codes SET created_at = ? WHERE created_at IS NULL')
      .bind(new Date().toISOString())
      .run();
  } catch (e) {
    console.error('initDB used_codes backfill failed:', e);
  }
}

// ---- 文件查询 ----

export async function getFileByCode(
  db: D1Database,
  code: string,
): Promise<FileRecord | null> {
  // expire_at 统一是 ISO（UTC）字符串；直接比较可避免函数包列，保留索引/谓词能力
  return db
    .prepare('SELECT * FROM fc_files WHERE code = ? AND expire_at > ?')
    .bind(code, new Date().toISOString())
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
      SELECT 1 FROM fc_files WHERE code = ? AND expire_at > ?
      LIMIT 1
    `)
    .bind(code, code, new Date().toISOString())
    .first();
  return row !== null;
}

/**
 * 原子抢占取件码：INSERT OR IGNORE + changes 判定。
 * 并发同码时仅一个请求返回 true，消除 check-then-act 竞态窗口。
 */
export async function claimCode(db: D1Database, code: string): Promise<boolean> {
  const createdAt = new Date().toISOString();
  const insert = () =>
    db
      .prepare('INSERT OR IGNORE INTO fc_used_codes(code, created_at) VALUES (?, ?)')
      .bind(code, createdAt);
  try {
    return (await insert().run()).meta.changes === 1;
  } catch (e: any) {
    // 已部署的库可能还没跑过 initDB：就地补列，否则全新上传全部 500
    if (!/has no column named|no such column/i.test(String(e?.message ?? e))) throw e;
    try {
      await db.prepare(ADD_USED_CODES_TS).run();
    } catch (e2: any) {
      if (!/duplicate column/i.test(String(e2?.message ?? e2))) throw e2;
    }
    return (await insert().run()).meta.changes === 1;
  }
}

/** 释放取件码（删除/过期后允许复用） */
export function releaseCodeStatement(db: D1Database, code: string): D1PreparedStatement {
  return db.prepare('DELETE FROM fc_used_codes WHERE code = ?').bind(code);
}

export async function releaseCode(db: D1Database, code: string): Promise<void> {
  await releaseCodeStatement(db, code).run();
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
        SELECT code FROM fc_files WHERE code IN (${placeholders}) AND expire_at > ?
      `)
      .bind(...run, ...run, new Date().toISOString())
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
  const insert = db
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
    );
  // 插入与容量计数必须同一个事务：否则第二步失败会留下“有记录、无对象”的悬挂文件
  const adjust = adjustStorageUsedStatement(db, file.size);
  await db.batch(adjust ? [insert, adjust] : [insert]);
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
export function adjustStorageUsedStatement(db: D1Database, delta: number): D1PreparedStatement | null {
  if (!Number.isFinite(delta) || delta === 0) return null;
  return db
    .prepare(`
      INSERT INTO fc_settings(key, value) VALUES('storage_used', ?)
      ON CONFLICT(key) DO UPDATE SET value = CAST(
        MAX(0, CAST(COALESCE(fc_settings.value, '0') AS INTEGER) + ?) AS TEXT)
    `)
    .bind(String(delta), delta);
}

export async function adjustStorageUsed(db: D1Database, delta: number): Promise<void> {
  const stmt = adjustStorageUsedStatement(db, delta);
  if (stmt) await stmt.run();
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
const ADD_USED_CODES_TS = 'ALTER TABLE fc_used_codes ADD COLUMN created_at TEXT';
const CREATE_UPLOAD_QUOTA = `CREATE TABLE IF NOT EXISTS fc_upload_quota (
  ip TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
)`;

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
  // 片记录与会话行同一事务，避免只删掉一半留下孤儿 parts
  await db.batch([
    db.prepare('DELETE FROM fc_chunk_parts WHERE upload_id = ?').bind(uploadId),
    db.prepare('DELETE FROM fc_chunk_uploads WHERE upload_id = ?').bind(uploadId),
  ]);
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
export async function listStaleChunkTasks(
  db: D1Database,
  olderThanMs: number,
  limit = 5,
): Promise<ChunkTask[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  // LIMIT：每个会话 abort 要花数次子请求，一次 Cron 不能无限处理
  const rows = await db
    .prepare('SELECT * FROM fc_chunk_uploads WHERE created_at <= ? ORDER BY created_at LIMIT ?')
    .bind(cutoff, limit)
    .all<ChunkTask>();
  return rows.results ?? [];
}

// ---- 删除 ----

export async function deleteFileRecord(
  db: D1Database,
  id: number,
  knownFile?: FileRecord | null,
): Promise<FileRecord | null> {
  const file = knownFile ?? (await getFileById(db, id));
  if (!file) return null;
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM fc_files WHERE id = ?').bind(id),
    releaseCodeStatement(db, file.code),
  ];
  const adjust = adjustStorageUsedStatement(db, -file.size);
  if (adjust) stmts.push(adjust);
  // 记录、取件码、容量计数同一事务，避免删除中途失败留下半套状态
  await db.batch(stmts);
  return file;
}

/** 抢码后到落文件/分片行之间的保护期：单次上传最长 30s，1 小时足够覆盖重试与清理间隔 */
export const CODE_RESERVATION_GRACE_MS = 3_600_000;

/**
 * 回收“抢了码但没有对应文件/分片会话”的记录。
 *
 * 必须同时排除 fc_chunk_uploads：分片会话在 init 时就占码，直到 complete 才写 fc_files，
 * 只看 fc_files 会把正在上传的大文件码释放掉。
 * 必须带宽限期：单文件上传同样是“先抢码、写完 R2 才写 fc_files”，
 * 没有时间戳就无法区分“正在上传”和“泄漏”。老库由 initDB/本函数补时间戳。
 * 作为防御性清理，scheduled 每轮无条件执行，而不是只在有过期文件时执行。
 */
export async function cleanupUsedCodes(
  db: D1Database,
  olderThanMs = CODE_RESERVATION_GRACE_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const remove = () =>
    db
      .prepare(`
        DELETE FROM fc_used_codes
        WHERE code NOT IN (SELECT code FROM fc_files)
          AND code NOT IN (SELECT code FROM fc_chunk_uploads)
          AND created_at IS NOT NULL
          AND created_at <= ?
      `)
      .bind(cutoff);
  try {
    return (await remove().run()).meta?.changes ?? 0;
  } catch (e: any) {
    if (!/has no column named|no such column/i.test(String(e?.message ?? e))) throw e;
    try {
      await db.prepare(ADD_USED_CODES_TS).run();
    } catch (e2: any) {
      if (!/duplicate column/i.test(String(e2?.message ?? e2))) throw e2;
    }
    // 存量行没有时间戳：记为现在，本次不删，留一个宽限期防止误伤正在上传的请求
    await db.prepare('UPDATE fc_used_codes SET created_at = ? WHERE created_at IS NULL')
      .bind(new Date().toISOString())
      .run();
    return 0;
  }
}

/**
 * 游客每日上传配额：原子递增并返回是否仍在额度内。
 * 表缺失时自愈，部署后即使 Cron 还没跑也不会让上传全部 500。
 */
export async function consumeDailyUpload(
  db: D1Database,
  ip: string,
  max: number,
): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const run = () =>
    db
      .prepare(`
        INSERT INTO fc_upload_quota(ip, day, count) VALUES (?, ?, 1)
        ON CONFLICT(ip, day) DO UPDATE SET count = fc_upload_quota.count + 1
        RETURNING count
      `)
      .bind(ip, day)
      .first<{ count: number }>();
  try {
    const row = await run();
    return Number(row?.count ?? 0) <= max;
  } catch (e: any) {
    if (!/no such table/i.test(String(e?.message ?? e))) throw e;
    await db.prepare(CREATE_UPLOAD_QUOTA).run();
    const row = await run();
    return Number(row?.count ?? 0) <= max;
  }
}

/** complete 成功后保留 1 小时的回执：客户端丢响应重试时返回同一 code/size，而不是 404 */
export const CHUNK_RECEIPT_TTL_MS = 3_600_000;
export interface ChunkReceipt {
  code: string;
  filename: string;
  size: number;
}

function chunkReceiptKey(sessionId: string): string {
  return `chunk_receipt:${sessionId}`;
}

export async function saveChunkReceipt(
  db: D1Database,
  sessionId: string,
  receipt: ChunkReceipt,
): Promise<void> {
  await setSetting(db, chunkReceiptKey(sessionId), JSON.stringify({ ...receipt, at: Date.now() }));
}

export async function getChunkReceipt(
  db: D1Database,
  sessionId: string,
): Promise<ChunkReceipt | null> {
  const raw = await getSetting(db, chunkReceiptKey(sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ChunkReceipt> & { at?: number };
    if (
      typeof parsed.code !== 'string' ||
      typeof parsed.filename !== 'string' ||
      typeof parsed.size !== 'number' ||
      typeof parsed.at !== 'number' ||
      Date.now() - parsed.at > CHUNK_RECEIPT_TTL_MS
    ) {
      return null;
    }
    return { code: parsed.code, filename: parsed.filename, size: parsed.size };
  } catch {
    return null;
  }
}

/** 该 IP 在最近 activeMs 内创建的未完成分片会话数：限制并发会话，避免只 init 不传就刷码 */
export async function countActiveChunkSessions(
  db: D1Database,
  ip: string,
  activeMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - activeMs).toISOString();
  const row = await db
    .prepare(`
      SELECT COUNT(*) AS n FROM fc_chunk_uploads
      WHERE ip = ? AND created_at > ?
    `)
    .bind(ip, cutoff)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
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
  // created_at 存 UTC；后台日期选择器按中国时区（UTC+8）理解
  if (dateFrom) {
    conditions.push("date(created_at, '+8 hours') >= ?");
    bindArgs.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("date(created_at, '+8 hours') <= ?");
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
      // 后台“今日/昨日”按 UTC+8 统计；created_at 本身仍是 UTC
      .prepare("SELECT COUNT(*) as count, COALESCE(SUM(size),0) as size FROM fc_files WHERE date(created_at, '+8 hours') = date('now', '+8 hours')")
      .first<{ count: number; size: number }>(),
    db
      .prepare("SELECT COUNT(*) as count, COALESCE(SUM(size),0) as size FROM fc_files WHERE date(created_at, '+8 hours') = date('now', '+8 hours', '-1 day')")
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

/** 每轮最多处理多少过期文件；R2 批删 + DB batch + 计数要控制在子请求预算内 */
const CLEANUP_EXPIRED_LIMIT = 2000;

export async function cleanupExpired(
  db: D1Database,
  bucket: R2Bucket,
): Promise<{ expiredCount: number }> {
  const cutoff = new Date().toISOString();
  const expired = await db
    .prepare('SELECT * FROM fc_files WHERE expire_at <= ? ORDER BY expire_at LIMIT ?')
    .bind(cutoff, CLEANUP_EXPIRED_LIMIT)
    .all<FileRecord>();
  const files = expired.results ?? [];
  if (files.length === 0) return { expiredCount: 0 };

  // 批量删除 R2 对象（每批最多 1000 键），避免逐个请求的 RTT。
  // 缩略图是内容的第二份副本，必须与主文件同时销毁，否则过期后仍能看图
  const keys = files.flatMap((f) => [`file:${f.code}`, `thumb:${f.code}`]);
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }

  // 不在这里逐个 releaseCode：过期文件一多，N 次 D1 调用会直接撞上 Free 计划
  // 每次 50 个子请求的上限。cleanupUsedCodes 用一条 SQL 统一回收，
  // 并且在 scheduled/admin 清理里独立执行，不再依赖“本次确实有文件过期”。
  // 按 id 精确删除本轮选中的行，并和容量计数放同一个 batch；D1 每条 SQL 最多 100 个绑定参数
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < files.length; i += 100) {
    const ids = files.slice(i, i + 100).map((f) => f.id);
    stmts.push(
      db
        .prepare(`DELETE FROM fc_files WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(...ids),
    );
  }
  const adjust = adjustStorageUsedStatement(db, -files.reduce((s, f) => s + (f.size || 0), 0));
  if (adjust) stmts.push(adjust);
  await db.batch(stmts);

  return { expiredCount: files.length };
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

/** 一次查询多个设置键，避免首页/上传/后台为每个键各付一趟 D1 */
export async function getSettings(
  db: D1Database,
  keys: string[],
): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const placeholders = keys.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT key, value FROM fc_settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const row of rows.results ?? []) out[row.key] = row.value;
  return out;
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
 * 原子限流语句：读窗口、判断、递增在一条 UPSERT 里完成。
 * 旧的“先 SELECT 再 SET”在并发下会互相覆盖计数，攻击者并发发起 N 个请求时
 * 可以同时读到旧值并全部放行。
 */
function buildRateLimitStatement(
  db: D1Database,
  keyPrefix: string,
  ip: string,
  now = Date.now(),
): D1PreparedStatement {
  const key = `${keyPrefix}:${ip}`;
  const cutoff = now - RATE_WINDOW;
  return db
    .prepare(`
      INSERT INTO fc_settings(key, value)
      VALUES (?, json_object('count', 1, 'windowStart', ?))
      ON CONFLICT(key) DO UPDATE SET value = CASE
        WHEN json_valid(fc_settings.value)
         AND CAST(json_extract(fc_settings.value, '$.windowStart') AS INTEGER) > ?
        THEN json_object(
          'count', CAST(json_extract(fc_settings.value, '$.count') AS INTEGER) + 1,
          'windowStart', CAST(json_extract(fc_settings.value, '$.windowStart') AS INTEGER)
        )
        ELSE json_object('count', 1, 'windowStart', ?)
      END
      RETURNING value
    `)
    .bind(key, now, cutoff, now);
}

/** 解析原子限流语句的返回行 */
export function rateLimitAllowed(row: { value?: string } | null | undefined, max: number): boolean {
  try {
    const count = Number(JSON.parse(row?.value ?? '').count);
    return Number.isFinite(count) && count <= max;
  } catch {
    return false;
  }
}

/** 语句版本：分片路径要把「读窗口并递增」和「取会话」并进同一个 batch */
export function rateLimitStatementFor(
  db: D1Database,
  keyPrefix: string,
  ip: string,
): D1PreparedStatement {
  return buildRateLimitStatement(db, keyPrefix, ip);
}

/**
 * 检查并记录某类限流计数（登录/上传/查询共用）。返回 true 表示允许继续。
 * 无论是否通过都会递增，防止窗口重置后获得额外尝试次数。
 */
export async function checkRateLimit(
  db: D1Database,
  keyPrefix: string,
  ip: string,
  max: number,
): Promise<boolean> {
  const row = await buildRateLimitStatement(db, keyPrefix, ip).first<{ value: string }>();
  return rateLimitAllowed(row, max);
}

/**
 * 一条 SQL 清掉所有过期/损坏的限流键。
 * 逐行删除会按 IP 数量线性消耗子请求，几十个上传 IP 就能把一次 Cron 打爆；
 * 这里用 JSON1 直接在 SQL 里判断 windowStart。
 */
export async function cleanupRateLimitEntries(db: D1Database): Promise<number> {
  const cutoff = Date.now() - RATE_WINDOW;
  const result = await db
    .prepare(`
      DELETE FROM fc_settings
      WHERE (key LIKE 'login_ratelimit:%'
          OR key LIKE 'upload_ratelimit:%'
          OR key LIKE 'thumb_ratelimit:%'
          OR key LIKE 'code_ratelimit:%'
          OR key LIKE 'chunk_ratelimit:%'
          OR key LIKE 'chunk_meta_ratelimit:%'
          OR key LIKE 'lookup_ratelimit:%'
          OR key LIKE 'turnstile_ratelimit:%')
        AND (
          NOT json_valid(value)
          OR COALESCE(CAST(json_extract(value, '$.windowStart') AS INTEGER), 0) <= ?
        )
    `)
    .bind(cutoff)
    .run();
  let removed = result.meta?.changes ?? 0;

  // 每日上传配额的旧日期行也一起回收；保留今天和昨天便于排查
  try {
    const dayCutoff = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const quota = await db
      .prepare('DELETE FROM fc_upload_quota WHERE day < ?')
      .bind(dayCutoff)
      .run();
    removed += quota.meta?.changes ?? 0;
  } catch (e: any) {
    // 老库还没跑到 initDB 时表可能不存在，由下一次 Cron 再清
    if (!/no such table/i.test(String(e?.message ?? e))) throw e;
  }

  // 分片 complete 回执过期后回收
  const receipt = await db
    .prepare(`
      DELETE FROM fc_settings
      WHERE key LIKE 'chunk_receipt:%'
        AND COALESCE(CAST(json_extract(value, '$.at') AS INTEGER), 0) <= ?
    `)
    .bind(Date.now() - CHUNK_RECEIPT_TTL_MS)
    .run();
  removed += receipt.meta?.changes ?? 0;
  return removed;
}

// ---- 孤儿 R2 对象清理 ----

/** 每轮最多删多少个孤儿对象；剩余的下轮继续，避免一次 Cron 打满子请求预算 */
const CLEANUP_ORPHAN_DELETE_LIMIT = 2000;

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

  // 一次取回全部有效取件码，而不是按 100 个一批查。
  // 4 位码最多 10,000 行，读取成本远小于 100 次 D1 往返 ——
  // 后者在 Free 计划的 50 子请求上限下会让清理直接失败
  const rows = await db.prepare('SELECT code FROM fc_files').all<{ code: string }>();
  const activeCodes = new Set((rows.results ?? []).map((r) => r.code));

  // 删除孤儿对象（不在 D1 中的）。宽限期 1 小时：上传先写 R2 后写 D1，
  // 窗口内的正常对象无 D1 记录，过早清理会静默丢数据
  const GRACE_MS = 3_600_000;
  const now = Date.now();
  const orphanKeys = objects
    .filter((o) => !activeCodes.has(o.code) && now - o.uploaded.getTime() > GRACE_MS)
    .map((o) => o.key)
    .slice(0, CLEANUP_ORPHAN_DELETE_LIMIT);
  const removedSet = new Set(orphanKeys);
  // 顺带得出实测占用，供 scheduled 回写计数器做对账（不额外多扫一遍桶）。
  // 本轮没删的孤儿仍计入占用，避免为了“删不完”而把计数器压低。
  const usedBytes = objects.reduce((s, o) => s + (removedSet.has(o.key) ? 0 : o.size), 0);
  if (orphanKeys.length === 0) return { scanned: objects.length, removed: 0, usedBytes };

  // R2 的 delete 接受最多 1000 个键；逐个 delete 会同时撞上
  // 6 个并发连接和 Free 计划 50 子请求的上限
  for (let i = 0; i < orphanKeys.length; i += 1000) {
    await bucket.delete(orphanKeys.slice(i, i + 1000));
  }
  return { scanned: objects.length, removed: orphanKeys.length, usedBytes };
}
