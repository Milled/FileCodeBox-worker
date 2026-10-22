/**
 * 共享业务逻辑：供 src/index.ts 和 src/api.ts 共同使用，
 * 避免两套路由体系维护同一份上传/下载/过期处理代码。
 */
import type { Context } from 'hono';
import type { Env } from './types';
import type { FileRecord } from './types';
import { isValidCode, generateCode, getClientIp, formatFileSize } from './utils';
import { adminAuth } from './auth';
import {
  getFileByCode,
  findCodeRun,
  isCodeTaken,
  claimCode,
  insertFile,
  incrementDownload,
  markThumb,
  releaseCode,
  checkRateLimit,
  getPendingChunkBytes,
  getSetting,
  getStorageUsed,
} from './db';

// ===================== 运行时上限 =====================

/** 100MB，与 wrangler.jsonc 的 MAX_FILE_SIZE 默认值一致 */
export const FALLBACK_MAX_FILE_SIZE = 104857600;
const FALLBACK_EXPIRE_DAYS = 7;
const MAX_EXPIRE_DAYS = 3650;
const MAX_DOWNLOADS = 1_000_000;
/** 失败取件码查询：每 IP 每分钟最多 5 次，超过后连正常查询也先停一分钟 */
export const LOOKUP_RATE_MAX = 5;
export const LOOKUP_RATE_MESSAGE = '查询失败次数过多，请稍后再试';

/**
 * 解析当前生效的文件大小上限与默认过期天数。
 * 管理员后台 PATCH /api/admin/config/update 写入 fc_settings 的值优先于 wrangler vars，
 * 两者都缺失或非法（非正整数）时回退到内置默认，避免 NaN 导致校验被绕过。
 */
export async function resolveLimits(
  env: Env,
): Promise<{ maxSize: number; defaultExpireDays: number; maxTotalStorage: number }> {
  const positiveInt = (v: string | null | undefined): number => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const [dbMaxSize, dbExpireDays, dbMaxTotal] = await Promise.all([
    getSetting(env.DB, 'max_file_size'),
    getSetting(env.DB, 'default_expire_days'),
    getSetting(env.DB, 'max_total_storage'),
  ]);

  return {
    maxSize: positiveInt(dbMaxSize) || positiveInt(env.MAX_FILE_SIZE) || FALLBACK_MAX_FILE_SIZE,
    // 后台/变量值也夹到 3650 天：否则一个错误的默认值会让所有未显式指定有效期的上传
    // 在构造 Date 时越界，表现为全站上传 500
    defaultExpireDays: Math.min(
      MAX_EXPIRE_DAYS,
      positiveInt(dbExpireDays) || positiveInt(env.DEFAULT_EXPIRE_DAYS) || FALLBACK_EXPIRE_DAYS,
    ),
    // 总占用上限：0 = 不限制（清空后台设置即回到不限）
    maxTotalStorage: positiveInt(dbMaxTotal),
  };
}

// ===================== 过期策略 =====================

export function parseExpire(
  expireValue: number,
  expireStyle: string,
): { expireAt: string; maxDownloads: number } {
  const now = Date.now();
  switch (expireStyle) {
    case 'hour':
      return { expireAt: new Date(now + expireValue * 3_600_000).toISOString(), maxDownloads: -1 };
    case 'minute':
      return { expireAt: new Date(now + expireValue * 60_000).toISOString(), maxDownloads: -1 };
    case 'count':
      // 按下载次数过期：expireValue 为最大下载次数，过期时间用默认天数兜底
      return { expireAt: new Date(now + 30 * 86_400_000).toISOString(), maxDownloads: expireValue };
    case 'forever':
      return { expireAt: new Date(now + 100 * 365 * 86_400_000).toISOString(), maxDownloads: -1 };
    case 'day':
    default:
      return { expireAt: new Date(now + expireValue * 86_400_000).toISOString(), maxDownloads: -1 };
  }
}

const EXPIRE_MAX: Record<string, number> = {
  day: MAX_EXPIRE_DAYS,
  hour: MAX_EXPIRE_DAYS * 24,
  minute: MAX_EXPIRE_DAYS * 24 * 60,
  count: MAX_DOWNLOADS,
  forever: Number.POSITIVE_INFINITY,
};

