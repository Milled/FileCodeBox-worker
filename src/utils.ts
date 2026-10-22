/** 生成 4 位纯数字取件码（拒绝采样，无模偏差） */
export function generateCode(): string {
  const bytes = new Uint8Array(1);
  let code = '';
  while (code.length < 4) {
    crypto.getRandomValues(bytes);
    // 拒绝 250-255，使每个数字等概率（250/10 = 25 个取值）
    if (bytes[0] < 250) {
      code += (bytes[0] % 10).toString();
    }
  }
  return code;
}

/** 验证取件码格式：必须为 4 位数字 */
export function isValidCode(code: string): boolean {
  return /^\d{4}$/.test(code);
}

/** HTML 转义，防止 Stored XSS（含单引号，用于 JS 字符串上下文） */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 清理孤立 UTF-16 代理字符，并按 code point 截断。
 * 文件名的 X-Filename 可以 percent-encode 出孤立代理（如 %ED%A0%80），
 * 直接存库后再 encodeURIComponent 会抛 URIError，整个下载变成 500。
 */
export function sanitizeFilename(name: string, maxChars = 200): string {
  const chars = Array.from(name, (ch) => {
    const cp = ch.codePointAt(0)!;
    return cp >= 0xd800 && cp <= 0xdfff ? '\uFFFD' : ch;
  });
  return chars.slice(0, maxChars).join('');
}

/** Content-Disposition 的 RFC 5987 编码；对历史脏数据也做一次兜底清理 */
export function encodeFilename(name: string): string {
  return encodeURIComponent(sanitizeFilename(name, 512));
}

/** 页面上可安全展示的错误：4xx/5xx 业务错误保留文案，未知异常统一 500 */
export function toPublicError(
  e: unknown,
  fallback = '服务器内部错误',
): { status: number; message: string } {
  const err = e as { status?: unknown; message?: unknown };
  const status = typeof err?.status === 'number' ? err.status : 500;
  if (status >= 400 && status < 600 && typeof err?.message === 'string') {
    return { status, message: status === 500 ? fallback : err.message };
  }
  return { status: 500, message: fallback };
}

/** 解析分页/数量类 query，非法值回退，避免 NaN 直接传给 D1 变 500 */
export function parseIntParam(
  raw: string | undefined,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** PBKDF2 哈希密码（固定盐 + 10 万次迭代，抗暴力破解） */
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT = new TextEncoder().encode('filecodebox-admin-v1');

export async function hashPassword(pwd: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pwd),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: PBKDF2_SALT, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 格式化文件大小 */
export function formatFileSize(bytes: number): string {
  // 用 >= 而非 >：正好 1 MiB / 1 KiB 时否则会显示成 "1024.0 KB" 这种别扭值
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 从请求头提取客户端真实 IP（优先 CF-Connecting-IP，回退 x-real-ip / x-forwarded-for） */
export function getClientIp(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    ''
  );
}
