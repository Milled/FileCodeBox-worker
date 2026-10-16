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