/**
 * 解析并校验用户的过期/次数参数。必须在抢占取件码之前调用：
 * 这里抛 422 时还没有占用任何码，旧代码把 parseExpire 放在抢码之后，
 * 超大数值会先占码再抛 RangeError，把码永久泄漏。
 *
 * 未知单位、0/负数、超过 3650 天（或 100 万次）都明确拒绝，
 * 不再静默回退或生成一个已经过期的文件。
 */
export function resolveExpire(args: {
  value?: unknown;
  style?: unknown;
  maxDownloads?: unknown;
  defaultDays: number;
}): { expireAt: string; maxDownloads: number } {
  const style = typeof args.style === 'string' && args.style ? args.style : 'day';
  const max = EXPIRE_MAX[style];
  if (max === undefined) {
    throw { status: 422 as const, message: '不支持的有效期单位' };
  }

  let value = 1;
  if (style !== 'forever') {
    const raw =
      args.value === undefined || args.value === null || String(args.value).trim() === ''
        ? args.defaultDays
        : args.value;
    value = parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(value) || value < 1 || value > max) {
      throw {
        status: 422 as const,
        message:
          style === 'count'
            ? `查看次数需为 1 到 ${MAX_DOWNLOADS} 之间的整数`
            : `有效期数值需为 1 到 ${max} 之间的整数`,
      };
    }
  }

  let explicitMax = -1;
  const maxRaw = args.maxDownloads;
  if (maxRaw !== undefined && maxRaw !== null && String(maxRaw).trim() !== '') {
    explicitMax = parseInt(String(maxRaw).trim(), 10);
    if (!Number.isFinite(explicitMax) || explicitMax < -1 || explicitMax === 0 || explicitMax > MAX_DOWNLOADS) {
      throw {
        status: 422 as const,
        message: `最大下载次数需为 -1 或 1 到 ${MAX_DOWNLOADS} 之间的整数`,
      };
    }
  }

  const parsed = parseExpire(value, style);
  return {
    expireAt: parsed.expireAt,
    maxDownloads: explicitMax >= 0 ? explicitMax : parsed.maxDownloads,
  };
}

// ===================== 取件码生成 =====================

/**
 * 校验并原子抢占取件码。rawCode 为空时自动生成（最多 20 次重试）。
 * isCodeTaken 预检双表快速失败；claimCode（INSERT OR IGNORE + changes）为
 * 原子门闩，并发同码时仅一个请求成功，失败方不再继续写 R2/D1。
 */
export async function ensureCodeAvailable(rawCode: string, env: Env): Promise<string> {
  if (rawCode && !isValidCode(rawCode)) {
    throw { status: 400 as const, message: '取件码必须为 4 位数字' };
  }
  for (let i = 0; i < 20; i++) {
    const code = rawCode || generateCode();
    if (await isCodeTaken(env.DB, code)) {
      if (rawCode) break;
      continue;
    }
    if (await claimCode(env.DB, code)) return code;
    if (rawCode) break;
  }
  throw {
    status: rawCode ? 409 as const : 500 as const,
    message: rawCode ? '取件码已被占用' : '无法生成唯一取件码',
  };
}

// ===================== 上传门控 =====================

/**
 * open_upload 开关：为 '0' 时仅管理员可上传。
 * 放在 shared.ts 而非路由中间件，是为了让首页 /api/upload、/api/upload/text
 * 与兼容 API /api/share/* 共用同一道闸 —— 之前只拦兼容 API，后台开关形同虚设。
 */
export async function assertUploadAllowed(c: Context<{ Bindings: Env }>, env: Env): Promise<void> {
  if (((await getSetting(env.DB, 'open_upload')) ?? '1') !== '0') return;
  if (await adminAuth(c, env)) return;
  throw { status: 401 as const, message: '游客上传已关闭，请先登录' };
}

// ===================== 存储配额与流式写入 =====================

/**
 * 剩余可用空间（字节），Infinity = 不限制。
 * 读 storage_used 计数器：由 insertFile / deleteFileRecord / cleanupExpired 增减，
 * 并由 Cron 用 R2 实测值对账。不在上传路径上扫桶 —— 那会让每次上传多花 O(对象数) 的请求。
 */
