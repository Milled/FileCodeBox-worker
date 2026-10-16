/**
 * 分片上传（R2 原生 multipart）
 *
 * 为什么需要：Cloudflare 对单次请求体有硬上限（Free/Pro 100 MB、Business 200 MB），
 * 一个 300 MB 的文件不可能作为一个 POST 请求进来 —— 它在边缘就被拒了，
 * 连我们的代码都执行不到，用户拿到的也不是友好的「文件过大」提示。
 * 分片把「一个文件」变成「若干个小请求」，每片直接流进同一个 multipart 会话，
 * 由 R2 合成一个对象 —— 所以一个文件仍然只有一个取件码、后台仍然只是一行记录。
 *
 * 没有采用上游那种「每片先存成独立对象、complete 时读回拼接」的做法：
 * 那样存储峰值翻倍、每片多两次 R2 请求，客户端中途放弃还会在桶里留下一堆 chunk:* 对象计费。
 */
import type { Context } from 'hono';
import type { ChunkTask, Env } from './types';
import { getClientIp } from './utils';
import {
  assertUploadAllowed,
  ensureCodeAvailable,
  parseExpire,
  quotaMessage,
  remainingQuota,
  resolveLimits,
} from './shared';
import {
  deleteChunkTask,
  getChunkTask,
  hasFileRecord,
  insertChunkTask,
  insertFile,
  listChunkParts,
  listChunkTasks,
  listStaleChunkTasks,
  releaseCode,
  saveChunkPart,
  checkRateLimit,
} from './db';

/** 每片 8 MiB：远高于 S3 兼容接口「非末片最小 5 MiB」的要求，又远小于最窄套餐的请求体上限 */
export const CHUNK_PART_SIZE = 8 * 1024 * 1024;
/** 超过这个大小才走分片。小文件继续用单请求 XHR，不为常见情况多付两次往返 */
export const CHUNK_THRESHOLD = 64 * 1024 * 1024;
/** R2 单次会话允许 10,000 片，这里收紧到 1000（≈ 8 GiB），越界直接拒绝而不是静默截断 */
const MAX_PARTS = 1000;
/** 未完成会话的保留时长。超时必须 abort —— 已上传但未 complete 的分片会持续计费 */
export const CHUNK_STALE_MS = 6 * 3600_000;

// R2 的 uploadId 实测 171 字符、字符集是 base64url 那一套；长度上限留到 256，
// 只用来挡住明显恶意的路径参数，真正的鉴权是「这一行在 fc_chunk_uploads 里存在吗」
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,256}$/;

function requireTask(c: Context<{ Bindings: Env }>): { uploadId: string; part: number } {
  const uploadId = c.req.param('upload_id') ?? '';
  if (!UPLOAD_ID_RE.test(uploadId)) throw { status: 422 as const, message: '无效的上传会话标识' };
  const part = parseInt(c.req.param('part') ?? '');
  return { uploadId, part };
}

/** 与 uploadFile 一致的过期参数解析（兼容旧参数名 expire_days） */
function expireFrom(body: Record<string, unknown>, defaultExpireDays: number): { expireAt: string; maxDownloads: number } {
  const rawValue = body['expire_value'] ?? body['expire_days'] ?? defaultExpireDays;
  const value = Number(rawValue);
  const style = typeof body['expire_style'] === 'string' ? (body['expire_style'] as string) : 'day';
  const maxRaw = Number(body['max_downloads']);
  const parsed = parseExpire(Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultExpireDays, style);
  return {
    expireAt: parsed.expireAt,
    maxDownloads: Number.isFinite(maxRaw) && maxRaw >= 0 ? Math.floor(maxRaw) : parsed.maxDownloads,
  };
}

