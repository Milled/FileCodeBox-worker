/**
 * 通用 HTML 布局包装器
 * wide=true 时容器放宽到 720px（取件/分享/管理面板双栏布局用）
 */
export function layout(title: string, content: string, showFooter = true, wide = false): string {
  const footer = showFooter
    ? `<div class="footer">
        <a href="/">FileCodeBox</a> · 安全临时文件分享
        <a href="https://github.com/jeio258/FileCodeBox-worker" target="_blank" rel="noopener" class="github-link">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          GitHub
        </a>
      </div>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <link rel="icon" href="https://q1.qlogo.cn/g?b=qq&nk=2847495839&s=640">
  <link rel="preconnect" href="/static">
  <link rel="stylesheet" href="/static/style.css?v=8">
</head>
<body>
  <div class="container${wide ? ' container-wide' : ''}">
    <div class="card">${content}</div>
    ${footer}
  </div>
  <script>function copyText(t,e){var n=this;navigator.clipboard.writeText(t).then(function(){n.textContent='已复制';setTimeout(function(){n.textContent=e},1500)})}function codeCopy(el,t){navigator.clipboard.writeText(t).then(function(){var h=el.querySelector('.click-hint');h.textContent='已复制';setTimeout(function(){h.textContent='点击复制'},1500)})}</script>
</body>
</html>`;
}
