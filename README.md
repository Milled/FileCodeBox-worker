# FileCodeBox Worker

> 像取快递一样取文件 —— 上传后拿到 4 位取件码，对方输码即取，到期自动销毁。

[FileCodeBox](https://github.com/vastsa/FileCodeBox) 的 Cloudflare Workers 移植版：**不需要服务器，也没有构建步骤**，代码直接跑在边缘节点，数据放在 D1（SQLite）+ R2（对象存储），免费额度就能长期挂着。

| 项目 | 说明 |
|------|------|
| 运行环境 | Cloudflare Workers · [Hono](https://hono.dev/) · TypeScript |
| 存储 | D1（元数据）+ R2（文件本体） |
| 前端 | 服务端渲染，样式与脚本全部内联，**零外部 CDN / 字体 / 图片依赖** |
| 运行时依赖 | 只有 `hono` 和 `qr` 两个包 |
| 默认限制 | 单文件 100 MB · 7 天过期 · 文本 512 KB（后台可随时改，不需重新部署） |
| 大文件 | 超过 64 MiB 自动分片上传（每片 16 MiB），不受 Cloudflare 单次请求体上限约束 |
| 深色模式 | 跟随系统 |

---

## ✨ 功能

- 📤 **上传文件** — 点击 / 拖拽 / 粘贴均可，支持多选；每个文件各自一个取件码，多选时自动分配**连号码**
- 📦 **大文件分片** — 超过 64 MiB 自动切成 16 MiB 的分片并发上传，请求体直接流进 R2 multipart 会话；**一个文件仍然只有一个取件码，后台仍然只是一行记录**
- 📝 **文本分享** — 粘贴文本即得取件码，页面内直接阅读，实时显示 UTF-8 字节数
- 📥 **取件下载** — 输 4 位码即取，填满自动提交；码不存在或为空时回到取件框重新输入
- 🖼️ **图片预览** — 上传的是图片时，落地页与取件页直接显示缩略图；服务端限制 128KB / 1024px 长边 / 1MP，已有缩略图不可覆盖
- ⏰ **灵活有效期** — 天 / 小时 / 分钟 / 按下载次数 / 永久，上传时直接选
- 🚧 **上传前置校验** — 超过大小上限的文件在列表里标红并整批拦下；多文件时某个失败不中断其余，收尾汇总成败
- 🔐 **管理后台** — 统计仪表盘、文件搜索 / 排序 / 分页 / 删除、系统设置页（大小上限、默认过期、游客上传、R2 总占用上限）
- 🔌 **开放 API** — 兼容 FileCodeBox v2.1.0，`curl` 即可调用

## 🛡️ 安全特性

- **XSS 防护** — 所有回显的用户输入统一转义；分享的文本按纯文本渲染，内联标签不会执行
- **严格 CSP** — `default-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'`，不加载任何第三方资源
- **密码安全** — PBKDF2 10 万次迭代哈希 + 常数时间比较（防时序攻击）
- **限流** — 登录 5 次 / 60 秒、上传 10 次 / 60 秒（按客户端 IP），各类写操作独立计数
- **SQL 注入防护** — 全部参数化查询
- **取件码安全** — CSPRNG 生成 + 抢占式占用（`INSERT OR IGNORE` 原子判定，消除并发竞态）
- **上传不进内存、也不过 JS** — 带 `Content-Length` 的请求体原样交给 R2，字节不在 Worker 里逐块搬运。Free 计划每次请求只有 10ms 连续 CPU，自己搬一片 16 MiB 必然撞上限（错误 1102）；缺 `Content-Length` 的请求在读 body 之前就 411 拒绝，绝不退化成把整个文件缓冲进 isolate（只有 128MB）
- **存储配额** — 可选的 R2 总占用上限，超限只拒绝新上传（507），不影响已有文件；计数器由定时任务与 R2 实测值对账
- **私密内容不被缓存** — 取件页与含正文的结果页一律 `Cache-Control: no-store`
- **删除即彻底** — 先删 R2 再删 DB（`try/finally` 兜底）；缩略图随主文件一并销毁，过期清理与孤儿对象扫描都覆盖
- **额度即隐私边界** — 达到最大下载次数后，正文与缩略图一并拒绝访问，文本标题遮蔽为 `***`
- **游客上传可一键关闭** — 同时作用于网页上传与兼容 API，管理员登录态不受影响；取件与下载始终开放

---

## 🚀 部署（GitHub + Cloudflare Dashboard）

准备：把你的 Fork 推到 GitHub，以及一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)。

### 1. 连接仓库

Cloudflare Dashboard → **Workers & Pages → Create → Import a Git repository**，选中你的仓库。

构建配置保持默认即可 —— 本项目没有构建步骤，入口是 `src/index.ts`，由 Wrangler 直接上传。

### 2. D1 与 R2 会自动创建

`wrangler.jsonc` 声明了这两个绑定，但**故意不写 `database_id`**：

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "filecodebox-db", "database_id": "" }],
"r2_buckets":   [{ "binding": "FILE_STORE", "bucket_name": "filecodebox-file" }]
```

从 Dashboard / GitHub 部署时，Cloudflare 会按声明自动创建同名资源并完成绑定，你不用手动建。两点需要知道：

- 创建出的 ID **不会写回仓库**，只在 Dashboard 里可见。这不影响线上运行；但如果你之后想在本地 `wrangler deploy`，先跑一次 `npm run provision` 把 ID 回填（它会复用已存在的同名资源）。
- 想换 Worker 名或资源名，直接改 `wrangler.jsonc` 里的 `name` / `database_name` / `bucket_name` 再推送。`name` 在同一账号下必须唯一。

### 3. 设置管理员密码（Secret）

部署完成后进入该 Worker → **Settings → Variables and Secrets → Add → Secret text**：

| 名称 | 值 |
|------|------|
| `ADMIN_PASSWORD` | 你的管理员密码 |

不设这个变量时上传与取件照常，但后台无法登录。密码请存成 Secret，不要写成明文 Variable。

### 3.1 可选：Turnstile 人机验证

如需给游客上传加一道人机验证，在 Cloudflare Dashboard → Turnstile 创建一个站点，然后给 Worker 配置：

| 名称 | 建议类型 | 值 |
|------|----------|----|
| `TURNSTILE_SITE_KEY` | Variable 或 Secret | Turnstile 的 Site Key（公开） |
| `TURNSTILE_SECRET_KEY` | Secret | Turnstile 的 Secret Key |

部署后在 **后台 → 设置 → Turnstile 人机验证** 选择开启即可。开启后：

- 游客在网页完成一次验证，会得到一个绑定当前 IP、1 小时有效的签名 cookie；之后的多文件上传、分片 init、文本分享都复用它，不会每个请求都弹验证。
- 验证服务端只在 `/api/turnstile/verify` 调一次 Cloudflare siteverify；上传路径只做 HMAC cookie 校验，不额外访问外部服务或 D1。
- 管理员（有效 cookie/Bearer token）不受影响；**纯 API 游客上传会需要浏览器完成过验证**，没有浏览器自动化时请保持关闭，或改用管理员 Bearer token。
- 两个密钥缺任意一个时，后台无法真正开启；若开启后密钥被移除，游客上传会失败关闭（503），管理员仍可上传。

### 4. 首次访问：等一次建表

数据表由 Worker 自己创建（`initDB()`），触发时机是**每 30 分钟一次的 Cron**（`triggers.crons` 已配好）。所以刚部署完立刻打开 `/admin` 可能报错，等半小时即正常。

不想等就在本地跑一次，它会复用同名资源、回填 ID 并执行 `schema.sql`：

```bash
npm install && npx wrangler login && npm run provision
```

> 别用 `/api/init` 做首次初始化 —— 它要求管理员身份，而登录又要读 `fc_settings` 表，空库上两者互相卡死。

### 5. 开始使用

打开 `https://<你的 Worker 域名>/` 上传即可。后台在 `/admin`。

