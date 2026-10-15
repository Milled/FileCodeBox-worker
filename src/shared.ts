/**
 * 共享业务逻辑：供 src/index.ts 和 src/api.ts 共同使用，
 * 避免两套路由体系维护同一份上传/下载/过期处理代码。
 */
import type { Context } from 'hono';
import type { Env } from './types';
import type { FileRecord } from './types';
import { isValidCode, generateCode, getClientIp } from './utils';
import { adminAuth } from './auth';
import {
  getFileByCode,
  isCodeTaken,
  claimCode,
  insertFile,
  incrementDownload,
  releaseCode,
  checkRateLimit,
  getSetting,
} from './db';

// ===================== 运行时上限 =====================

/** 25MB，与 wrangler.jsonc 的 MAX_FILE_SIZE 默认值一致 */
const FALLBACK_MAX_FILE_SIZE = 26214400;
const FALLBACK_EXPIRE_DAYS = 7;

/**
 * 解析当前生效的文件大小上限与默认过期天数。
 * 管理员后台 PATCH /api/admin/config/update 写入 fc_settings 的值优先于 wrangler vars，
 * 两者都缺失或非法（非正整数）时回退到内置默认，避免 NaN 导致校验被绕过。
 */
export async function resolveLimits(env: Env): Promise<{ maxSize: number; defaultExpireDays: number }> {
  const positiveInt = (v: string | null | undefined): number => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const [dbMaxSize, dbExpireDays] = await Promise.all([
    getSetting(env.DB, 'max_file_size'),
    getSetting(env.DB, 'default_expire_days'),
  ]);

  return {
    maxSize: positiveInt(dbMaxSize) || positiveInt(env.MAX_FILE_SIZE) || FALLBACK_MAX_FILE_SIZE,
    defaultExpireDays: positiveInt(dbExpireDays) || positiveInt(env.DEFAULT_EXPIRE_DAYS) || FALLBACK_EXPIRE_DAYS,
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

// ===================== 取件码生成 =====================

/**
 * 校验并原子抢占取件码。rawCode 为空时自动生成（最多 20 次重试）。
 * isCodeTaken 预检双表快速失败；claimCode（INSERT OR IGNORE + changes）为
 * 原子门闩，并发同码时仅一个请求成功，失败方不再继续写 R2/D1。
 */
async function ensureCodeAvailable(rawCode: string, env: Env): Promise<string> {
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
  // 兼容旧参数名 (expire_days/max_downloads) 和新参数名 (expire_value/expire_style)
  const expireValueRaw = c.req.query('expire_value') || c.req.query('expire_days') || String(limits.defaultExpireDays);
  const expireStyleRaw = c.req.query('expire_style') || 'day';
  const maxDownloadsRaw = c.req.query('max_downloads') || '-1';
  const safeExpireValue = Number.isFinite(parseInt(expireValueRaw)) ? parseInt(expireValueRaw) : limits.defaultExpireDays;
  const safeMaxDownloads = Number.isFinite(parseInt(maxDownloadsRaw)) ? parseInt(maxDownloadsRaw) : -1;
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

  // Content-Length 预检：超限直接拒绝，避免读入大请求体占用内存；
  // 头部缺失时（如 chunked）回退到读取后校验
  const contentLength = Number(c.req.header('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maxSize) {
    throw { status: 413 as const, message: `文件过大，最大 ${Math.floor(maxSize / 1048576)}MB` };
  }

  // 一次性读取请求体（Cloudflare Workers 中 body 只能消费一次），
  // 计算实际大小并做上限校验，然后转为 Blob 流写入 R2。
  const requestBody = await c.req.arrayBuffer();
  const size = requestBody.byteLength;

  if (size > maxSize) {
    throw { status: 413 as const, message: `文件过大，最大 ${Math.floor(maxSize / 1048576)}MB` };
  }

  const bodyBlob = new Blob([requestBody]);
  const code = await ensureCodeAvailable(rawCode, env);

  const { expireAt, maxDownloads: parsedMaxDownloads } = parseExpire(safeExpireValue, expireStyleRaw);
  // 用户显式指定的 max_downloads 优先，否则用 expire_style=count 推得的次数（默认不限）
  const effectiveMaxDownloads = safeMaxDownloads >= 0 ? safeMaxDownloads : parsedMaxDownloads;

  try {
    await env.FILE_STORE.put(`file:${code}`, bodyBlob.stream(), {
      httpMetadata: { contentType: mimeType },
      customMetadata: { filename, size: String(size) },
    });
    await insertFile(env.DB, {
      code, filename, size, mimeType, expireAt, maxDownloads: effectiveMaxDownloads, clientIp: getClientIp(c.req.raw.headers),
    });
    return { code, filename, size };
  } catch (e) {
    await releaseCode(env.DB, code);  // 写入失败则释放码
    throw e;
  }
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
  if (!file) return { file: null, obj: null, notFound: true, maxExceeded: false, isHead: false };

  const obj = await env.FILE_STORE.get(`file:${code}`);
  if (!obj) return { file, obj: null, notFound: true, maxExceeded: false, isHead: false };

  const isHead = c.req.method === 'HEAD';
  if (!isHead) {
    const ok = await incrementDownload(env.DB, code);
    if (!ok) return { file, obj, notFound: false, maxExceeded: true, isHead: false };
  }

  return { file, obj, notFound: false, maxExceeded: false, isHead };
}

// ===================== 文本分享 =====================

/** 共享的文本上传核心逻辑 */
export async function uploadText(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ code: string; title: string; textSize: number; text: string }> {
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
  const expireDefault = String(limits.defaultExpireDays);
  const expireValueRaw = typeof body['expire_value'] === 'string' ? body['expire_value'] :
                         typeof body['expire_days'] === 'string' ? body['expire_days'] : expireDefault;
  const expireStyleRaw = typeof body['expire_style'] === 'string' ? body['expire_style'] : 'day';
  const maxDownloadsRaw = typeof body['max_downloads'] === 'string' ? body['max_downloads'] : '-1';
  const safeExpireValue = Number.isFinite(parseInt(expireValueRaw)) ? parseInt(expireValueRaw) : limits.defaultExpireDays;
  const safeMaxDownloads = Number.isFinite(parseInt(maxDownloadsRaw)) ? parseInt(maxDownloadsRaw) : -1;

  const code = await ensureCodeAvailable(rawCode, env);

  const { expireAt, maxDownloads: parsedMaxDownloads } = parseExpire(safeExpireValue, expireStyleRaw);
  const effectiveMaxDownloads = safeMaxDownloads >= 0 ? safeMaxDownloads : parsedMaxDownloads;
  const title = text.replace(/\s+/g, ' ').slice(0, 50) + (text.length > 50 ? '…' : '');

  try {
    await env.FILE_STORE.put(`file:${code}`, text, {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { filename: title, size: String(textSize) },
    });
    await insertFile(env.DB, {
      code, filename: title, size: textSize, mimeType: 'text/plain', expireAt, maxDownloads: effectiveMaxDownloads, isText: 1, clientIp: getClientIp(c.req.raw.headers),
    });
    return { code, title, textSize, text };
  } catch (e) {
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
  if (!file) return { file: null, notFound: true, maxExceeded: false };

  // 并行化：同时执行下载计数和 R2 读取
  const [downloaded, r2Obj] = await Promise.all([
    countAsDownload ? incrementDownload(env.DB, code) : Promise.resolve(true),
    file.is_text === 1 ? env.FILE_STORE.get(`file:${code}`) : Promise.resolve(null),
  ]);

  if (!downloaded) return { file, notFound: false, maxExceeded: true };

  let text: string | undefined;
  if (file.is_text === 1 && r2Obj) {
    text = await r2Obj.text();
  }

  return { file, notFound: false, maxExceeded: false, text };
}
