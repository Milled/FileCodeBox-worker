/* Hallmark · macrostructure: Form-first · genre: editorial · theme: warm-paper · design-system: design.md · designed-as-app */
/** 暖纸墨色 — 基于临渊羡鱼统一设计系统 */
export const STYLE = `
/* Hallmark · genre: editorial · theme: warm-paper */
:root {
  /* ---- typography ---- */
  --font-display: "LXGW WenKai", "Noto Serif SC", "PingFang SC", serif;
  --font-body:    "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, system-ui, sans-serif;
  --font-mono:    "SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace;

  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-md: 1.125rem;
  --text-lg: 1.375rem;
  --text-xl: 1.75rem;
  --text-2xl: 2.25rem;
  --text-3xl: 2.75rem;

  /* ---- spacing (4pt scale) ---- */
  --space-3xs: 0.125rem;
  --space-2xs: 0.25rem;
  --space-xs: 0.5rem;
  --space-sm: 0.75rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2.5rem;
  --space-2xl: 4rem;
  --space-3xl: 6rem;

  /* ---- colors: light ---- */
  --color-paper:       oklch(97% 0.012 80);
  --color-paper-2:     oklch(93% 0.014 78);
  --color-paper-3:     oklch(88% 0.010 75);
  --color-rule:        oklch(82% 0.012 72);
  --color-rule-strong: oklch(70% 0.010 68);
  --color-muted:       oklch(55% 0.008 65);
  --color-ink:         oklch(22% 0.015 60);
  --color-ink-2:       oklch(35% 0.010 58);
  --color-accent:      oklch(58% 0.16 62);
  --color-accent-hover:oklch(50% 0.17 60);
  --color-accent-soft: oklch(58% 0.16 62 / 0.12);
  --color-focus:       oklch(52% 0.18 55);
  --color-success:     oklch(55% 0.16 160);
  --color-danger:      oklch(50% 0.18 25);

  /* ---- shape ---- */
  --radius: 8px;

  /* ---- motion ---- */
  --ease-out:  cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in:   cubic-bezier(0.7, 0, 0.84, 0);
  --dur-micro: 120ms;
  --dur-short: 220ms;
  --dur-long:  420ms;
}

/* ---- dark mode ---- */
@media (prefers-color-scheme: dark) {
  :root {
    --color-paper:       oklch(15% 0.010 70);
    --color-paper-2:     oklch(19% 0.012 68);
    --color-paper-3:     oklch(25% 0.010 65);
    --color-rule:        oklch(28% 0.008 62);
    --color-rule-strong: oklch(40% 0.008 60);
    --color-muted:       oklch(55% 0.006 55);
    --color-ink:         oklch(94% 0.006 80);
    --color-ink-2:       oklch(80% 0.005 72);
    --color-accent:      oklch(68% 0.14 65);
    --color-accent-hover:oklch(60% 0.15 63);
    --color-accent-soft: oklch(68% 0.14 65 / 0.10);
    --color-focus:       oklch(65% 0.16 58);
    --color-success:     oklch(60% 0.14 160);
    --color-danger:      oklch(58% 0.16 25);
  }
}

*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

body {
  font-family: var(--font-body);
  background-color: var(--color-paper);
  background-image: url("https://t.alcy.cc/ycy");
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  background-attachment: fixed;
  color: var(--color-ink);
  min-height: 100vh;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.container {
  max-width: 460px;
  margin: 0 auto;
  padding: 40px 16px 64px;
}
.container.container-wide {
  max-width: 720px;
}

.card {
  background: color-mix(in oklab, var(--color-paper) 55%, transparent);
  backdrop-filter: blur(18px) saturate(1.15);
  -webkit-backdrop-filter: blur(18px) saturate(1.15);
  border-radius: 20px;
  padding: 28px 24px;
  border: 1px solid color-mix(in oklab, var(--color-rule) 70%, transparent);
  box-shadow: 0 20px 50px oklch(0% 0 0 / 0.12);
  animation: cardIn var(--dur-long) var(--ease-out) both;
}
@media (prefers-color-scheme: dark) {
  .card {
    background: color-mix(in oklab, var(--color-paper-2) 45%, transparent);
    box-shadow: 0 20px 50px oklch(0% 0 0 / 0.35);
  }
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
  font-weight: 500;
  color: var(--color-accent);
  letter-spacing: -0.3px;
}
.header p {
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--color-ink-2);
  margin-top: 4px;
}

/* ---- header 操作按钮（卡片右上角，与标题同一水平） ---- */
.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.header-actions a {
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--color-ink-2);
  text-decoration: none;
  padding: 6px 12px;
  border-radius: var(--radius);
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
  padding: 10px 18px;
  border: none;
  border-radius: 100px;
  font-size: 14px;
  font-family: var(--font-body);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--dur-short) var(--ease-out), opacity var(--dur-short) var(--ease-out), transform var(--dur-short) var(--ease-out);
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
  color: #fff;
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
.btn-secondary:hover { background: var(--color-paper-3); border-color: var(--color-accent); }

.btn-warm {
  background: var(--color-accent);
  color: #fff;
  width: 100%;
}
.btn-warm:hover { background: var(--color-accent-hover); }

.btn-sm {
  padding: 6px 14px;
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
.btn-danger:hover { background: oklch(50% 0.18 25 / 0.1); }

/* ---- inputs ---- */
.input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius);
  font-size: 15px;
  font-family: var(--font-body);
  outline: none;
  transition: border-color var(--dur-short) var(--ease-out);
  background: var(--color-paper);
  color: var(--color-ink);
}
.input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.input-group {
  margin-bottom: 14px;
}
.input-group label {
  display: block;
  font-size: 13px;
  font-family: var(--font-body);
  font-weight: 500;
  color: var(--color-ink-2);
  margin-bottom: 5px;
}

textarea.input {
  resize: vertical;
  min-height: 120px;
  line-height: 1.5;
}

/* ---- dividers ---- */
.section-divider {
  height: 1px;
  background: var(--color-rule);
  margin: 24px 0;
}

/* ---- pickup section ---- */
.section-pickup {
  background: linear-gradient(135deg, var(--color-accent-soft), oklch(58% 0.16 62 / 0.04));
  border: 1px solid oklch(58% 0.16 62 / 0.2);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 20px;
}
.section-pickup .section-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-accent-hover);
  margin-bottom: 10px;
  letter-spacing: 0.3px;
}

/* ---- tabs ---- */
.tabs {
  display: flex;
  gap: 0;
  margin-bottom: 20px;
  border-bottom: 2px solid var(--color-rule);
}
.tab {
  flex: 1;
  text-align: center;
  padding: 8px 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-ink-2);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  transition: color var(--dur-short) var(--ease-out), border-color var(--dur-short) var(--ease-out);
  background: none;
  border-top: none;
  border-left: none;
  border-right: none;
  font-family: var(--font-body);
}
.tab:hover { color: var(--color-ink); }
.tab.active { color: var(--color-accent); border-bottom-color: var(--color-accent); }
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

/* ---- text content ---- */
.text-content {
  background: var(--color-paper);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius);
  padding: 16px;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
  font-family: var(--font-body);
}

/* ---- code display ---- */
.code-box {
  text-align: center;
  padding: 16px 0;
}
.code-display {
  font-family: var(--font-mono);
  font-size: 44px;
  font-weight: 500;
  letter-spacing: 10px;
  color: var(--color-ink);
  background: var(--color-paper);
  display: inline-block;
  padding: 8px 24px;
  border-radius: var(--radius);
  margin: 12px 0;
  border: 1px solid var(--color-rule);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background var(--dur-short) var(--ease-out), border-color var(--dur-short) var(--ease-out);
  position: relative;
}
.code-display:hover {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
}
.code-display::after {
  content: '点击复制';
  position: absolute;
  top: -22px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--color-ink-2);
  opacity: 0;
  transition: opacity var(--dur-short) var(--ease-out);
  pointer-events: none;
  white-space: nowrap;
}
.code-display:hover::after {
  opacity: 1;
}
.copy-text-btn {
  cursor: pointer;
  color: var(--color-accent);
  font-size: 13px;
  font-family: var(--font-body);
  font-weight: 500;
  background: none;
  border: none;
  padding: 4px 8px;
  border-radius: var(--radius);
  transition: background var(--dur-short) var(--ease-out);
}
.copy-text-btn:hover { background: var(--color-paper-3); }

/* ---- info tags ---- */
.info-row {
  display: flex;
  justify-content: center;
  gap: 16px;
  font-size: 13px;
  color: var(--color-ink-2);
  margin: 12px 0;
  flex-wrap: wrap;
}
.info-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  background: var(--color-paper);
  border-radius: 20px;
  font-size: 12px;
  font-family: var(--font-mono);
  border: 1px solid var(--color-rule);
  font-variant-numeric: tabular-nums;
}

/* ---- file icon ---- */
.file-icon {
  width: 56px;
  height: 56px;
  background: var(--color-accent);
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}

/* ---- file list ---- */
.file-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--color-paper);
  border-radius: var(--radius);
  margin-bottom: 6px;
  transition: background var(--dur-short) var(--ease-out);
  gap: 8px;
  border: 1px solid transparent;
}
.file-list-item:hover {
  background: var(--color-paper-3);
  border-color: var(--color-rule);
}
.file-list-item .fname {
  font-size: 13px;
  font-family: var(--font-body);
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

/* ---- badges ---- */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-family: var(--font-body);
  font-weight: 500;
}
.badge-danger { background: oklch(50% 0.18 25 / 0.1); color: var(--color-danger); }
.badge-success { background: oklch(55% 0.16 160 / 0.1); color: var(--color-success); }

/* ---- undo toast (for optimistic delete) ---- */
.undo-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--color-ink);
  color: var(--color-paper);
  padding: 10px 20px;
  border-radius: 100px;
  font-size: 13px;
  font-family: var(--font-body);
  z-index: 999;
  box-shadow: 0 4px 16px oklch(0% 0 0 / 0.2);
  display: flex;
  align-items: center;
  gap: 12px;
  animation: fadeInUp var(--dur-short) var(--ease-out);
}

.undo-toast button {
  background: none;
  border: none;
  color: var(--color-accent);
  font-weight: 600;
  cursor: pointer;
  font-family: var(--font-body);
  font-size: 13px;
  padding: 2px 6px;
}
.undo-toast button:hover { text-decoration: underline; }

@keyframes fadeInUp {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}

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
.footer a.github-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  transition: color var(--dur-short) var(--ease-out);
}
.footer a.github-link:hover {
  color: var(--color-ink);
}

/* ---- responsive ---- */
@media (max-width: 420px) {
  .container { padding: 24px 12px 48px; }
  .card { padding: 20px 16px; }
  .code-display { font-size: 36px; letter-spacing: 8px; }
  .section-pickup { padding: 16px; }
}

@media (prefers-reduced-motion: reduce) {
  .card { animation: none; }
  .btn, .header-actions a, .copy-text-btn, .input, .file-list-item, .btn-danger {
    transition: none;
  }
  .undo-toast { animation: none; }
}

/* ---- share 双栏布局（毛玻璃宽屏版） ---- */
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
  background: color-mix(in oklab, var(--color-paper) 45%, transparent);
  border: 1px solid color-mix(in oklab, var(--color-rule) 70%, transparent);
  border-radius: 16px;
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
  font-weight: 500;
  color: var(--color-ink);
  word-break: break-all;
  margin-bottom: 14px;
}

/* 内容框：文本在上、操作按钮在下 */
.command-box {
  background: color-mix(in oklab, var(--color-paper) 60%, transparent);
  border: 1px solid var(--color-rule);
  border-radius: 12px;
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
  color: var(--color-accent);
  border: 1px solid color-mix(in oklab, var(--color-accent) 30%, transparent);
  border-radius: 8px;
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
.btn-copy-cmd:hover { background: color-mix(in oklab, var(--color-accent) 20%, transparent); }
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
  border-radius: 12px;
}
.code-card:hover { background: var(--color-accent-soft); }
.code-card:active { transform: scale(0.98); }
.code-label { font-size: 12px; color: var(--color-ink-2); margin-bottom: 8px; }
.code-value {
  font-size: 38px;
  font-weight: 800;
  color: var(--color-accent);
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
  padding: 8px 16px;
  font-size: 13px;
}

@media (max-width: 719px) {
  .share-grid { flex-direction: column; gap: 20px; }
  .command-box { flex-grow: 0; }
  .code-value { font-size: 34px; letter-spacing: 5px; }
  .share-right { padding: 20px 12px; }
}
`;