想用更好记的地址：Worker → **Settings → Domains & Routes** 绑定自定义域名（域名需托管在 Cloudflare）。

---

## 🔌 API

两套接口：**兼容 API**（程序调用，统一返回 `{ code, msg, detail }`）与**网页接口**（页面自身使用）。

### 分享与下载（默认免登录）

```bash
# 上传文件：请求体就是文件本身，文件名走 X-Filename 头
curl -X POST "https://你的域名/api/share/file?expire_value=1&expire_style=day" \
  -H "X-Filename: example.txt" --data-binary @example.txt

# 分享文本（表单）
curl -X POST "https://你的域名/api/share/text" \
  -F "text=要分享的内容" -F "expire_value=1" -F "expire_style=day"

# 查文件信息 / 下载
curl "https://你的域名/api/share/select?code=1234"
curl "https://你的域名/api/share/download?code=1234"
```

`expire_style` 支持 `day` / `hour` / `minute` / `count`（限下载次数）/ `forever`。

> 注意 `GET /api/share/select` 会**计入下载次数**（沿用上游语义）；只想查状态请用 `POST /api/share/select`（只返回元信息，不返回文本正文）。
> 取件码查询按 IP 做失败限流：每分钟最多 5 次「查不到/已过期」，第 6 次起返回 `429`；成功取件不计数。4 位码只有 10,000 种，没有这道闸时一次全量扫描就能枚举所有活跃文件。
> 上传与查询接口带不带结尾斜杠都能访问。