/** 预创建会话：校验大小与配额、抢占取件码、开 R2 multipart 会话 */
export async function chunkInit(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ upload_id: string; code: string; part_size: number; total_parts: number }> {
  await assertUploadAllowed(c, env);

  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'upload_ratelimit', ip, 10))) {
    throw { status: 429 as const, message: '上传过于频繁，请稍后再试' };
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw { status: 422 as const, message: '请求体不能为空' };

  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0) throw { status: 422 as const, message: '无效的文件大小' };

  const limits = await resolveLimits(env);
  if (size > limits.maxSize) {
    throw { status: 413 as const, message: `文件过大，最大 ${Math.floor(limits.maxSize / 1048576)}MB` };
  }
  const totalParts = Math.ceil(size / CHUNK_PART_SIZE);
  if (totalParts > MAX_PARTS) throw { status: 413 as const, message: '文件超出单次分片会话支持的范围' };
  if (size > await remainingQuota(env, limits.maxTotalStorage)) {
    throw { status: 507 as const, message: quotaMessage(limits) };
  }

  let filename = typeof body.filename === 'string' ? body.filename : '';
  try {
    filename = decodeURIComponent(filename);
  } catch {
    /* 保留原始值 */
  }
  filename = (filename || '未命名').slice(0, 200);
  const mimeType = (typeof body.content_type === 'string' && body.content_type) || 'application/octet-stream';
  const { expireAt, maxDownloads } = expireFrom(body, limits.defaultExpireDays);

  const code = await ensureCodeAvailable(String(body.code ?? '').trim(), env);
  const key = `file:${code}`;
  let uploadId = '';
  try {
    const mp = await env.FILE_STORE.createMultipartUpload(key, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { filename },
    });
    uploadId = mp.uploadId;
    const task: ChunkTask = {
      upload_id: uploadId, code, filename, size, part_size: CHUNK_PART_SIZE, total_parts: totalParts,
      mime_type: mimeType, expire_at: expireAt, max_downloads: maxDownloads,
      created_at: new Date().toISOString(), ip,
    };
    await insertChunkTask(env.DB, task);
  } catch (e) {
    // 建了会话但没落成 D1 行，必须就地 abort：Workers API 列举不到 multipart 会话，
    // 没有记录的会话谁都清不掉，只能等它一直计费（R2 面板既看不见也删不掉）
    if (uploadId) await env.FILE_STORE.resumeMultipartUpload(key, uploadId).abort().catch(() => {});
    // 会话没建成就把码还回去，否则一次失败的 init 会白占一个码
    await releaseCode(env.DB, code).catch(() => {});
    throw e;
  }

  return { upload_id: uploadId, code, part_size: CHUNK_PART_SIZE, total_parts: totalParts };
}

/**
 * 收一片：请求体直接流进 multipart 会话。
 * 每片用 FixedLengthStream 承载 Content-Length —— R2 不接受长度未知的流，
 * 顺带让「实际字节数与声明不符」在写入时就失败，而不是攒出一个坏对象。
 */
export async function chunkPut(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ ok: true; part: number; skipped?: boolean }> {
  const { uploadId, part } = requireTask(c);

  // 分片必须用独立限流桶：一次会话可能有上百片，共用上传桶会把自己掐死；
  // 反过来没有它，拿到 uploadId 的人就能无限刷片
  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'chunk_ratelimit', ip, 300))) {
    throw { status: 429 as const, message: '分片上传过于频繁，请稍后再试' };
  }

  const task = await getChunkTask(env.DB, uploadId);
  if (!task) throw { status: 404 as const, message: '上传会话不存在或已结束' };
  if (!Number.isInteger(part) || part < 1 || part > task.total_parts) {
    throw { status: 422 as const, message: '分片序号超出范围' };
  }

  // 客户端重试同一片时直接放过：R2 那边已经有一个同序号的 part，重复传只会白烧带宽
  const existing = await listChunkParts(env.DB, uploadId);
  if (existing.some((p) => p.part_number === part)) return { ok: true, part, skipped: true };

  const declared = Number(c.req.header('Content-Length'));
  if (!Number.isFinite(declared) || declared <= 0) throw { status: 422 as const, message: '分片缺少 Content-Length' };
  if (declared > CHUNK_PART_SIZE) throw { status: 413 as const, message: '单个分片超过 8 MiB' };
  if (!c.req.raw.body) throw { status: 422 as const, message: '分片内容为空' };

  const fixed = new FixedLengthStream(declared);
  const pump = async (): Promise<void> => {
    const reader = c.req.raw.body!.getReader();
    const writer = fixed.writable.getWriter();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await writer.write(value);
      }
      await writer.close();
    } catch (e) {
      await writer.abort(e).catch(() => {});
      throw e;
    }
  };

  const mp = env.FILE_STORE.resumeMultipartUpload(`file:${task.code}`, uploadId);
  let etag = '';
  try {
    const [uploaded] = await Promise.all([mp.uploadPart(part, fixed.readable), pump()]);
    etag = uploaded.etag;
  } catch (e) {
    // FixedLengthStream 会拒绝超出约定长度的写入，这是唯一能确定的客户端错误；
    // 其余原样抛出，宁可留 500 也不要猜错成客户端问题
    if (e instanceof Error && /allotted size/i.test(e.message)) {
      throw { status: 422 as const, message: '分片实际大小与 Content-Length 不符' };
    }
    throw e;
  }

  await saveChunkPart(env.DB, uploadId, part, etag);
  return { ok: true, part };
}

