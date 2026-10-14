#!/usr/bin/env node
/**
 * FileCodeBox Cloudflare 资源自动开通脚本
 *
 * `wrangler deploy` 只校验绑定、不会创建 D1 / R2，本脚本补上这一步：
 *   1. 检查 wrangler 登录状态
 *   2. 按 wrangler.jsonc 里的 database_name / bucket_name 创建缺失的 D1 数据库与 R2 存储桶
 *   3. 把创建返回的 database_id 回填进 wrangler.jsonc
 *   4. 对新库执行 schema.sql（空库上后台登录会因缺表 500，必须先建表）
 *
 * 幂等：资源已存在则直接复用，可重复执行。
 *
 * 用法：
 *   npm run provision                     # 创建缺失资源 + 回填 database_id
 *   npm run provision -- --dry-run        # 只报告将要做什么，不创建、不写文件
 *   npm run provision -- --location=apac  # 指定 D1 主位置，跳过 wrangler 的位置询问
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'wrangler.jsonc');
const SCHEMA_PATH = join(ROOT, 'schema.sql');
const DRY_RUN = process.argv.includes('--dry-run');
const LOCATION_ARG = process.argv.find((a) => a.startsWith('--location='));

// 优先使用项目本地依赖，其次回退到全局 wrangler
const LOCAL_BIN = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const BIN = existsSync(LOCAL_BIN) ? LOCAL_BIN : 'wrangler';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// d1 create 的输出是人类可读文本，需要从中等抓取 UUID
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function die(msg, hint) {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`  → ${hint}`);
  process.exit(1);
}

/** 调用 wrangler，不经过 shell（避免参数注入） */
function wrangler(args) {
  try {
    const stdout = execFileSync(BIN, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return {
      ok: false,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: [e.stderr, e.message].filter(Boolean).map(String).join('\n'),
    };
  }
}

/** wrangler --json 偶尔会在 JSON 之前混入告警行，逐个起点试探解析 */
function parseJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* 继续容错 */
  }
  const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0);
  for (const i of starts) {
    try {
      return JSON.parse(s.slice(i));
    } catch {
      /* 继续 */
    }
  }
  return null;
}

/** 兼容 {result:[...]} / {results:[...]} / {result:{...}} / 裸数组 / 裸对象 等 wrangler 输出形态 */
function rows(node) {
  if (Array.isArray(node)) return node;
  if (!node || typeof node !== 'object') return [];
  for (const key of ['result', 'results', 'databases', 'buckets']) {
    const v = node[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const nested = rows(v);
      if (nested.length) return nested;
    }
  }
  return [node];
}

function uuidOf(row) {
  for (const k of ['uuid', 'database_id', 'id']) {
    const v = row?.[k];
    if (typeof v === 'string' && UUID_RE.test(v)) return v;
  }
  return null;
}