### 管理接口（Bearer token）

```bash
curl -X POST "https://你的域名/api/admin/login" \
  -H "Content-Type: application/json" -d '{"password":"你的密码"}'
# → { "code": 200, "detail": { "token": "...", "token_type": "Bearer" } }

curl "https://你的域名/api/admin/dashboard"                          -H "Authorization: Bearer <token>"
curl "https://你的域名/api/admin/file/list?page=1&size=10&keyword=x"   -H "Authorization: Bearer <token>"
curl -X DELETE "https://你的域名/api/admin/file/delete?id=123"         -H "Authorization: Bearer <token>"
```

配置读写 —— `get` 返回的是**当前实际生效值**，不是原始配置：

```bash
curl "https://你的域名/api/admin/config/get" -H "Authorization: Bearer <token>"

curl -X PATCH "https://你的域名/api/admin/config/update" -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"openUpload":"1","maxFileSize":"26214400","defaultExpireDays":"7","maxTotalStorage":"536870912"}'
```

上传相关的错误码：`413` 单个文件超上限 / 请求体过大、`507` R2 总占用已满、`429` 触发上传/查询失败限流或游客配额（游客每 IP 每天最多 50 次上传，同一 IP 最多 5 个并发分片会话；分片用独立桶，一次会话几十片不会把上传配额吃光）、`401` 游客上传被关、`411` 请求没有 `Content-Length`（文件上传、文本表单、JSON 与缩略图都要求已知长度）、`422` 分片序号越界 / 片长与账面对不上 / 缺片 / 有效期或下载次数非法（天数 1–3650，次数 1–1,000,000 或 -1）、`409` 缩略图已存在不可覆盖、`415` 缩略图格式或尺寸不支持。`config/get` 会一并回报 `maxTotalStorage`（`"0"` = 不限）与 `storageUsed`。

