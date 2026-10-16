/** 中性 zinc 设计系统 — 对齐上游 FileCodeBoxFronted（2024 主题）main.css */
export const STYLE = `
:root {
  /* ---- typography ---- */
  --font-display: "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, system-ui, sans-serif;
  --font-body:    "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, system-ui, sans-serif;
  --font-mono:    "SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace;

  /* ---- colors: light (zinc) ---- */
  --color-paper:        rgb(245 245 247);  /* 页面底色 */
  --color-paper-2:      rgb(255 255 255);  /* 控件/浮层底 */
  --color-paper-3:      rgb(244 244 245);  /* hover / muted 面 */
  --color-rule:         rgb(228 228 231);
  --color-rule-strong:  rgb(161 161 170);
  --color-muted:        rgb(113 113 122);
  --color-ink:          rgb(24 24 27);
  --color-ink-2:        rgb(82 82 91);
  --color-accent:       rgb(24 24 27);      /* 主按钮底色（近黑） */
  --color-accent-hover: rgb(63 63 70);
  --color-accent-soft:  rgb(24 24 27 / 0.06);
  --color-accent-contrast: rgb(255 255 255); /* 主按钮文字 */
  --color-surface:      rgb(255 255 255);
  --color-focus:        rgb(113 113 122);
  --focus-ring:         rgb(24 24 27 / 0.20);
  --color-success:      rgb(4 120 87);
  --color-warning:      rgb(217 119 6);
  --color-danger:       rgb(220 38 38);

  /* ---- glass + elevation ---- */
  --surface-glass:  rgb(255 255 255 / 0.78);
  --border-glass:   rgb(255 255 255 / 0.70);
  --shadow-panel:   0 24px 70px -28px rgb(24 24 27 / 0.18);
  --hairline:       linear-gradient(90deg, transparent, rgb(255 255 255 / 0.85), transparent);

  /* ---- shape ---- */
  --radius: 8px;
  --radius-control: 12px;
  --radius-card: 2rem;

  /* ---- motion ---- */
  --ease-out:  cubic-bezier(0.16, 1, 0.3, 1);
  --dur-micro: 120ms;
  --dur-short: 220ms;
  --dur-long:  420ms;

  color-scheme: light;
}

/* ---- dark mode（跟随系统，无手动开关） ---- */
@media (prefers-color-scheme: dark) {
  :root {
    --color-paper:        rgb(16 16 18);
    --color-paper-2:      rgb(24 24 27);
    --color-paper-3:      rgb(39 39 42);
    --color-rule:         rgb(63 63 70);
    --color-rule-strong:  rgb(113 113 122);
    --color-muted:        rgb(113 113 122);
    --color-ink:          rgb(228 228 231);
    --color-ink-2:        rgb(161 161 170);
    --color-accent:       rgb(244 244 245);   /* 深色下主按钮近白 */
    --color-accent-hover: rgb(212 212 216);
    --color-accent-soft:  rgb(244 244 245 / 0.10);
    --color-accent-contrast: rgb(9 9 11);
    --color-surface:      rgb(24 24 27);
    --color-focus:        rgb(161 161 170);
    --focus-ring:         rgb(244 244 245 / 0.26);
    --color-success:      rgb(52 211 153);
    --color-warning:      rgb(251 191 36);
    --color-danger:       rgb(248 113 113);

    --surface-glass:  rgb(24 24 27 / 0.82);
    --border-glass:   rgb(255 255 255 / 0.10);
    --shadow-panel:   0 24px 80px -32px rgb(255 255 255 / 0.18);
    --hairline:       linear-gradient(90deg, transparent, rgb(255 255 255 / 0.20), transparent);

    color-scheme: dark;
  }
}

*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
/* 作者样式里的 display（例如 .file-icon 的 inline-flex）会盖掉 UA 的 [hidden] 规则，
   缩略图加载失败时的图标回退全靠这一条兜底 */
[hidden] { display: none !important; }

body {
  font-family: var(--font-body);
  background-color: var(--color-paper);
  color: var(--color-ink);
  min-height: 100vh;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  transition: background-color 700ms var(--ease-out), color 700ms var(--ease-out);
}

::selection { background: var(--color-accent-soft); }

.container {
  max-width: 460px;
  margin: 0 auto;
  padding: 40px 16px 64px;
}
.container.container-wide {
  max-width: 720px;
}

.card {
  position: relative;
  background: var(--surface-glass);
  backdrop-filter: blur(24px) saturate(1.3);
  -webkit-backdrop-filter: blur(24px) saturate(1.3);
  border-radius: var(--radius-card);
  padding: 32px 28px;
  border: 1px solid var(--border-glass);
  box-shadow: var(--shadow-panel);
  overflow: hidden;
  animation: cardIn var(--dur-long) var(--ease-out) both;
}
/* 顶部 1px 渐变 hairline（上游卡片高光边） */
.card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  background: var(--hairline);
  pointer-events: none;
}

@keyframes cardIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ---- header ---- */
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 28px;
  padding-top: 8px;
}
.header h1 {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  color: var(--color-ink);
  letter-spacing: -0.4px;
}
.header p {
  font-size: 13px;
  color: var(--color-ink-2);
  margin-top: 4px;
}

/* ---- header 操作按钮 ---- */
.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.header-actions a {
  font-size: 13px;
  color: var(--color-ink-2);
  text-decoration: none;
  padding: 6px 12px;
  border-radius: var(--radius-control);
  transition: background var(--dur-short) var(--ease-out), color var(--dur-short) var(--ease-out);
  white-space: nowrap;
}
.header-actions a:hover {
  background: var(--color-paper-3);
  color: var(--color-ink);
}

/* ---- buttons ---- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 11px 18px;
  border: none;
  border-radius: var(--radius-control);
  font-size: 14px;
  font-family: var(--font-body);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur-short) var(--ease-out), color var(--dur-short) var(--ease-out),
              border-color var(--dur-short) var(--ease-out), opacity var(--dur-short) var(--ease-out),
              transform var(--dur-micro) var(--ease-out);
  text-decoration: none;
  line-height: 1;
}

.btn:focus-visible {
  outline: 3px solid var(--color-focus);
  outline-offset: 3px;
  transition: none;
}

.btn-primary {
  background: var(--color-accent);
  color: var(--color-accent-contrast);
  width: 100%;
}
.btn-primary:hover { background: var(--color-accent-hover); }
.btn-primary:active { background: var(--color-accent-hover); transform: scale(0.98); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-secondary {
  background: transparent;
  color: var(--color-ink);
  border: 1px solid var(--color-rule-strong);
  width: 100%;
}
.btn-secondary:hover { background: var(--color-paper-3); border-color: var(--color-ink); }

/* 与 btn-primary 同形（上游只有单一强调色） */
.btn-warm {
  background: var(--color-accent);
  color: var(--color-accent-contrast);
  width: 100%;
}
.btn-warm:hover { background: var(--color-accent-hover); }
.btn-warm:active { transform: scale(0.98); }

.btn-sm {
  padding: 7px 14px;
  font-size: 13px;
  width: auto;
}

.btn-danger {
  color: var(--color-danger);
  font-size: 13px;
  text-decoration: none;
  padding: 4px 8px;
  border-radius: var(--radius);
  transition: background var(--dur-short) var(--ease-out);
}
.btn-danger:hover { background: var(--color-accent-soft); }

/* ---- inputs ---- */
.input {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  font-size: 15px;
  font-family: var(--font-body);
  outline: none;
  transition: border-color var(--dur-short) var(--ease-out), box-shadow var(--dur-short) var(--ease-out);
  background: var(--color-paper-2);
  color: var(--color-ink);
}
.input::placeholder { color: var(--color-muted); }
.input:hover { border-color: var(--color-rule-strong); }
.input:focus {
  border-color: var(--color-focus);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.input-group {
  margin-bottom: 14px;
}
.input-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-ink-2);
  margin-bottom: 5px;
}

textarea.input {
  resize: vertical;
  min-height: 120px;
  line-height: 1.5;
}

select.input { appearance: none; padding-right: 32px; cursor: pointer; }

/* ---- tabs（结构保留：JS 与测试依赖 .tab[data-tab] / .tab-panel.active） ---- */
.tabs {
  display: flex;
  gap: 0;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--color-rule);
}
.tab {
  flex: 1;
  text-align: center;
  padding: 9px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-ink-2);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color var(--dur-short) var(--ease-out), border-color var(--dur-short) var(--ease-out);
  background: none;
  border-top: none;
  border-left: none;
  border-right: none;
  font-family: var(--font-body);
}
.tab:hover { color: var(--color-ink); }
.tab.active { color: var(--color-ink); border-bottom-color: var(--color-ink); }
.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* ---- upload progress ---- */
.upload-progress {
  height: 4px;
  background: var(--color-rule);
  border-radius: 2px;
  margin-top: 4px;
  margin-bottom: 10px;
  overflow: hidden;
  display: none;
}
.upload-progress-bar {
  height: 100%;
  background: var(--color-accent);
  border-radius: 2px;
  transition: width 0.2s var(--ease-out);
  width: 0;
}
.upload-status {
  font-size: 12px;
  color: var(--color-ink-2);
  text-align: center;
  margin-bottom: 10px;
  display: none;
}

/* ---- file icon ---- */
.file-icon {
  width: 56px;
  height: 56px;
  background: var(--color-accent);
  color: var(--color-accent-contrast);
  border-radius: var(--radius-control);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
  /* 发件成功页的内容框没有 align-items:center，靠这条保证两页的图标都居中 */
  align-self: center;
}
/* 图片预览：宽度不超过所在卡片，高度封顶 260px；
   align-self 防止在 flex 纵向容器里被 stretch 拉成整宽 */
.file-thumb {
  max-width: 100%;
  max-height: 260px;
  align-self: center;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  background: var(--color-paper-2);
  margin-bottom: 14px;
}

/* ---- file list ---- */
.file-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--color-paper-2);
  border-radius: var(--radius-control);
  margin-bottom: 6px;
  transition: background var(--dur-short) var(--ease-out), border-color var(--dur-short) var(--ease-out);
  gap: 8px;
  border: 1px solid var(--color-rule);
}
.file-list-item:hover {
  background: var(--color-paper-3);
  border-color: var(--color-rule-strong);
}
.file-list-item .fname {
  font-size: 13px;
  font-weight: 500;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-list-item .fmeta {
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--color-ink-2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.expired { opacity: 0.4; }

/* ---- footer ---- */
.footer {
  text-align: center;
  margin-top: 24px;
  font-size: 12px;
  color: var(--color-ink-2);
}
.footer a {
  color: var(--color-ink-2);
  text-decoration: none;
}
.footer a:hover { color: var(--color-ink); }
.footer a.github-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  transition: color var(--dur-short) var(--ease-out);
}

/* ---- share 双栏布局 ---- */
.share-grid {
  display: flex;
  gap: 32px;
  align-items: stretch;
}
.share-left {
  flex: 1.5;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.share-right {
  flex: 1;
  background: var(--color-accent-soft);
  border: 1px solid var(--color-rule);
  border-radius: 1.25rem;
  padding: 24px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.share-title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  color: var(--color-ink);
  word-break: break-all;
  margin-bottom: 14px;
}

/* 内容框：文本在上、操作按钮在下 */
.command-box {
  background: var(--color-paper-2);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  padding: 16px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 14px;
  flex-grow: 1;
}
.command-text {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 380px;
  overflow-y: auto;
  color: var(--color-ink);
}
.btn-copy-cmd {
  background: var(--color-accent-soft);
  color: var(--color-ink);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius);
  padding: 8px 14px;
  font-size: 12px;
  font-family: var(--font-body);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background var(--dur-short) var(--ease-out), transform var(--dur-micro) var(--ease-out);
  flex-shrink: 0;
  align-self: flex-end;
}
.btn-copy-cmd:hover { background: var(--color-paper-3); }
.btn-copy-cmd:active { transform: scale(0.96); }

/* 元信息：size · 下载次数 · 过期时间 */
.meta-row {
  font-size: 12px;
  color: var(--color-ink-2);
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.meta-row span { display: flex; align-items: center; }
.meta-row span::after { content: "·"; margin-left: 12px; color: var(--color-rule-strong); }
.meta-row span:last-child::after { display: none; }

/* 取件码卡：点击复制 */
.code-card {
  width: 100%;
  cursor: pointer;
  transition: background var(--dur-short) var(--ease-out), transform var(--dur-micro) var(--ease-out);
  padding: 10px 0;
  border-radius: var(--radius-control);
}
.code-card:hover { background: var(--color-accent-soft); }
.code-card:active { transform: scale(0.98); }
.code-label { font-size: 12px; color: var(--color-ink-2); margin-bottom: 8px; }
.code-value {
  font-size: 38px;
  font-weight: 700;
  color: var(--color-ink);
  letter-spacing: 6px;
  font-family: var(--font-mono);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.click-hint { font-size: 10px; color: var(--color-muted); margin-top: 6px; }

.share-divider {
  height: 1px;
  background: var(--color-rule);
  width: 80%;
  margin: 20px 0;
}

.qr-img {
  width: 110px;
  height: 110px;
  border-radius: 10px;
  border: 1px solid var(--color-rule);
  padding: 4px;
  background: #fff;
}
.qr-title { font-size: 12px; color: var(--color-ink-2); margin-top: 10px; }
.share-link-btn {
  margin-top: 14px;
  width: auto;
  display: inline-flex;
  padding: 9px 16px;
  font-size: 13px;
}

/* ---- 拖拽上传区 ---- */
.dz {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  padding: 28px 18px;
  border: 1px dashed var(--color-rule-strong);
  border-radius: 1.25rem;
  background: var(--color-paper-2);
  cursor: pointer;
  transition: border-color var(--dur-short) var(--ease-out), background var(--dur-short) var(--ease-out);
}
.dz:hover { border-color: var(--color-ink-2); }
.dz[data-dragging="true"] { border-color: var(--color-ink); background: var(--color-accent-soft); }
.dz:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 3px; }
.dz-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.dz-icon {
  width: 40px; height: 40px;
  border-radius: 50%;
  background: var(--color-accent);
  color: var(--color-accent-contrast);
  display: inline-flex; align-items: center; justify-content: center;
  margin-bottom: 4px;
}
.dz-title { font-size: 14px; font-weight: 600; color: var(--color-ink); }
.dz-hint { font-size: 12px; color: var(--color-ink-2); }

/* ---- 已选文件 ---- */
.file-chips { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.file-chips:empty { display: none; }
.file-chip {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  background: var(--color-paper-2);
  font-size: 13px;
}
.file-chip .chip-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-chip .chip-size { font-family: var(--font-mono); font-size: 12px; color: var(--color-ink-2); font-variant-numeric: tabular-nums; }
.file-chip .chip-remove {
  border: none; background: none; cursor: pointer;
  color: var(--color-muted); font-size: 16px; line-height: 1; padding: 2px 6px;
  border-radius: var(--radius);
  transition: background var(--dur-short) var(--ease-out), color var(--dur-short) var(--ease-out);
}
.file-chip .chip-remove:hover { background: var(--color-paper-3); color: var(--color-ink); }
/* 多文件批次里自定义码不可用（一个码只能对应一个文件），连号由服务端分配 */
.code-boxes.is-disabled { opacity: .45; }
.code-boxes.is-disabled .code-box { cursor: not-allowed; }

/* 超过发件上限的文件：允许留在列表里，但明确标红，提交时整批拦下 */
.file-chip.chip-over { border-color: var(--color-danger); }
.file-chip.chip-over .chip-size { color: var(--color-danger); }
/* 行内提示条：替代 alert，不阻断操作也能看清被拦下的是哪几个 */
.upload-notice { font-size: 13px; line-height: 1.6; color: var(--color-danger); margin-top: 8px; }

/* ---- 字段行 / 有效期控件 ---- */
.field-row { display: flex; gap: 12px; }
.field-row > .input-group { flex: 1; min-width: 0; }
/* 有效期是「数值 + 单位 + 步进」复合控件，给它更多宽度，否则数值格被挤到只剩几像素 */
.field-row > .input-group:has(.expire-control) { flex: 1.6; }
.expire-control { position: relative; display: flex; }
.expire-control .expire-value {
  flex: 1 1 auto; width: auto; min-width: 0;
  border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: none;
  padding-right: 34px;
  appearance: textfield; -moz-appearance: textfield;
}
.expire-control .expire-value::-webkit-outer-spin-button,
.expire-control .expire-value::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.expire-control .expire-unit {
  flex: 0 0 6.25rem; width: 6.25rem;
  border-top-left-radius: 0; border-bottom-left-radius: 0;
  border-left: 1px solid var(--color-rule);
}
.stepper {
  position: absolute; right: calc(6.25rem + 1px); top: 1px; bottom: 1px;
  display: flex; flex-direction: column; width: 28px;
  border-left: 1px solid var(--color-rule);
}
.stepper button {
  flex: 1; border: none; background: none; cursor: pointer;
  color: var(--color-muted); display: flex; align-items: center; justify-content: center;
  transition: background var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out);
}
.stepper button:hover { background: var(--color-paper-3); color: var(--color-ink); }
.expire-control[data-style="forever"] .expire-value,
.expire-control[data-style="forever"] .stepper { opacity: 0.4; pointer-events: none; }
.expire-control[data-style="count"] .expire-unit { color: var(--color-ink); }

/* ---- 进度明细 ---- */
.progress-meta {
  display: flex; justify-content: space-between; gap: 10px;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--color-muted); font-variant-numeric: tabular-nums;
  margin-top: 6px;
}

/* ---- 多文件结果列表 ---- */
.result-list { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; }
.result-list:empty { display: none; }
.result-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  background: var(--color-paper-2);
  font-size: 13px;
}
.result-item .rname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-item .rcode {
  font-family: var(--font-mono); font-weight: 700; letter-spacing: 2px;
  font-variant-numeric: tabular-nums;
}
.result-item a { color: var(--color-ink); text-decoration: underline; text-underline-offset: 2px; }
.result-item a:hover { color: var(--color-ink-2); }
/* 多文件批次里单个文件失败：不中断其余，逐条列出原因 */
.result-item.result-failed { border-color: var(--color-danger); }
.result-item .rfail { color: var(--color-danger); font-size: 12px; }

/* ---- 游客上传关闭空态 ---- */
.empty-state {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  text-align: center;
  padding: 36px 20px;
  border: 1px dashed var(--color-rule-strong);
  border-radius: 1.25rem;
  background: var(--color-paper-2);
}
.empty-icon {
  width: 48px; height: 48px; border-radius: 50%;
  background: var(--color-accent); color: var(--color-accent-contrast);
  display: inline-flex; align-items: center; justify-content: center;
  margin-bottom: 6px;
}
.empty-title { font-size: 15px; font-weight: 600; color: var(--color-ink); }
.empty-desc { font-size: 13px; color: var(--color-ink-2); max-width: 30rem; }
.empty-state .btn { width: auto; margin-top: 10px; padding: 9px 20px; }

.hint { font-size: 12px; color: var(--color-muted); font-weight: 400; }

/* ---- 后台统计卡 ---- */
.stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 20px; }
.stat-card {
  border: 1px solid var(--color-rule);
  border-radius: 1.25rem;
  background: var(--color-paper-2);
  padding: 14px 16px;
  min-width: 0;
}
.stat-label { font-size: 12px; color: var(--color-ink-2); }
.stat-value { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; font-variant-numeric: tabular-nums; margin-top: 2px; }
.stat-sub { font-size: 11px; color: var(--color-muted); font-family: var(--font-mono); margin-top: 2px; }

/* ---- 设置行 ---- */
.setting-row {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--color-rule);
}
.setting-title { font-size: 14px; font-weight: 600; color: var(--color-ink); }
/* 设置说明较长：按句子分行才读得下去（模板里的换行会被浏览器折成一坨） */
.setting-desc { font-size: 12px; color: var(--color-ink-2); margin-top: 2px; line-height: 1.7; }
.setting-desc > div + div { margin-top: 6px; }
.setting-warn { color: var(--color-danger); font-weight: 600; }
.setting-control { width: auto; min-width: 12rem; flex-shrink: 0; }
form[action="/admin/settings"] > .btn { margin-top: 20px; }

/* ---- 类型标签 / 可点文件名 ---- */
.tag {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--color-rule); background: var(--color-paper-3);
  color: var(--color-ink-2); flex-shrink: 0;
}
a.fname { color: inherit; text-decoration: none; }
a.fname:hover { text-decoration: underline; text-underline-offset: 2px; }

/* ---- 多卡片页面（首页：标题 / 取件 / 发件 三张） ---- */
.card + .card { margin-top: 16px; }

/* 宽度随内容的按钮（管理、取件） */
.btn-auto { width: auto; padding: 10px 20px; white-space: nowrap; }

/* ---- 取件：四格分离输入 ---- */
.pickup-form { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.code-boxes { display: flex; gap: 10px; flex: 1; min-width: 0; }
/* 发件表单里的自定义取件码：跟在 label 下方，不撑满整行 */
.input-group .code-boxes { flex: 0 1 auto; margin-top: 4px; }
.code-box {
  width: 52px; height: 60px; flex: 0 0 auto;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 24px; font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--color-ink);
  background: var(--color-paper-2);
  /* 1px + rule(#e4e4e7) 压在 #f5f5f7 页面上几乎不可见。
     注意 Chrome 会把非整数边框向下取整（1.5px 实测仍渲染为 1px），加粗只能取 2px。 */
  border: 2px solid var(--color-rule-strong);
  border-radius: var(--radius-control);
  outline: none;
  padding: 0;
  transition: border-color var(--dur-short) var(--ease-out), box-shadow var(--dur-short) var(--ease-out);
}
.code-box:hover { border-color: var(--color-ink-2); }
.code-box:focus { border-color: var(--color-ink); box-shadow: 0 0 0 3px var(--focus-ring); }
.code-box.filled { border-color: var(--color-ink-2); }
/* 四位填完、跳转前的一次性反馈：只加深描边与外环，不改填充色 */
.code-boxes.is-complete .code-box { border-color: var(--color-ink); box-shadow: 0 0 0 3px var(--focus-ring); }

/* ---- 悬浮提示（圆圈问号，纯 CSS） ---- */
.tip {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 15px; height: 15px;
  margin-left: 3px;
  border: 1px solid var(--color-rule-strong);
  border-radius: 50%;
  font-size: 10px; font-weight: 600; line-height: 1;
  color: var(--color-ink-2);
  cursor: help;
  vertical-align: middle;
  transition: color var(--dur-short) var(--ease-out), background var(--dur-short) var(--ease-out),
              border-color var(--dur-short) var(--ease-out);
}
.tip:hover, .tip:focus, .tip:focus-visible {
  color: var(--color-ink);
  border-color: var(--color-ink);
  background: var(--color-paper-3);
  outline: none;
}
.tip-bubble {
  position: absolute; bottom: calc(100% + 8px); left: 50%;
  transform: translateX(-50%) translateY(3px);
  background: var(--color-ink);
  color: var(--color-paper);
  font-size: 12px; font-weight: 400; line-height: 1.4;
  letter-spacing: 0;
  padding: 6px 10px;
  border-radius: 8px;
  /* 包含块只有 15px 宽，不给 max-content 的话收缩宽度会塌成一个汉字一行 */
  width: max-content;
  max-width: min(210px, 72vw);
  white-space: normal;
  text-align: center;
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity var(--dur-short) var(--ease-out), transform var(--dur-short) var(--ease-out),
              visibility var(--dur-short);
  z-index: 20;
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
}
.tip-bubble::after {
  content: "";
  position: absolute; top: 100%; left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: var(--color-ink);
}
.tip:hover .tip-bubble, .tip:focus .tip-bubble, .tip:focus-visible .tip-bubble {
  opacity: 1; visibility: visible;
  transform: translateX(-50%) translateY(0);
}

/* ---- 取件页：空码提示与竖排表单 ---- */
.code-empty-tip {
  text-align: center;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--color-ink);
  margin: 2px 0 20px;
}
.pickup-form--stack { flex-direction: column; align-items: center; gap: 18px; }
.pickup-form--stack .code-boxes { flex: 0 1 auto; width: 100%; justify-content: center; }

/* ---- 额外发件设置（默认折叠） ---- */
.extra {
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-control);
  background: var(--color-paper-2);
  margin-bottom: 14px;
}
.extra > summary {
  list-style: none;
  cursor: pointer;
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 11px 14px;
  font-size: 13px; font-weight: 500;
  color: var(--color-ink-2);
  border-radius: var(--radius-control);
  transition: color var(--dur-short) var(--ease-out), background var(--dur-short) var(--ease-out);
}
.extra > summary::-webkit-details-marker { display: none; }
.extra > summary:hover { color: var(--color-ink); background: var(--color-paper-3); }
.extra > summary:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; }
.extra > summary::after {
  content: "";
  width: 7px; height: 7px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
  transition: transform var(--dur-short) var(--ease-out);
  flex-shrink: 0;
}
.extra[open] > summary { border-bottom: 1px solid var(--color-rule); border-radius: var(--radius-control) var(--radius-control) 0 0; color: var(--color-ink); }
.extra[open] > summary::after { transform: rotate(-135deg); }
.extra-body { padding: 14px 14px 0; }

/* ---- responsive ---- */
@media (min-width: 640px) {
  :root { --radius-card: 2.5rem; }
}

@media (max-width: 420px) {
  .container { padding: 24px 12px 48px; }
  .card { padding: 24px 18px; }
  .field-row { flex-direction: column; gap: 0; }
  .stepper { display: none; }
  .expire-control .expire-unit { flex-basis: 5.5rem; width: 5.5rem; }
  .expire-control .expire-value { padding-right: 12px; }
  .dz { padding: 22px 14px; }
  .pickup-form { flex-wrap: wrap; }
  .code-boxes { gap: 8px; width: 100%; justify-content: space-between; }
  .code-box { width: 100%; max-width: 56px; height: 54px; font-size: 21px; }
  .pickup-form .btn-auto { width: 100%; justify-content: center; }
  .tip-bubble { max-width: 78vw; }
  .setting-row { flex-direction: column; align-items: stretch; gap: 8px; }
  .setting-control { min-width: 0; width: 100%; }
}

@media (max-width: 719px) {
  .share-grid { flex-direction: column; gap: 20px; }
  .command-box { flex-grow: 0; }
  .code-value { font-size: 34px; letter-spacing: 5px; }
  .share-right { padding: 20px 12px; }
}

@media (prefers-reduced-motion: reduce) {
  body { transition: none; }
  .card { animation: none; }
  .btn, .header-actions a, .input, .file-list-item, .btn-danger, .btn-copy-cmd, .code-card,
  .code-box, .extra > summary, .extra > summary::after, .tip, .tip-bubble {
    transition: none;
  }
}
`;
