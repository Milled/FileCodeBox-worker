/** 文件记录类型 */
export interface FileRecord {
  id: number;
  code: string;
  filename: string;
  size: number;
  mime_type: string;
  expire_at: string;
  download_count: number;
  max_downloads: number;
  created_at: string;
  ip: string;
  is_text: number;
  /** R2 中是否存在 thumb:{code}。由浏览器端生成的缩略图写入，缺记录时页面回退文件图标 */
  has_thumb: number;
}

/** Cloudflare Worker 环境绑定 */
export interface Env {
  DB: D1Database;
  FILE_STORE: R2Bucket;
  /** 未配置时登录被拒绝（auth.ts 中已防御） */
  ADMIN_PASSWORD?: string;
  MAX_FILE_SIZE: string;
  DEFAULT_EXPIRE_DAYS: string;
}