function nameOf(row) {
  for (const k of ['name', 'database_name', 'bucket_name']) {
    if (typeof row?.[k] === 'string') return row[k];
  }
  return null;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const alreadyExists = (text) => /already exist|already been created|409|conflict/i.test(String(text || ''));

function readConfig() {
  if (!existsSync(CONFIG_PATH)) die(`找不到配置文件 ${CONFIG_PATH}`);
  return readFileSync(CONFIG_PATH, 'utf8');
}

function requireField(src, label) {
  const m = src.match(new RegExp(`"${label}"\\s*:\\s*"([^"]+)"`));
  if (!m) die(`wrangler.jsonc 中缺少非空的 "${label}"`, '请先在 d1_databases / r2_buckets 里填好资源名称');
  return m[1];
}

/**
 * 只回填目标 d1_databases 条目的 database_id（按 database_name 定位）。
 * 用正则而非 JSON.parse，以保留 .jsonc 中的注释。
 */
function patchDatabaseId(src, databaseName, id) {
  const entryRe = new RegExp(`\\{[^{}]*"database_name"\\s*:\\s*"${escRe(databaseName)}"[^{}]*\\}`);
  const m = src.match(entryRe);
  if (!m) die(`wrangler.jsonc 中未找到 database_name = "${databaseName}" 的 d1_databases 条目`);

  const patchedEntry = /"database_id"\s*:/.test(m[0])
    ? m[0].replace(/("database_id"\s*:\s*)"[^"]*"/, (_all, key) => `${key}"${id}"`)
    : m[0].replace(/("database_name"\s*:\s*"[^"]*")/, (_all, key) => `${key},\n    "database_id": "${id}"`);

  return src.replace(m[0], () => patchedEntry);
}

/** 先 list 再 info：list 可能分页而漏掉目标，info 是按名查询兜底 */
function findDatabaseId(name) {
  const listed = wrangler(['d1', 'list', '--json']);
  if (listed.ok) {
    const hit = rows(parseJson(listed.stdout)).find((r) => nameOf(r) === name);
    if (hit && uuidOf(hit)) return uuidOf(hit);
  }
  const info = wrangler(['d1', 'info', name, '--json']);
  if (info.ok) {
    const hit = rows(parseJson(info.stdout)).map(uuidOf).find(Boolean);
    if (hit) return hit;
  }
  return null;
}

function findBucket(name) {
  // r2 bucket list 不支持 --json，只能从表格里按名称边界匹配
  const listed = wrangler(['r2', 'bucket', 'list']);
  if (!listed.ok) {
    console.warn(`  (r2 bucket list 调用失败，将尝试直接创建 "${name}")`);
    return false;
  }
  return new RegExp(`(^|[^a-z0-9-])${escRe(name)}([^a-z0-9-]|$)`, 'm').test(listed.stdout);
}

console.log(`wrangler: ${BIN}`);
if (DRY_RUN) console.log('（--dry-run：只检查与报告，不创建资源、不写文件）');

// ---- 1. 登录状态 ----
// 实测 wrangler 4.114：未登录时 `wrangler whoami` 依然返回退出码 0，
// 因此以 `whoami --json` 的 loggedIn 字段为准，文本匹配仅作降级兜底
const whoami = wrangler(['whoami', '--json']);
const whoamiText = `${whoami.stdout}${whoami.stderr}`;
if (/ENOENT|command not found|spawn/i.test(whoamiText)) {
  die('未找到 wrangler 可执行文件', '先在项目目录执行 npm install，或 npm i -g wrangler');
}
const loggedInFlag = parseJson(whoami.stdout)?.loggedIn;
const authenticated =
  whoami.ok &&
  (loggedInFlag === true || (loggedInFlag === undefined && /logged in|api token/i.test(whoamiText) &&
    !/not authenticated|not logged in/i.test(whoamiText)));
if (!authenticated) {
  die('wrangler 未登录或令牌已失效', '运行 npx wrangler login 完成浏览器授权后重试');
}
const account = whoamiText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
console.log(`✓ Cloudflare 已登录${account ? `：${account}` : ''}`);

// ---- 2. 期望的资源名称 ----
const src = readConfig();
const databaseName = requireField(src, 'database_name');
const bucketName = requireField(src, 'bucket_name');
console.log(`  D1 数据库: ${databaseName}`);
console.log(`  R2 存储桶: ${bucketName}`);

// ---- 3. D1 ----
let databaseId = findDatabaseId(databaseName);
if (databaseId) {
  console.log(`✓ D1 "${databaseName}" 已存在: ${databaseId}`);
} else if (DRY_RUN) {
  console.log(`· 将创建 D1 "${databaseName}" 并回填 database_id`);
  databaseId = '<将新建的 database_id>';
} else {
  const args = ['d1', 'create', databaseName];
  if (LOCATION_ARG) args.push(LOCATION_ARG);
  console.log(`· 正在创建 D1 "${databaseName}"（若 wrangler 询问是否写入配置文件，请选 No，本脚本负责回填）`);
  const created = wrangler(args);
  // d1 create 不支持 --json：先尝试按 JSON 解析，失败则从文本中抓 UUID
  databaseId =
    rows(parseJson(created.stdout)).map(uuidOf).find(Boolean) ?? created.stdout.match(UUID_IN_TEXT)?.[0] ?? null;
  // list 漏查或并发创建时，create 会报“已存在”：改用按名查询取回 uuid
  if (!databaseId && alreadyExists(created.stdout + created.stderr)) {
    databaseId = findDatabaseId(databaseName);
  }
  if (!databaseId) {
    die(
      `创建 D1 "${databaseName}" 失败或未能解析 database_id`,
      `手动执行: npx wrangler d1 create ${databaseName}\n${created.stdout}${created.stderr}`,
    );
  }
  console.log(`✓ 已创建 D1 "${databaseName}": ${databaseId}`);
}

// ---- 4. R2 ----
if (findBucket(bucketName)) {
  console.log(`✓ R2 存储桶 "${bucketName}" 已存在`);
} else if (DRY_RUN) {
  console.log(`· 将创建 R2 存储桶 "${bucketName}"`);
} else {
  const created = wrangler(['r2', 'bucket', 'create', bucketName]);
  if (!created.ok && !alreadyExists(created.stderr)) {
    die(
      `创建 R2 存储桶 "${bucketName}" 失败`,
      `若账号尚未开通 R2，先到 Cloudflare 控制台 https://dash.cloudflare.com/ 的 R2 页面接受服务条款后重试\n${created.stderr}`,
    );
  }
  console.log(`✓ R2 存储桶 "${bucketName}" 就绪`);
}

// ---- 5. 回填 database_id ----
const next = patchDatabaseId(src, databaseName, databaseId);
if ((next.match(/"database_name"/g) || []).length > 1) {
  console.warn(
    '! wrangler.jsonc 里有多个 d1_databases 条目。若 wrangler 曾询问「是否写入配置文件」，它会追加一条重复绑定（binding = DB），请手动删除多余条目。',
  );
}

if (next === src) {
  console.log('✓ database_id 已是最新，配置文件无需修改');
} else if (DRY_RUN) {
  console.log('· 将把 database_id 写入 wrangler.jsonc');
} else {
  writeFileSync(CONFIG_PATH, next, 'utf8');
  console.log(`✓ 已写入 wrangler.jsonc: "database_id": "${databaseId}"`);
}

// ---- 6. 建表 ----
if (!existsSync(SCHEMA_PATH)) {
  console.warn(`! 未找到 schema.sql，跳过建表（Cron 每 30 分钟会幂等补建）`);
} else if (DRY_RUN) {
  console.log(`· 将对 D1 "${databaseName}" 执行 schema.sql 建表`);
} else {
  const applied = wrangler(['d1', 'execute', databaseName, '--remote', '--file', SCHEMA_PATH, '--yes']);
  if (applied.ok) {
    console.log(`✓ 已对 "${databaseName}" 执行 schema.sql，表结构就绪`);
  } else {
    console.warn(
      `! schema.sql 执行失败，稍后可手动重试：npx wrangler d1 execute ${databaseName} --remote --file=./schema.sql --yes\n  ${applied.stderr.trim().slice(0, 300)}`,
    );
  }
}

console.log(`
下一步：
  1. 设置管理员密码（未设置时后台登录会被拒绝）
       npx wrangler secret put ADMIN_PASSWORD
  2. 部署
       npm run deploy

表结构已由 schema.sql 建好，无需再访问 /api/init；Cron 每 30 分钟仍会幂等校验一次。
`);