export async function remainingQuota(env: Env, maxTotalStorage: number): Promise<number> {
  if (maxTotalStorage <= 0) return Infinity;
  // 未完成的分片会话也要占位：否则几个 300MB 的会话各自通过预检，最后合计爆掉
  const [used, pending] = await Promise.all([getStorageUsed(env.DB), getPendingChunkBytes(env.DB)]);
  return Math.max(0, maxTotalStorage - used - pending);
}

export function quotaMessage(limits: { maxTotalStorage: number }): string {
  return `存储空间已满（上限 ${formatFileSize(limits.maxTotalStorage)}），请删除过期文件或让管理员调整总占用上限`;
}

/**
 * 文件字节不进 JS：直接把 request.body 交给 R2。
 *
 * 为什么不能自己搬运：曾经用 FixedLengthStream + read/write 循环把 body 一段段喂给 R2，
 * 一片（8 或 16 MiB 都一样）就是几百次不中断的 isolate 唤醒。Workers 的 CPU 上限掐的是"连续执行的一段"
 * （await I/O 时计时会停），免费计划每请求只有 10ms —— 线上表现就是同一份文件一次成功
 * 一次 1102「exceededCpu」（失败的 cpuTimeMs 正好停在 10，成功的那条累计 386ms 反而没事：
 * 它的数据是陆续到达的，每读一块都挂起一次）。
 *
 * request.body 带 Content-Length 时长度已知，R2 直接接受，搬运全在平台内部完成，
 * JS 只 await 一个 Promise。代价是不再逐块记账，所以长度必须由 Content-Length 提前校验；
 * 拿不到长度就明确拒绝 —— 把整个文件读进内存的老回退是同一枚 1102 的内存版（isolate 128MB）。
 */
async function putStreamed(
  env: Env,
  key: string,
  body: ReadableStream<Uint8Array>,
  opts: { contentType: string; filename: string },
): Promise<number> {
  const obj = await env.FILE_STORE.put(key, body, {
    httpMetadata: { contentType: opts.contentType },
    customMetadata: { filename: opts.filename },
  });
  return obj?.size ?? 0;
}

// ===================== 文件上传 =====================

/** 共享的文件上传核心逻辑 */
export async function uploadFile(c: Context<{ Bindings: Env }>, env: Env): Promise<{
  code: string;
  filename: string;
  size: number;
}> {
  await assertUploadAllowed(c, env);

  // 上传速率限制：60 秒内同一 IP 最多 10 次上传
  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'upload_ratelimit', ip, 10))) {
    throw { status: 429 as const, message: '上传过于频繁，请稍后再试' };
  }

  const rawCode = (c.req.query('code') || '').trim();
  const limits = await resolveLimits(env);
  // 兼容旧参数名 (expire_days/max_downloads) 和新参数名 (expire_value/expire_style)。
  // 必须在 ensureCodeAvailable 之前校验：这里抛 422 时还没有占码
  const { expireAt, maxDownloads: effectiveMaxDownloads } = resolveExpire({
    value: c.req.query('expire_value') ?? c.req.query('expire_days'),
    style: c.req.query('expire_style'),
    maxDownloads: c.req.query('max_downloads'),
    defaultDays: limits.defaultExpireDays,
  });
  // decodeURIComponent 可能因非法 URI 编码抛 URIError，失败时回退到原始头值；
  // 先解码再截断，避免截断处切开多字节转义序列导致解码失败
  let filename = c.req.header('X-Filename') || '未命名';
  try {
    filename = decodeURIComponent(filename);
  } catch {
    /* 保留原始值 */
  }
  filename = filename.slice(0, 200);
  const mimeType = c.req.header('Content-Type') || 'application/octet-stream';

  const maxSize = limits.maxSize;
  const quotaLeft = await remainingQuota(env, limits.maxTotalStorage);

  // Content-Length 必须拿到：字节不进 JS 搬运之后，长度只能由客户端声明，
  // 而 R2 也拒绝长度未知的流。缺失就走分片接口或补上这个头，
  // 绝不退化成"把整个文件读进 isolate"—— 那是 1102 的内存版（单 isolate 只有 128MB）
  const clHeader = c.req.header('Content-Length');
  const declared = Number(clHeader);
  const knownLength = clHeader !== undefined && Number.isInteger(declared) && declared >= 0;
  if (!knownLength) {
    throw { status: 411 as const, message: '上传必须带 Content-Length（分块传输请改走分片接口）' };
  }
  if (declared > maxSize) {
    throw { status: 413 as const, message: `文件过大，最大 ${Math.floor(maxSize / 1048576)}MB` };
  }
  if (declared > quotaLeft) throw { status: 507 as const, message: quotaMessage(limits) };

  const code = await ensureCodeAvailable(rawCode, env);
  const key = `file:${code}`;

  let size = 0;
  try {
    const meta = { httpMetadata: { contentType: mimeType }, customMetadata: { filename } };
    if (declared === 0) {
      await env.FILE_STORE.put(key, new Uint8Array(0), meta);
      size = 0;
    } else {
      const body = c.req.raw.body;
      if (!body) throw { status: 400 as const, message: '请求体短于声明的 Content-Length，已放弃保存' };
      // customMetadata 里不写 size —— 长度以 R2 落库后的真实值为准
      size = await putStreamed(env, key, body, { contentType: mimeType, filename });
    }
    await insertFile(env.DB, {
      code, filename, size, mimeType, expireAt, maxDownloads: effectiveMaxDownloads, clientIp: ip,
    });
    return { code, filename, size };
  } catch (e) {
    // 失败必须清干净：残留对象既占空间又会被孤儿扫描算钱
    await env.FILE_STORE.delete(key).catch(() => {});
    await releaseCode(env.DB, code);
    throw e;
  }
}