### 网页接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 首页（发件 + 取件） |
| GET | `/r/:code` | 取件页；带 `?sent=1` 是上传者落地页（无下载入口） |
| POST | `/api/upload` | 文件上传，返回 `{code, filename, size}` |
| POST | `/api/upload/text` | 文本上传，返回 HTML 结果页 |
| POST | `/api/upload/chunk/init` | 开一个分片会话（校验大小/配额、预占取件码），返回会话句柄 `session` 与片数 |
| PUT | `/api/upload/chunk/:session/:part` | 上传一片 16 MiB（末片是余数）；片长由服务端按会话行核对，请求体直接流进 R2 multipart 会话 |
| GET | `/api/upload/chunk/status/:session` | 已收到哪些片号，供重试时跳过 |
| POST | `/api/upload/chunk/complete/:session` | 合并收尾，返回 `{code, filename, size}` |
| POST | `/api/upload/chunk/abort/:session` | 放弃会话，释放预留的取件码与配额 |
| GET | `/api/text/:code` · `/api/download/:code` | 取文本 / 下载文件（支持 HEAD） |
| GET | `/api/info/:code` | 文件信息（JSON） |
| GET | `/api/codes/:count` | 为多文件批次取一段未被占用的连号码（2–10） |
| GET / POST | `/api/thumb/:code` | 读取 / 写入图片缩略图 |
| GET | `/qrcode/:code` | 取件链接二维码（GIF） |
| GET | `/admin` · `/admin/settings` | 后台面板（含进行中的分片会话列表）与设置页 |
| POST | `/admin/login` · `/admin/delete/:id` · `/admin/cleanup` | 登录 / 删除 / 手动清理（含放弃超时未完成的分片） |
| POST | `/admin/chunk/abort` · `/admin/chunk/abort-all` | 放弃单个（`upload_id` 走表单）/ 全部未完成的分片会话 |

> 未匹配的 `/api/*` 返回 404 JSON，其余任意路径兜底渲染首页。登录有两个入口：`/admin/login` 是浏览器表单（重定向），`/api/admin/login` 是 JSON（返回 token）。

---

## 🧑‍💻 使用

**发件** — 拖入文件或粘贴 → 需要时展开「额外发件设置」调整有效期 / 最大下载次数 / 自定义取件码 → 点「发件并获取取件码」。多个文件会各自拿到一段连号的码，此时自定义取件码输入框不可用（一个码只能对应一个文件）。

**大文件** — 超过 64 MiB 的文件会自动切成 16 MiB 的分片并发上传（3 路），单片失败只重传那一片，不必整个文件重来。分片由 R2 在存储侧合并成一个对象，所以取件码、后台记录、下载次数、过期清理都与普通文件完全一致。单次会话最多 1000 片（约 16 GiB）。阈值/片大小这两个数都在 `src/chunk.ts` 里单点定义：片越大越省（每片有固定开销：取会话 + 记账各一次 D1 往返），代价是一片失败要重传整片；阈值以下保持单请求，少两次往返。

**为什么字节不能过 JS** — Cloudflare 每次请求的 CPU 上限是算"连续执行的一段"（await I/O 时计时会停），Free 计划只有 10 ms。在 Worker 里逐块搬 8 MiB 正好是一整段不中断的 memcpy，线上表现是同一份文件随机某几片 `503 / Error 1102 exceededCpu`，而且成败取决于那一片的字节在 Worker 开始读之前到齐了没有 —— 网络快反而更容易死。所以两条上传路径都把 `request.body` 原样交给 R2，JS 只 await 一个 Promise；长度必须来自 `Content-Length`（单文件）或会话记录里算出的片长（分片），拿不到就 411，而不是把文件读进内存。

**没传完的分片怎么清** — 未合并的 multipart 会话**不是一个对象**：R2 面板里看不到它，删文件、删对象都够不着，只有 `abort` 能释放，而它已经在按存储计费。本项目有三条清理路径：浏览器在传失败或页面被关掉时自己 abort；每 30 分钟的定时任务放弃超过 6 小时未完成的会话（「清理过期文件」按钮也会顺带做一次）；`/admin` 顶部会列出所有进行中的分片会话（文件名、声明大小、已传片数、挂起时长），可以逐条「放弃」或一次「全部放弃」。

分片接口用的句柄（`session`）是服务端自己生成的 32 位十六进制，**不是** R2 的 `uploadId`：后者是 base64 家族的任意串，字符集和长度都不由我们决定，放进 URL 迟早被某一环（转义、二次解码、按 `/` 切段）改写成一个查不到的键，表现是每片都失败、进度永远 0/N，而会话已经在桶里计费。真实 `uploadId` 只存在 D1 与服务端内存里，后台放弃时走表单字段而不是路径。