/** 已传哪些片（供断点续传跳过）。uploadId 是随机的，这里只暴露片号，不暴露内容 */
export async function chunkStatus(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ upload_id: string; total_parts: number; done: number[] }> {
  const { uploadId } = requireTask(c);
  const task = await getChunkTask(env.DB, uploadId);
  if (!task) throw { status: 404 as const, message: '上传会话不存在或已结束' };
  const parts = await listChunkParts(env.DB, uploadId);
  return { upload_id: uploadId, total_parts: task.total_parts, done: parts.map((p) => p.part_number) };
}

/** 合并收尾：片齐了才 complete，记账一律用 R2 合成后的真实大小 */
export async function chunkComplete(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ code: string; filename: string; size: number }> {
  const { uploadId } = requireTask(c);
  const task = await getChunkTask(env.DB, uploadId);
  if (!task) throw { status: 404 as const, message: '上传会话不存在或已结束' };

  const parts = await listChunkParts(env.DB, uploadId);
  const have = new Set(parts.map((p) => p.part_number));
  const missing: number[] = [];
  for (let i = 1; i <= task.total_parts; i++) if (!have.has(i)) missing.push(i);
  if (missing.length) {
    throw {
      status: 422 as const,
      message: `缺少分片：${missing.slice(0, 8).join(',')}${missing.length > 8 ? ` 等 ${missing.length} 片` : ''}`,
    };
  }

  const key = `file:${task.code}`;
  let size = 0;
  try {
    const mp = env.FILE_STORE.resumeMultipartUpload(key, uploadId);
    const obj = await mp.complete(parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })));
    size = obj.size;
  } catch (e) {
    // 单片与总大小的上限在 init / put 两处都已经拦过了，走到这里就是真的合并失败，
    // 一律 502 并清掉会话，不按错误消息猜成「文件过大」
    await forceAbort(env, task);
    console.error('[chunk] complete failed:', e instanceof Error ? e.message : String(e));
    throw { status: 502 as const, message: '分片合并失败，请重新上传' };
  }

  try {
    await insertFile(env.DB, {
      code: task.code, filename: task.filename, size, mimeType: task.mime_type,
      expireAt: task.expire_at, maxDownloads: task.max_downloads, clientIp: task.ip,
    });
  } catch (e) {
    await env.FILE_STORE.delete(key).catch(() => {});
    await releaseCode(env.DB, task.code);
    await deleteChunkTask(env.DB, uploadId);
    throw e;
  }

  await deleteChunkTask(env.DB, uploadId);
  return { code: task.code, filename: task.filename, size };
}

/** 客户端主动放弃：清会话、释放取件码 */
export async function chunkAbort(c: Context<{ Bindings: Env }>, env: Env): Promise<{ ok: true }> {
  const { uploadId } = requireTask(c);
  const task = await getChunkTask(env.DB, uploadId);
  if (!task) return { ok: true };
  await forceAbort(env, task);
  return { ok: true };
}

/**
 * 关掉一个会话。
 * 只 abort multipart（未 complete 时不会留下对象），**绝不删 file:{code}** ——
 * 万一 complete 成功而清理行失败，删对象就会把用户的真文件抹掉。
 * 释放取件码之前也要确认没有对应文件记录，同理。
 */
async function forceAbort(env: Env, task: ChunkTask): Promise<void> {
  try {
    await env.FILE_STORE.resumeMultipartUpload(`file:${task.code}`, task.upload_id).abort();
  } catch (e: any) {
    // 会话可能已完成或本就不存在；但行一删就再没有 API 能列出它，所以失败必须留痕
    console.error(`分片 abort 失败 code=${task.code} size=${task.size}: ${e?.message || e}`);
  }
  await deleteChunkTask(env.DB, task.upload_id);
  if (!(await hasFileRecord(env.DB, task.code))) {
    await releaseCode(env.DB, task.code);
  }
}

/** 超时未完成的会话：abort 掉，否则已传的分片会一直计费 */
export async function cleanupStaleChunkUploads(env: Env): Promise<number> {
  const stale = await listStaleChunkTasks(env.DB, CHUNK_STALE_MS);
  for (const task of stale) {
    await forceAbort(env, task);
  }
  return stale.length;
}

/**
 * 后台手动放弃单个会话。
 * 未完成的 multipart 不是对象 —— R2 面板删不掉、bucket.delete 也无效，只能走 abort，
 * 所以必须给管理员一个立刻执行的入口，而不是让他等 6 小时超时。
 */
export async function abortChunkSession(env: Env, uploadId: string): Promise<boolean> {
  const task = await getChunkTask(env.DB, uploadId);
  if (!task) return false;
  await forceAbort(env, task);
  return true;
}

/** 后台「放弃全部进行中会话」 */
export async function abortAllChunkSessions(env: Env): Promise<number> {
  const tasks = await listChunkTasks(env.DB);
  for (const task of tasks) {
    await forceAbort(env, task);
  }
  return tasks.length;
}