// ===================== 查询防爆破 =====================

/**
 * 只统计“查不到”的请求：正常取件/浏览不消耗额度，失败 5 次/分钟/IP 后短暂封锁。
 * 4 位码只有 10,000 种，没有失败限流时一次全量扫描就能枚举出所有活跃文件；
 * 成功查询不计数，避免影响反复打开自己文件/正常分享链接的用户。
 */
export async function registerLookupFailure(c: Context<{ Bindings: Env }>, env: Env): Promise<boolean> {
  return checkRateLimit(env.DB, 'lookup_ratelimit', getClientIp(c.req.raw.headers), LOOKUP_RATE_MAX);
}

/** 文本分享的 filename 就是正文前 50 字：查看次数耗尽后必须遮蔽，API 与页面同一口径 */
export function displayFilename(file: FileRecord): string {
  const exhausted = file.is_text === 1 && file.max_downloads >= 0 && file.download_count >= file.max_downloads;
  return exhausted ? '***' : file.filename;
}

// ===================== 文件下载 =====================

export interface DownloadResult {
  file: FileRecord | null;
  obj: R2ObjectBody | null;
  notFound: boolean;
  maxExceeded: boolean;
  isHead: boolean;
}

export async function downloadFile(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<DownloadResult> {
  // 兼容 key（文档字段）和 code 两种参数名
  const code = (c.req.query('code') || c.req.query('key') || c.req.param('code') || '').trim();
  if (!code) throw { status: 422 as const, message: '缺少取件码' };

  const file = await getFileByCode(env.DB, code);
  if (!file) {
    if (!(await registerLookupFailure(c, env))) {
      throw { status: 429 as const, message: LOOKUP_RATE_MESSAGE };
    }
    return { file: null, obj: null, notFound: true, maxExceeded: false, isHead: false };
  }

  const obj = await env.FILE_STORE.get(`file:${code}`);
  if (!obj) return { file, obj: null, notFound: true, maxExceeded: false, isHead: false };

  const isHead = c.req.method === 'HEAD';
  if (!isHead) {
    const ok = await incrementDownload(env.DB, code);
    if (!ok) return { file, obj, notFound: false, maxExceeded: true, isHead: false };
  }

  return { file, obj, notFound: false, maxExceeded: false, isHead };
}

// ===================== 图片缩略图 =====================

/**
 * 缩略图由浏览器 canvas 生成（480px / ≤96KB），Worker 不做图像解码：
 * 免费档每请求只有 5ms CPU，解码一张几千万像素的照片必然超限。
 * 这里只负责收下并落 R2，因此校验的是「别拿它当免费图床」。
 */
const THUMB_MAX_BYTES = 128 * 1024;

/** 只认这三种容器格式的头，不信任客户端声明的 Content-Type */
function sniffImageType(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 12));
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  if (b.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x89 && ascii(1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a) return 'image/png';
  return null;
}

