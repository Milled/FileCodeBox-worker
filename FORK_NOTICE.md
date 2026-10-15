# Fork 来源说明

本仓库 fork 自 **[jeio258/FileCodeBox-worker](https://github.com/jeio258/FileCodeBox-worker)**
（首个提交 `c3e19ab`，2026-07-14），后者是
[vastsa/FileCodeBox](https://github.com/vastsa/FileCodeBox)（Python / FastAPI，**LGPL-3.0**）
的 Cloudflare Workers 重写版。

## 继承与新增

**继承自 jeio258/FileCodeBox-worker**

- Cloudflare Workers + Hono + D1 + R2 的整体架构与零构建的服务端渲染方式
- 上传 / 取件 / 下载 / 过期清理的核心实现，以及 FileCodeBox v2.1.0 兼容 API

**本 fork 的工作**

- 部署：D1 / R2 自动开通脚本、幂等 `schema.sql`、配置中去账号化、清理原作者域名与个人信息
- 后台：统计仪表盘、系统设置页，并让 `openUpload` 与大小上限真正全局生效
- 界面：移植上游 2024 主题的视觉语言（中性 zinc + 黑色主按钮 + 纯色底），
  加入拖拽 / 粘贴 / 多文件、有效期方式选择器、四格分离取件码、发件与取件落地页
- 图片缩略图（浏览器端生成，服务端不解码）
- Playwright 回归套件（118 项断言）

## 许可

- 本仓库**新增**的代码以 [MIT License](LICENSE) 发布。
- **需要注意的边界**：fork 时 `jeio258/FileCodeBox-worker` 仓库未附带 LICENSE 文件，
  其原始代码默认保留所有权利。在取得原作者许可、或确认其仓库条款允许之前，
  把整个仓库（含继承部分）当作 MIT 对外分发存在风险。本文件用于明确这条边界。
- 概念、数据模型与 API 形态来自 `vastsa/FileCodeBox`（LGPL-3.0）；本仓库不含其任何源文件，
  两者语言与运行时均不同。

感谢 [jeio258](https://github.com/jeio258) 与 [vastsa](https://github.com/vastsa) 及各自的贡献者。
