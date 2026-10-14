# FileCodeBox Worker

> 像取快递一样取文件 — Cloudflare Workers 重写版

基于 [FileCodeBox](https://github.com/vastsa/FileCodeBox) 的 Cloudflare Workers 移植版，无需服务器，免费部署在 Cloudflare 边缘网络。

## ✨ 功能

- 📤 **上传文件** — 获取 4 位纯数字取件码，存入 R2 对象存储（上限可配置，见[上传大小与过期配置](#上传大小与过期配置)）
- 📝 **文本分享** — 粘贴文本即可生成分享链接，页面内直接查看
- 📥 **取件下载** — 输入取件码下载文件或查看文本
- 🔐 **管理面板** — 查看/删除/清理文件，登录速率限制
- ⏰ **自动过期** — 文件到期自动清理（Cron 定时触发）
- 🎨 **暖纸墨色设计** — 琥珀色调 + 文学感排版，支持深色模式
- 🔌 **开放 API** — 兼容 FileCodeBox v2.1.0，免登录游客上传

## 🛡️ 安全特性

经过多轮代码审查加固，具备以下安全能力：

- **XSS 防护** — 所有用户输入经 `escapeHtml()` 转义
- **密码安全** — PBKDF2 10 万次迭代哈希 + 常数时间比较（防时序攻击）
- **登录限流** — 60 秒窗口内最多 5 次尝试（按客户端 IP）
- **取件码安全** — CSPRNG 生成 + 防碰撞检测 + 删除/过期后释放复用
- **SQL 注入防护** — 全部使用参数化查询
- **CSP 安全头** — 限制资源加载来源，降低 XSS 影响面
- **文件删除顺序** — R2 先删、DB 兜底（try/finally），避免孤儿文件

## 📦 部署方式

### 方式一：Wrangler CLI 部署（推荐本地开发）

#### 1. 准备工作

- [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
- [Node.js 18+](https://nodejs.org/)

#### 2. 安装 Wrangler 并登录

```bash
npm install -g wrangler
wrangler login
```

#### 3. 克隆项目 & 安装依赖

```bash
git clone https://github.com/Milled/FileCodeBox-worker.git
cd FileCodeBox-worker
npm install
```

#### 4. 自动开通 D1 与 R2

`wrangler deploy` 本身不会创建云资源，本仓库提供 `npm run provision` 幂等地完成创建与绑定：

```bash
npm run provision
```

脚本按 `wrangler.jsonc` 里声明的资源名执行（全程走 `wrangler` 命令，不经过 shell）：

1. `wrangler whoami --json` 校验登录状态 —— 实测未登录时 `whoami` 仍返回退出码 0，所以只信它的 `loggedIn` 字段
2. 存在 `filecodebox-db` 就复用，不存在则 `wrangler d1 create`（从输出中抓取 UUID）
3. 存在 `filecodebox-file` 就复用，不存在则 `wrangler r2 bucket create`
4. 把返回的 `database_id` 回填进 `wrangler.jsonc`（正则改写，保留注释）
5. 对新库执行 `schema.sql` 建表 —— 空库上后台登录会因缺 `fc_settings` 表直接 500

可选参数：

```bash
npm run provision -- --dry-run        # 只报告将要执行的动作，不创建、不写文件
npm run provision -- --location=apac  # 指定 D1 主位置（weur/eeur/apac/oc/wnam/enam），跳过交互询问
```

想换资源名或 Worker 名，直接改 `wrangler.jsonc` 后重跑 `npm run provision`：

```jsonc
{
  "name": "filecodebox",              // 同一账号内必须唯一，冲突时改名
  "d1_databases": [{
    "binding": "DB",
    "database_name": "filecodebox-db",
    "database_id": ""                 // 留空即可，由 provision 回填
  }],
  "r2_buckets": [{
    "binding": "FILE_STORE",
    "bucket_name": "filecodebox-file"
  }]
}
```

> - 配置中**不写 `account_id`**，wrangler 会使用 `wrangler login` 的当前账号（多账号时交互式选择）。
> - 若 wrangler 创建 D1 后询问「是否写入配置文件」，请选 **No**：由脚本回填，否则会追加一条重复的 `binding = DB` 导致部署失败。
> - R2 需在 Cloudflare 控制台首次接受服务条款后才能通过 API 创建，否则创建存储桶这一步会失败并给出提示。

#### 5. 设置管理员密码（Secret，不写入配置）

```bash
wrangler secret put ADMIN_PASSWORD
# 输入你的管理员密码
```

未设置该 Secret 时，后台登录会被拒绝并提示「未配置管理员密码」。

#### 6. 部署

```bash
npm run deploy
```

表结构已由第 4 步的 `schema.sql` 建好。若跳过 provision，Cron 每 30 分钟也会幂等补建，但**别指望部署后立刻访问 `/api/init`**：该接口要求管理员身份，而登录又要读 `fc_settings` 表，空库上两者都会 500（实测如此）。

---

### 方式二：Cloudflare Dashboard Git 集成（推送自动部署）

> Git 集成只负责构建和发布，**同样不会创建 D1 / R2**。请先在本地跑一次 `npm run provision`（方式一第 4 步）把资源和 `database_id` 准备好，再连接仓库。

#### 1. Fork 本项目到自己的 GitHub

#### 2. 在 Cloudflare Dashboard 操作

1. 进入 **Workers & Pages** → **创建** → **Pages** → **连接到 Git**
2. 选择你的仓库，构建设置：
   - **构建命令**：`npm install`
   - **输出目录**：留空
3. 点击保存，首次部署会失败（缺少 R2 / D1 绑定）—— 这是正常的

#### 3. 绑定资源

部署后进入项目 **Settings** → **Bindings**：

**R2 存储桶绑定：**

| Binding | 说明 |
|---------|------|
| `FILE_STORE` | 选择已有的 R2 存储桶，默认名称 `filecodebox-file` |

**D1 数据库绑定：**

| Binding | 数据库 |
|---------|--------|
| `DB` | 选择已有的 D1 数据库，默认名称 `filecodebox-db` |

**Vars（非 Secret）：**

| 变量 | 说明 |
|------|------|
| `MAX_FILE_SIZE` | 单文件上限（字节），默认 `26214400` |
| `DEFAULT_EXPIRE_DAYS` | 默认过期天数，默认 `7` |

**Secret（管理员密码）：**

| Secret | 说明 |
|--------|------|
| `ADMIN_PASSWORD` | 你的管理员密码 |

#### 4. 重新部署

绑定资源后，在 Pages 项目页面点击 **重新部署**（或推送新 commit 自动触发）。

#### 5. 初始化数据库

用命令直接建表最可靠：

```bash
npx wrangler d1 execute filecodebox-db --remote --file=./schema.sql --yes
```

不要用 `/api/init` 做首次初始化 —— 它要求管理员身份，而登录要读 `fc_settings` 表，空库上两者互相卡死（都返回 500）。兜底方案是等 Cron 每 30 分钟自动幂等建表。

---

### 常见问题

#### Build token 过期

```
Failed: The build token selected for this build has been deleted or rolled
```

在 Cloudflare Dashboard → **Workers & Pages** → 你的项目 → **Settings** → **Builds** → 重新生成 Build token 并重试部署。

#### 绑定自定义域名

Pages 项目 → **Custom domains** → 添加你的域名（需 DNS 已托管在 Cloudflare）。

---

## 🔌 API 接口

项目提供两套 API：**Web UI 接口**（页面交互）和 **FileCodeBox 兼容 API**（程序调用）。

### FileCodeBox 兼容 API（v2.1.0）

兼容 [FileCodeBox API v2.1.0](https://fcb-docs.aiuo.net/api/)，统一响应格式 `{ code, msg, detail }`。整套兼容 API 挂载在 `/api` 前缀下（`src/api.ts` 注册、`src/index.ts` 中 `app.route('/api', api)`），因此实际路径是 `/api/share/file`、`/api/admin/dashboard` 等；带与不带结尾斜杠两种写法都已注册。

#### 分享接口（默认免登录，可配置关闭）

```bash
# 上传文件
curl -X POST "https://你的域名/api/share/file/?expire_value=1&expire_style=day" \
  -H "X-Filename: example.txt" \
  --data-binary @example.txt

# 分享文本（表单）
curl -X POST "https://你的域名/api/share/text/" \
  -F "text=要分享的内容" -F "expire_value=1" -F "expire_style=day"

# 获取文件信息
curl "https://你的域名/api/share/select/?code=1234"

# 下载文件
curl "https://你的域名/api/share/download?code=1234"
```

**expire_style** 支持：`day` / `hour` / `minute` / `count`（限下载次数）/ `forever`

#### 管理接口（需 Bearer token）

```bash
# 登录获取 token（JSON 响应）
curl -X POST "https://你的域名/api/admin/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"你的密码"}'
# 返回 { code: 200, msg: "success", detail: { token: "xxx", token_type: "Bearer" } }

# 仪表盘
curl "https://你的域名/api/admin/dashboard" \
  -H "Authorization: Bearer <token>"

# 文件列表（分页 + 关键词搜索）
curl "https://你的域名/api/admin/file/list?page=1&size=10&keyword=xxx" \
  -H "Authorization: Bearer <token>"

# 删除文件
curl -X DELETE "https://你的域名/api/admin/file/delete?id=123" \
  -H "Authorization: Bearer <token>"

# 获取配置（返回当前实际生效的值）
curl "https://你的域名/api/admin/config/get" \
  -H "Authorization: Bearer <token>"

# 更新配置（PATCH）
curl -X PATCH "https://你的域名/api/admin/config/update" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"openUpload":"1","maxFileSize":"26214400","defaultExpireDays":"7"}'
```

---

### Web UI 接口（页面交互）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 首页（上传 + 取件）|
| GET | `/r` | 取件页；带 `?code=1234` 时 302 跳到 `/r/1234` |
| GET | `/r/:code` | 取件页（文件详情 / 文本查看）|
| POST | `/api/upload` | 文件上传（XHR，返回 JSON `{code, filename, size}`）|
| POST | `/api/upload/text` | 文本上传（表单，返回 HTML 结果页）|
| GET | `/api/text/:code` | 获取文本内容（纯文本）|
| GET / HEAD | `/api/download/:code` | 下载文件（带 Content-Disposition）|
| GET | `/api/info/:code` | 文件信息（JSON）|
| GET | `/qrcode/:code` | 取件链接二维码（GIF）|
| GET | `/static/style.css` | 样式表（immutable 长缓存）|
| GET | `/static/bg.webp` | 背景图，需自行上传到 R2 根目录，否则 404 |
| GET | `/admin` | 管理面板（受保护）|
| POST | `/admin/login` | 管理员登录（HTML 表单，成功后 302 到 `/admin`）|
| GET | `/admin/logout` | 管理员登出（清除 Cookie 与 DB token）|
| POST | `/admin/delete/:id` | 删除文件（表单，按数据库 id）|
| POST | `/admin/cleanup` | 手动清理过期文件 |
| GET | `/api/init` | 幂等建表（需管理员身份；空库上不可用，见部署方式一第 4 步）|
| GET | `/console` | 兼容旧路径，302 到 `/admin` |
| GET | `/api/console/logout` | 兼容旧路径，302 到 `/admin/logout` |

> - 登录入口有两套：`/admin/login` 是浏览器表单（302 重定向），`/api/admin/login` 是 JSON API（返回 Bearer token）。
> - 未匹配的 `/api/*` 返回 `{"code":404,"msg":"Not Found"}`，其余任意路径兜底渲染首页。
> - `openUpload` 开关只拦截 `/api/share/*` 兼容接口，首页的 `/api/upload`、`/api/upload/text` 不受该开关限制。

---

## 🧑‍💻 使用

| 页面 | 路径 | 说明 |
|------|------|------|
| 首页 | `/` | 上传文件 + 文本分享 + 取件码输入 |
| 取件 | `/r/1234` | 文件详情 / 文本查看 + 下载 |
| 管理 | `/admin` | 管理员登录 |

### 本地开发与测试

```bash
npm run typecheck    # tsc --noEmit
npm run dev          # wrangler dev，默认 http://localhost:8787（本地模拟 D1 / R2）
npm test             # Playwright 无头浏览器跑完整取件流程，默认打本地
```

`wrangler dev` 要求 `database_id` 非空，配置留空会直接崩溃，实测报 `The expression evaluated to a falsy value: (databaseId)`。两种解法：

- **有 Cloudflare 账号**：跑一次 `npm run provision` 回填真实 ID，本地依旧用模拟存储，不产生线上写入。
- **完全离线**：临时把 `database_id` 填成任意合法 UUID（**不要提交**），再建本地表并准备密码：
  ```bash
  npx wrangler d1 execute filecodebox-db --local --file=./schema.sql --yes
  echo 'ADMIN_PASSWORD=你的本地密码' > .dev.vars   # 已在 .gitignore 中
  ```
- 测线上环境：`BASE_URL=https://你的域名 npm test`（会真实写入该环境的 D1 / R2）

### 背景图与站点图标

页面背景当前由 `src/templates/style.ts:83` 直接引用第三方随机图接口 `https://t.alcy.cc/ycy`（每次访问可能换图，且依赖该站可用性）。若要固定背景、去掉外部依赖，把图片传到 R2 根目录，再把 `background-image` 改成站内已实现的 `/static/bg.webp` 路由（`src/index.ts` 从 R2 读取，带 immutable 长缓存）：

```bash
npx wrangler r2 object put filecodebox-file/bg.webp --file=./bg.webp --content-type=image/webp
```

站点图标是 `src/templates/layout.ts` 里内联的 SVG data URI，不依赖任何外部图床，改图标直接替换那段 SVG 即可。

> 改完样式后请把 `layout.ts` 中的 `style.css?v=8` 版本号递增，否则浏览器与 CDN 会继续命中旧缓存。

### Cron 定时清理

项目已内置 `scheduled` handler，在 wrangler.jsonc 的 `triggers.crons` 中配置：

```jsonc
"triggers": { "crons": ["*/30 * * * *"] }
```

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ADMIN_PASSWORD` | - | 管理员密码（**Secret**，`wrangler secret put` 设置；未设置时无法登录后台） |
| `MAX_FILE_SIZE` | `26214400` | 单文件上限（字节），即 25MB；写在 `wrangler.jsonc` 的 `vars` 中 |
| `DEFAULT_EXPIRE_DAYS` | `7` | 未指定过期参数时的默认天数 |

## 上传大小与过期配置

上限**不写死在代码里**，按以下优先级解析（见 `src/shared.ts` 的 `resolveLimits()`）：

1. 数据库 `fc_settings` 中管理员后台写入的值 —— `PATCH /api/admin/config/update`
   ```json
   { "maxFileSize": "52428800", "defaultExpireDays": "30", "openUpload": "1" }
   ```
2. `wrangler.jsonc` 的 `vars`（或 Dashboard 里的 Vars）—— `MAX_FILE_SIZE` / `DEFAULT_EXPIRE_DAYS`
3. 内置兜底 —— 25MB / 7 天

非正整数或无法解析的值会被忽略并落到下一级，避免出现 `NaN` 绕过校验。`GET /api/admin/config/get` 返回的是**实际生效值**，不是原始配置。

修改方式：

| 场景 | 做法 |
|------|------|
| 长期默认值 | 改 `wrangler.jsonc` 的 `vars.MAX_FILE_SIZE` 后 `npm run deploy` |
| 部署后随时调整 | `PATCH /api/admin/config/update`（需 Bearer token，立即生效，无需重新部署） |

直接改数据库也可以：`npx wrangler d1 execute filecodebox-db --remote --command "INSERT OR REPLACE INTO fc_settings(key,value) VALUES('max_file_size','52428800')"`。

另外两处独立限制：文本分享正文最大 512KB（`src/shared.ts`），单 IP 上传限流 10 次 / 60 秒（`checkRateLimit`）。

## 📁 项目结构

```
FileCodeBox-worker/
├── src/
│   ├── index.ts               # 主程序 — Web UI 路由 + Cron 清理
│   ├── api.ts                 # FileCodeBox v2.1.0 兼容 API
│   ├── shared.ts              # 共享业务逻辑（上传/下载/过期/取件码/生效上限，单一数据源）
│   ├── auth.ts                # 认证: 登录/登出/速率限制
│   ├── db.ts                  # 数据库: 增删改查 + 取件码抢占 + 限流 + 清理
│   ├── qr.ts                  # 二维码 GIF 封装
│   ├── types.ts               # 类型定义
│   ├── utils.ts               # 工具: 取件码/哈希/IP 提取/HTML 转义
│   └── templates/
│       ├── layout.ts          # HTML 布局
│       ├── style.ts           # 暖纸墨色设计系统 CSS
│       └── pages.ts           # 页面模板
├── scripts/
│   └── provision.mjs          # 自动创建 D1 / R2、回填 database_id 并执行 schema.sql
├── schema.sql                 # 表结构（全语句幂等，可重复执行）
├── wrangler.jsonc             # Cloudflare 配置（资源名在此声明）
├── tsconfig.json
└── package.json
```

## 🏗️ 架构设计

- **单一业务逻辑源**：`shared.ts` 统一实现上传/下载/过期/取件码逻辑，`index.ts` 和 `api.ts` 均为薄路由封装
- **取件码复用机制**：4 位码删除/过期后通过 `releaseCode()` 释放，可循环使用
- **上传实现**：`arrayBuffer()` 一次性读取请求体（body 只能消费一次），计算大小后转 `Blob` 流写入 R2
- **下载计数**：`incrementDownload` 原子更新，避免并发超限
- **过期清理**：Cron 每 30 分钟触发 `cleanupExpired`，并发删除 R2 + DB 记录
- **配置生效层**：后台 DB 设置 > wrangler vars > 内置兜底，由 `resolveLimits()` 统一解析，避免接口回报值与实际执行值不一致
- **资源绑定**：`wrangler.jsonc` 只声明资源名称，`database_id` 由 `npm run provision` 创建后回填，配置里不含任何账号 ID

## 🔧 技术栈

- **框架**: [Hono](https://hono.dev/)
- **数据库**: Cloudflare D1 (SQLite)
- **存储**: Cloudflare R2
- **运行时**: Cloudflare Workers
- **语言**: TypeScript（严格模式）

## 📄 许可

MIT License