export async function saveThumb(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ code: string; size: number }> {
  await assertUploadAllowed(c, env);

  const code = (c.req.param('code') || '').trim();
  if (!code) throw { status: 422 as const, message: '缺少取件码' };

  // 单独限流：与上传共用一个桶的话，一张图片会吃掉两次上传配额
  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'thumb_ratelimit', ip, 30))) {
    throw { status: 429 as const, message: '操作过于频繁，请稍后再试' };
  }

  const file = await getFileByCode(env.DB, code);
  if (!file) {
    if (!(await registerLookupFailure(c, env))) {
      throw { status: 429 as const, message: LOOKUP_RATE_MESSAGE };
    }
    throw { status: 404 as const, message: '取件码不存在或已过期' };
  }
  // 只给图片挂缩略图，否则客户端可以把任意记录伪装成图片；
  // SVG 排除：它是脚本载体，且 canvas 无法可靠栅格化
  if (!file.mime_type.startsWith('image/') || file.mime_type.includes('svg')) {
    throw { status: 415 as const, message: '仅图片文件支持缩略图' };
  }

  const declared = Number(c.req.header('Content-Length'));
  if (Number.isFinite(declared) && declared > THUMB_MAX_BYTES) {
    throw { status: 413 as const, message: '缩略图过大' };
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) throw { status: 422 as const, message: '缩略图为空' };
  if (body.byteLength > THUMB_MAX_BYTES) throw { status: 413 as const, message: '缩略图过大' };

  const contentType = sniffImageType(body);
  if (!contentType) throw { status: 415 as const, message: '缩略图仅支持 WebP/JPEG/PNG' };

  await env.FILE_STORE.put(`thumb:${code}`, body, { httpMetadata: { contentType } });
  await markThumb(env.DB, code);
  return { code, size: body.byteLength };
}

/**
 * 读取缩略图。不计入下载次数——它只是页面渲染的一部分，
 * 计数会让「打开看一眼」悄悄消耗掉收件人的下载额度。
 */
export async function readThumb(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  const code = (c.req.param('code') || '').trim();
  if (!code) return null;
  // getFileByCode 已过滤过期记录
  const file = await getFileByCode(env.DB, code);
  if (!file) {
    // 只对“码不存在/已过期”计数；正常图片没有缩略图、或额度耗尽时返回的 404
    // 是页面预期行为，不能算爆破
    if (!(await registerLookupFailure(c, env))) {
      throw { status: 429 as const, message: LOOKUP_RATE_MESSAGE };
    }
    return null;
  }
  if (file.has_thumb !== 1) return null;
  // 与文本标题遮蔽成 *** 同一套逻辑：内容已被拒读时，缩略图同样不能外泄
  if (file.max_downloads >= 0 && file.download_count >= file.max_downloads) return null;
  const obj = await env.FILE_STORE.get(`thumb:${code}`);
  if (!obj) return null;
  return {
    body: obj.body as ReadableStream,
    contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
  };
}

// ===================== 连号取件码 =====================

/** 一次批次能要多少个连号码：与前端多选规模一致，也防止这个端点被当枚举器刷 */
const MAX_CODE_RUN = 20;

/**
 * 给多文件批次分配一段连号且未被占用的取件码。
 * 一个码只能对应一个文件，所以多文件时「自定义取件码」本质上不可用；
 * 连号是退而求其次：用户仍然拿到一组好记、可预期的码。
 */
export async function allocateCodeRun(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ codes: string[] }> {
  await assertUploadAllowed(c, env);

  const count = parseInt(c.req.param('count') || '', 10);
  if (!Number.isFinite(count) || count < 2 || count > MAX_CODE_RUN) {
    throw { status: 422 as const, message: `count 需为 2 到 ${MAX_CODE_RUN} 之间的整数` };
  }

  // 独立限流：它属于上传流程，但吃上传配额会让多文件批次更早撞上限
  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'code_ratelimit', ip, 20))) {
    throw { status: 429 as const, message: '操作过于频繁，请稍后再试' };
  }

  const codes = await findCodeRun(env.DB, count);
  if (!codes) throw { status: 409 as const, message: '暂无可用的连号取件码' };
  return { codes };
}