万一某次崩溃让会话连 D1 记录都没留下（Workers API 无法列举 multipart，应用就再也看不见它），只能用 R2 的 S3 兼容接口手动清理：`aws s3api list-multipart-uploads --bucket <桶名>` 找到 `Key` 与 `UploadId`，再 `aws s3api abort-multipart-upload --bucket <桶名> --key <Key> --upload-id <UploadId>`。endpoint 是 `https://<AccountID>.r2.cloudflarestorage.com`，凭证在 R2 → Manage R2 API Tokens 里创建，需要 Object Read & Write 权限。

**取件** — 首页顶部输入 4 位码，填满即自动取件。文本在线看，文件点「下载文件」。

**后台** — `/admin` 看统计与文件列表；`/admin/settings` 改三项设置，**保存即生效，不用重新部署**：

| 设置 | 作用 |
|------|------|
| 游客上传 | 关闭后匿名上传（网页 + 兼容 API）全部被拒，管理员仍可上传 |
| 单文件大小上限（MB） | 覆盖 `MAX_FILE_SIZE`；清空即回退到配置文件里的值 |
| 默认过期天数 | 覆盖 `DEFAULT_EXPIRE_DAYS` |
| R2 总占用上限（MB） | 已用空间达到上限后拒绝新的上传与文本分享（返回 507），已有文件不受影响；留空或 0 = 不限制 |
| Turnstile 人机验证 | 开启后游客上传需要先完成验证（1 小时内复用）；需先配置 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` |

两个大小设置都以 **MB** 为单位填写（可填小数），落库仍是字节 —— `fc_settings`、服务端比较与兼容 API 的 `maxFileSize` / `maxTotalStorage` 字段都按字节走，只有表单换算了单位。

限制值的生效优先级：**后台设置 > `wrangler.jsonc` 的 `vars` > 内置兜底（25 MB / 7 天）**；非法或非正整数的值会被忽略并落到下一级。首页会显示当前生效的上限，超限文件在列表里就被标红拦下。

单文件上限还有一条软件管不住的平台边界：Cloudflare 的**单次请求体上限**按账号套餐为 100 MB（Free / Pro）、200 MB（Business）、5 GB（Enterprise）。本项目对超过 64 MiB 的文件走分片通道，每片只有 16 MiB，因此这条上限基本碰不到，总上限可以按需要设得更大。

### 存储配额怎么算

后台的「R2 总占用上限」读的是 `fc_settings.storage_used` 计数器：上传时加、删除与过期清理时减，判断是 O(1)，不会为了算用量去扫桶。每 30 分钟的定时任务在用 R2 实测值对账一次（顺带清理孤儿对象），管理员也可以点后台的「手动清理」立即对账。统计口径是本应用写入的对象（主文件 + 缩略图），不含你手动放进桶里的其他文件。

R2 免费额度为 10 GiB 存储，超出部分按量计费且**不会自动熔断**，所以这个上限更像是预算保护而不是软限制。

### 配置项

| 变量 | 位置 | 默认 | 说明 |
|------|------|------|------|
| `ADMIN_PASSWORD` | Secret | 无 | 管理员密码；未设置则无法登录后台 |
| `MAX_FILE_SIZE` | `vars` | `104857600` | 单文件上限（字节），即 100 MB |
| `DEFAULT_EXPIRE_DAYS` | `vars` | `7` | 未指定过期参数时的默认天数 |
| `TURNSTILE_SITE_KEY` | Secret/Variable | 无 | 可选；Turnstile 公开 Site Key |
| `TURNSTILE_SECRET_KEY` | Secret | 无 | 可选；Turnstile Secret Key，同时用于签名游客验证 cookie |
| `triggers.crons` | `wrangler.jsonc` | `*/30 * * * *` | 建表、清理过期文件与孤儿对象、清理限流记录 |

### 本地开发

```bash
npm install
npx wrangler login
npm run provision     # 创建或复用 D1 / R2，回填 database_id 并建表
npm run dev           # http://localhost:8787
```

`wrangler dev` 要求 `database_id` 非空（留空会直接崩溃），所以本地开发前先跑一次 `npm run provision`。

改代码时有两个坑：

- 样式是 `src/templates/style.ts` 里的一个字符串，且响应带 `immutable` 长缓存；`layout.ts` 会用内容哈希自动生成 `style.css?v=...`，改样式无需手工递增版本号。
- 页面脚本写在 JS 模板字符串里，正则中的 `\/` 会被模板吃掉一层转义，容易生成非法正则；改用不含斜杠的写法或再转义一次。

已知工具链问题：本地 `wrangler dev` 的 miniflare proxy 遇到 **chunked 请求体**（无 Content-Length）会整体崩掉，日志里只有一条空 ERROR。这是 wrangler 的问题不是应用缺陷，但也意味着"没有 Content-Length 时走缓冲回退"这条分支在本地测不到。

### 测试

```bash
npm run typecheck     # tsc --noEmit
npm test              # 主流程冒烟（Playwright 无头）
npm run test:ui       # UI 回归：视觉结构 / 上传交互 / 后台设置 / 缩略图 / 分片 / 安全加固，共 183 项断言
```

用例假设本地服务已启动且表已建好：

```bash
npx wrangler d1 execute filecodebox-db --local --file=./schema.sql --yes
printf 'ADMIN_PASSWORD=test-admin-pw\n' > .dev.vars
npx wrangler dev --port 8790
BASE_URL=http://127.0.0.1:8790 npm run test:ui
```

这些用例会**真实上传文件并修改后台设置**，因此默认只允许打本机地址；测自己的线上环境需显式加 `ALLOW_REMOTE=1`。可用环境变量：`BASE_URL`、`ADMIN_PASSWORD`、`SHOT_DIR`（输出全页截图）。

本地测试会给每个页面上下文分配独立的伪 `CF-Connecting-IP`，让上传/查询限流桶互不干扰，因此默认不再每次等待 60 秒限流窗口；完整的 183 项回归通常 2–4 分钟跑完。测远程时 Cloudflare 会覆盖这个头，需要加 `REAL_RATE_LIMITS=1` 恢复「共享真实 IP + 等待窗口」的串行模式；`SKIP_RATE_WAIT=1` 只在该模式下跳过等待。

---

## 📁 项目结构

```
src/
├── index.ts          # 网页路由 + Cron 清理
├── api.ts            # FileCodeBox v2.1.0 兼容 API
├── shared.ts         # 上传 / 下载 / 缩略图 / 连号码 / 生效上限（单一业务逻辑源）
├── chunk.ts          # 分片上传：会话、逐片流进 R2 multipart、合并收尾
├── db.ts             # D1 读写、取件码抢占、限流、清理
├── auth.ts           # 登录 / 登出 / 密码哈希
├── qr.ts             # 二维码封装
├── types.ts utils.ts
└── templates/        # 服务端渲染的页面与样式（无构建步骤）
scripts/provision.mjs # 创建或复用 D1 / R2，回填 database_id，执行 schema.sql
schema.sql            # 表结构（全语句幂等，可重复执行）
wrangler.jsonc        # Cloudflare 配置（资源名在此声明，不含账号 ID）
tests/                # Playwright 回归套件
test-headless.mjs     # 主流程冒烟
LICENSE               # MIT（本仓库自行编写的代码）
FORK_NOTICE.md        # fork 来源与许可关系说明
```

## 📄 许可

本仓库新增的代码以 **MIT License** 发布，全文见 [LICENSE](LICENSE)。

本仓库 fork 自 [jeio258/FileCodeBox-worker](https://github.com/jeio258/FileCodeBox-worker)，
后者是 [FileCodeBox](https://github.com/vastsa/FileCodeBox)（LGPL-3.0）的 Cloudflare Workers 重写版。
继承部分与本 fork 新增部分的边界、以及上游仓库未附许可文件这一注意事项，见
[FORK_NOTICE.md](FORK_NOTICE.md)。