// ===================== 文本分享 =====================

/** 共享的文本上传核心逻辑 */
export async function uploadText(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{
  code: string;
  title: string;
  textSize: number;
  text: string;
  /** 结果页要显示与取件页同一条元信息，把过期与额度一并带回，省一次查库 */
  expireAt: string;
  maxDownloads: number;
}> {
  await assertUploadAllowed(c, env);

  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'upload_ratelimit', ip, 10))) {
    throw { status: 429 as const, message: '上传过于频繁，请稍后再试' };
  }

  const body = await c.req.parseBody();
  const text = typeof body['text'] === 'string' ? body['text'] : '';
  if (!text.trim()) throw { status: 422 as const, message: '文本内容不能为空' };

  const textSize = new TextEncoder().encode(text).length;
  if (textSize > 512 * 1024) throw { status: 400 as const, message: '文本过长，最大支持 512KB' };

  const rawCode = typeof body['code'] === 'string' ? body['code'] : '';
  const limits = await resolveLimits(env);
  // 同 uploadFile：校验必须在抢码之前
  const { expireAt, maxDownloads: effectiveMaxDownloads } = resolveExpire({
    value: body['expire_value'] ?? body['expire_days'],
    style: body['expire_style'],
    maxDownloads: body['max_downloads'],
    defaultDays: limits.defaultExpireDays,
  });

  // 文本同样占 R2 对象，配额满了要一起拒绝，否则留个绕过口
  if (textSize > await remainingQuota(env, limits.maxTotalStorage)) {
    throw { status: 507 as const, message: quotaMessage(limits) };
  }

  const code = await ensureCodeAvailable(rawCode, env);
  const title = text.replace(/\s+/g, ' ').slice(0, 50) + (text.length > 50 ? '…' : '');

  try {
    await env.FILE_STORE.put(`file:${code}`, text, {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { filename: title, size: String(textSize) },
    });
    await insertFile(env.DB, {
      code, filename: title, size: textSize, mimeType: 'text/plain', expireAt, maxDownloads: effectiveMaxDownloads, isText: 1, clientIp: getClientIp(c.req.raw.headers),
    });
    return { code, title, textSize, text, expireAt, maxDownloads: effectiveMaxDownloads };
  } catch (e) {
    // 与文件上传同样的清理：残留对象既占空间又躲过 D1 记录
    await env.FILE_STORE.delete(`file:${code}`).catch(() => {});
    await releaseCode(env.DB, code);
    throw e;
  }
}

// ===================== 文件信息获取 =====================

export interface SelectResult {
  file: FileRecord | null;
  notFound: boolean;
  maxExceeded: boolean;
  text?: string;
}

export async function selectFile(
  c: Context<{ Bindings: Env }>,
  env: Env,
  countAsDownload: boolean,
): Promise<SelectResult> {
  // 兼容 key（FileCodeBox 文档字段）和 code 两种参数名
  const code = (c.req.query('code') || c.req.query('key') || '').trim();
  if (!code) throw { status: 422 as const, message: '缺少取件码' };

  const file = await getFileByCode(env.DB, code);
  if (!file) {
    if (!(await registerLookupFailure(c, env))) {
      throw { status: 429 as const, message: LOOKUP_RATE_MESSAGE };
    }
    return { file: null, notFound: true, maxExceeded: false };
  }

  // 并行化：同时执行下载计数和 R2 读取。
  // POST select 只查状态，不能顺便把正文读出来 —— 否则 max_downloads 被完全绕过
  const shouldReadText = countAsDownload && file.is_text === 1;
  const [downloaded, r2Obj] = await Promise.all([
    countAsDownload ? incrementDownload(env.DB, code) : Promise.resolve(true),
    shouldReadText ? env.FILE_STORE.get(`file:${code}`) : Promise.resolve(null),
  ]);

  if (!downloaded) return { file, notFound: false, maxExceeded: true };

  let text: string | undefined;
  if (file.is_text === 1 && r2Obj) {
    text = await r2Obj.text();
  }

  return { file, notFound: false, maxExceeded: false, text };
}
