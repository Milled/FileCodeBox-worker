import type { FileRecord } from '../types';
import { formatFileSize, escapeHtml } from '../utils';
import { layout } from './layout';

/** layout 不再包卡片，页面自行决定卡片数量（首页三张，其余一张） */
const card = (inner: string) => `<div class="card">${inner}</div>`;

// ---- 首页 ----

export interface HomeOptions {
  /** open_upload 设置；为 false 时首页只显示登录引导 */
  uploadAllowed?: boolean;
  /** 当前生效的默认过期天数（fc_settings 优先于 wrangler vars） */
  defaultExpireDays?: number;
}

/** 有效期选择器：后端 parseExpire 已支持 day/hour/minute/count/forever，UI 全部开放 */
function expireControl(o: {
  valueId: string;
  styleId: string;
  /** 文本表单走原生 POST，需要 name；文件表单由 JS 读值，留空 */
  names?: { value: string; style: string };
  days: number;
}): string {
  const valueName = o.names ? ` name="${o.names.value}"` : '';
  const styleName = o.names ? ` name="${o.names.style}"` : '';
  return `
        <div class="expire-control" data-style="day">
          <input type="number" id="${o.valueId}"${valueName} class="input expire-value" min="1" value="${o.days}" aria-label="有效期数值">
          <select id="${o.styleId}"${styleName} class="input expire-unit" aria-label="有效期单位">
            <option value="day">天</option>
            <option value="hour">小时</option>
            <option value="minute">分钟</option>
            <option value="count">次后失效</option>
            <option value="forever">永久</option>
          </select>
          <div class="stepper">
            <button type="button" data-step="1" tabindex="-1" aria-label="增加">▲</button>
            <button type="button" data-step="-1" tabindex="-1" aria-label="减少">▼</button>
          </div>
        </div>`;
}

/**
 * 四格分离输入。真实表单字段是末尾那个隐藏 input（name 可选），
 * 四格只负责输入体验，值由 codeGroupsScript() 同步进去。
 */
function codeBoxes(o: {
  groupId: string;
  hiddenId: string;
  /** 原生提交的表单需要 name（文本分享）；JS 驱动的文件表单留空 */
  name?: string;
  autofocus?: boolean;
  /** 填满四位后自动提交所在表单（只给取件组用，发件表单不能自动提交） */
  autosubmit?: boolean;
  ariaPrefix?: string;
}): string {
  const aria = o.ariaPrefix || '取件码';
  const nameAttr = o.name ? ` name="${o.name}"` : '';
  const boxes = [1, 2, 3, 4]
    .map(
      (n) =>
        `        <input class="code-box" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="off"${
          o.autofocus && n === 1 ? ' autofocus' : ''
        } aria-label="${aria}第 ${n} 位">`,
    )
    .join('\n');
  return `
      <div class="code-boxes" id="${o.groupId}" data-code-target="${o.hiddenId}"${o.autosubmit ? ' data-autosubmit' : ''}>
${boxes}
      </div>
      <input type="hidden"${nameAttr} id="${o.hiddenId}">`;
}

/** 悬浮提示：纯 CSS + tabindex，无需 JS，也不受 CSP 影响 */
function tip(text: string): string {
  return `<span class="tip" tabindex="0" role="note" aria-label="${text}">?<span class="tip-bubble" role="tooltip">${text}</span></span>`;
}

export function homePage(opts: HomeOptions = {}): string {
  const uploadAllowed = opts.uploadAllowed !== false;
  const days = typeof opts.defaultExpireDays === 'number' && opts.defaultExpireDays > 0 ? opts.defaultExpireDays : 7;

  // ① 标题 + 管理入口 + 取件
  const pickupCard = `
    <div class="header">
      <div>
        <h1>FileCodeBox</h1>
        <p>输入四位取件码取件</p>
      </div>
      <div class="header-actions">
        <a href="/admin">管理</a>
      </div>
    </div>
    <form action="/r" method="get" class="pickup-form" onsubmit="return submitPickup(event)">
${codeBoxes({ groupId: 'pickupBoxes', hiddenId: 'pickupCode', name: 'code', autofocus: true, autosubmit: true })}
      <button type="submit" class="btn btn-warm btn-auto">取件</button>
    </form>`;

  // ② 发件
  const sendCard = `
    ${uploadAllowed ? uploadUi(days) : guestBlockedUi()}
    ${uploadAllowed ? homeScript() : ''}
    ${codeGroupsScript()}`;

  return layout('FileCodeBox', card(pickupCard) + card(sendCard));
}

/**
 * 四格取件码通用逻辑：自动前进、退格回退、方向键、粘贴分发，
 * 并把合并值同步进各自的隐藏字段（页面里可能有多组：取件 / 文件 / 文本）。
 */
function codeGroupsScript(): string {
  return `
    <script>
    function codeGroupBoxes(group) {
      return Array.prototype.slice.call(group.querySelectorAll('.code-box'));
    }

    function syncCodeGroup(group) {
      var boxes = codeGroupBoxes(group);
      var hidden = document.getElementById(group.getAttribute('data-code-target'));
      if (!hidden) return;
      hidden.value = boxes.map(function (b) { return b.value; }).join('');
      boxes.forEach(function (b) { b.classList.toggle('filled', !!b.value); });
      autoSubmitPickup(group, hidden.value);
    }

    // 四位填满即取件；只认带 data-autosubmit 的那组，发件表单的自定义码不会误触发
    function autoSubmitPickup(group, value) {
      if (!group.hasAttribute('data-autosubmit') || !/^\\d{4}$/.test(value)) return;
      var form = group.closest('form');
      if (!form || form.dataset.submitting === '1') return;
      form.dataset.submitting = '1';
      // 先给一次「已填满」的高亮反馈，再跳转，避免看起来像点了没反应
      group.classList.add('is-complete');
      setTimeout(function () {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      }, 220);
    }

    function initCodeGroups() {
      document.querySelectorAll('.code-boxes[data-code-target]').forEach(function (group) {
        var boxes = codeGroupBoxes(group);
        boxes.forEach(function (b, i) {
          b.addEventListener('input', function () {
            b.value = (b.value || '').replace(/\\D/g, '').slice(-1);
            if (b.value && i < boxes.length - 1) boxes[i + 1].focus();
            syncCodeGroup(group);
          });
          b.addEventListener('keydown', function (e) {
            // maxlength=1 会让浏览器直接拒绝在已填格中再输入字符（必须先删），
            // 这里拦下数字键做「覆盖输入」
            if (/^[0-9]$/.test(e.key) && b.value) {
              e.preventDefault();
              b.value = e.key;
              if (i < boxes.length - 1) boxes[i + 1].focus();
              syncCodeGroup(group);
              return;
            }
            if (e.key === 'Backspace' && !b.value && i > 0) {
              e.preventDefault();
              boxes[i - 1].value = '';
              boxes[i - 1].focus();
              syncCodeGroup(group);
            } else if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
            else if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
          });
          b.addEventListener('paste', function (e) {
            var text = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\\D/g, '').slice(0, 4);
            if (!text) return;
            e.preventDefault();
            text.split('').forEach(function (ch, j) { if (boxes[j]) boxes[j].value = ch; });
            boxes[Math.min(text.length, boxes.length - 1)].focus();
            syncCodeGroup(group);
          });
        });
      });
    }

    function submitPickup(e) {
      var hidden = document.getElementById('pickupCode');
      if (!hidden || !/^\\d{4}$/.test(hidden.value)) {
        e.preventDefault();
        var boxes = document.querySelectorAll('#pickupBoxes .code-box');
        for (var i = 0; i < boxes.length; i++) {
          if (!boxes[i].value) { boxes[i].focus(); break; }
        }
        return false;
      }
      return true;
    }

    document.addEventListener('DOMContentLoaded', initCodeGroups);
    </script>`;
}

/** 上传面板（文件 + 文本），仅在允许游客上传时渲染 */
function uploadUi(days: number): string {
  return `
    <div class="tabs">
      <button class="tab active" data-tab="file" onclick="switchTab('file')">文件</button>
      <button class="tab" data-tab="text" onclick="switchTab('text')">文本</button>
    </div>

    <!-- 文件上传面板 -->
    <div id="tab-file" class="tab-panel active">
      <form id="uploadForm" onsubmit="return handleUpload(event)">
        <div class="input-group">
          <div class="dz" id="dropZone" tabindex="0" role="button" aria-label="点击或拖拽文件上传">
            <span class="dz-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V5"/><path d="m7 10 5-5 5 5"/><path d="M5 19h14"/></svg></span>
            <span class="dz-title">点击选择，或拖拽文件到此处</span>
            <span class="dz-hint">支持直接粘贴 · 可多选，每个文件各自生成取件码</span>
            <input type="file" name="file" id="fileInput" class="dz-input" multiple>
          </div>
          <div class="file-chips" id="fileList"></div>
        </div>
        <details class="extra">
          <summary>额外发件设置</summary>
          <div class="extra-body">
            <div class="field-row">
              <div class="input-group">
                <label>有效期 ${tip('有效期后文件将被销毁')}</label>
${expireControl({ valueId: 'fileExpireValue', styleId: 'fileExpireStyle', days })}
              </div>
              <div class="input-group">
                <label>最大下载次数 ${tip('设置为 -1 则不限制次数')}</label>
                <input type="number" id="fileMaxDownloads" name="max_downloads" value="-1" min="-1" class="input" placeholder="不限">
              </div>
            </div>
            <div class="input-group">
              <label>自定义取件码 <span class="hint">（可选，留空自动生成）</span></label>
${codeBoxes({ groupId: 'fileCodeBoxes', hiddenId: 'fileCode' })}
            </div>
          </div>
        </details>
        <div class="upload-progress" id="uploadProgress"><div class="upload-progress-bar" id="uploadProgressBar"></div></div>
        <div class="upload-status" id="uploadStatus"></div>
        <div class="progress-meta" id="uploadMeta" hidden></div>
        <button type="submit" id="submitBtn" class="btn btn-primary">发件并获取取件码</button>
        <div class="result-list" id="uploadResults"></div>
      </form>
    </div>

    <!-- 文本分享面板 -->
    <div id="tab-text" class="tab-panel">
      <form action="/api/upload/text" method="post" onsubmit="return prepareTextSubmit(event)">
        <div class="input-group">
          <textarea name="text" id="textInput" class="input" placeholder="粘贴或输入要分享的文本内容…" required oninput="updateTextBytes(this)"></textarea>
          <div class="progress-meta"><span id="textBytes">0 B</span><span>上限 512 KB</span></div>
        </div>
        <details class="extra">
          <summary>额外发件设置</summary>
          <div class="extra-body">
            <div class="field-row">
              <div class="input-group">
                <label>有效期 ${tip('有效期后文件将被销毁')}</label>
${expireControl({ valueId: 'textExpireValue', styleId: 'textExpireStyle', names: { value: 'expire_value', style: 'expire_style' }, days })}
              </div>
              <div class="input-group">
                <label>最大查看次数 ${tip('设置为 -1 则不限制次数')}</label>
                <input type="number" id="textMaxDownloads" name="max_downloads" value="-1" min="-1" class="input" placeholder="不限">
              </div>
            </div>
            <div class="input-group">
              <label>自定义取件码 <span class="hint">（可选，留空自动生成）</span></label>
${codeBoxes({ groupId: 'textCodeBoxes', hiddenId: 'textCode', name: 'code' })}
            </div>
          </div>
        </details>
        <button type="submit" id="textSubmitBtn" class="btn btn-primary">发件并获取取件码</button>
      </form>
    </div>`;
}

/** 游客上传被关闭时的引导态（对齐上游 guestUploadBlocked 卡片） */
function guestBlockedUi(): string {
  return `
    <div class="empty-state">
      <span class="empty-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span>
      <div class="empty-title">游客上传已关闭</div>
      <div class="empty-desc">管理员已在后台设置中关闭匿名上传。取件不受影响，登录后仍可上传。</div>
      <a href="/admin" class="btn btn-primary">前往登录</a>
    </div>`;
}

/** 首页交互脚本：拖拽/粘贴/多文件上传、字节与速度进度、有效期选择器 */
function homeScript(): string {
  return `
    <script>
    var MAX_TEXT_BYTES = 524288;
    var pendingFiles = [];

    function switchTab(name) {
      document.querySelectorAll('.tab').forEach(function (t) {
        t.classList.toggle('active', t.getAttribute('data-tab') === name);
      });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
      var panel = document.getElementById('tab-' + name);
      if (panel) panel.classList.add('active');
    }

    function fmtBytes(n) {
      if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
      if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
      return Math.round(n) + ' B';
    }

    // ---- 文件选择：点击 / 拖拽 / 粘贴 ----
    function addFiles(list) {
      var seen = {};
      pendingFiles.forEach(function (f) { seen[f.name + ':' + f.size] = true; });
      Array.prototype.forEach.call(list, function (f) {
        var key = f.name + ':' + f.size;
        if (!seen[key]) { pendingFiles.push(f); seen[key] = true; }
      });
      renderChips();
    }

    function renderChips() {
      var box = document.getElementById('fileList');
      if (!box) return;
      box.textContent = '';
      pendingFiles.forEach(function (f, i) {
        var chip = document.createElement('div');
        chip.className = 'file-chip';
        var name = document.createElement('span');
        name.className = 'chip-name';
        name.textContent = f.name;
        var size = document.createElement('span');
        size.className = 'chip-size';
        size.textContent = fmtBytes(f.size);
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'chip-remove';
        rm.setAttribute('aria-label', '移除 ' + f.name);
        rm.textContent = '×';
        rm.onclick = function () { pendingFiles.splice(i, 1); renderChips(); };
        chip.appendChild(name); chip.appendChild(size); chip.appendChild(rm);
        box.appendChild(chip);
      });
    }

    function initDropZone() {
      var dz = document.getElementById('dropZone');
      var input = document.getElementById('fileInput');
      if (!dz || !input) return;
      dz.addEventListener('click', function (e) { if (e.target !== input) input.click(); });
      dz.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
      });
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.setAttribute('data-dragging', 'true'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.removeAttribute('data-dragging'); });
      });
      dz.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      });
      input.addEventListener('change', function () {
        if (input.files.length) addFiles(input.files);
        input.value = '';
      });
      // 关闭浏览器把拖入的图片直接导航走
      ['dragover', 'drop'].forEach(function (ev) {
        window.addEventListener(ev, function (e) { e.preventDefault(); });
      });
      window.addEventListener('paste', function (e) {
        var files = e.clipboardData && e.clipboardData.files;
        if (files && files.length) { e.preventDefault(); addFiles(files); }
      });
    }

    // ---- 有效期选择器 ----
    function bindExpire(valueId, styleId, maxId) {
      var wrap = document.getElementById(valueId);
      var style = document.getElementById(styleId);
      var value = wrap;
      var max = maxId ? document.getElementById(maxId) : null;
      if (!style || !value) return;
      var control = style.closest('.expire-control');

      function sync() {
        var m = style.value;
        if (control) control.setAttribute('data-style', m);
        value.disabled = (m === 'forever');
        value.required = (m !== 'forever');
        // 按次数失效时，最大下载次数由有效期数值决定，避免两个字段互相矛盾
        if (max) {
          if (m === 'count') { max.value = value.value; max.disabled = true; }
          else { max.disabled = false; if (max.value === '') max.value = '-1'; }
        }
      }
      style.addEventListener('change', sync);
      value.addEventListener('input', function () {
        if (max && style.value === 'count') max.value = value.value;
      });
      if (control) {
        control.querySelectorAll('.stepper button').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var step = parseInt(btn.getAttribute('data-step'), 10);
            var n = parseInt(value.value, 10);
            if (!Number.isFinite(n)) n = 1;
            value.value = String(Math.max(1, n + step));
            value.dispatchEvent(new Event('input', { bubbles: true }));
          });
        });
      }
      sync();
    }

    // ---- 缩略图 ----
    // 图片在浏览器里缩放后再传：Worker 免费档每请求只有 5ms CPU，解一张大图必然超限。
    // 长边 480px 对应桌面卡片宽度的 2x，96KB 是自愿上限（服务端另有 128KB 硬上限）。
    var THUMB_EDGE = 480;
    var THUMB_MAX_BYTES = 96 * 1024;

    function dataUrlBytes(url) { return Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4); }

    function dataUrlToBlob(url, type) {
      var bin = atob(url.slice(url.indexOf(',') + 1));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: type });
    }

    // 前缀必须还是请求的那种格式：浏览器不支持 WebP 编码时会静默退回 PNG，
    // 那种情况交给 JPEG 兜底（WebP 体积通常小得多）
    function encodeThumb(canvas, type, quality) {
      var url = '';
      try { url = canvas.toDataURL(type, quality); } catch (err) { return null; }
      if (url.indexOf('data:' + type) !== 0) return null;
      if (dataUrlBytes(url) > THUMB_MAX_BYTES) return null;
      return dataUrlToBlob(url, type);
    }

    function makeThumb(file) {
      // SVG 是脚本载体且 canvas 栅格化不可靠，直接排除
      // 注意：这段是模板字符串里的 JS，写 /^image\// 会被模板吃掉反斜杠变成 /^image//
      if (file.type.slice(0, 6) !== 'image/' || /svg/.test(file.type) || !self.createImageBitmap) {
        return Promise.resolve(null);
      }
      return createImageBitmap(file).then(function (bmp) {
        var fit = Math.min(1, THUMB_EDGE / Math.max(bmp.width, bmp.height));
        var blob = null;
        [1, 0.75, 0.5].some(function (ratio) {
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(bmp.width * fit * ratio));
          canvas.height = Math.max(1, Math.round(bmp.height * fit * ratio));
          canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
          blob = [['image/webp', 0.72], ['image/webp', 0.55], ['image/jpeg', 0.7], ['image/jpeg', 0.5]]
            .map(function (enc) { return encodeThumb(canvas, enc[0], enc[1]); })
            .filter(Boolean)[0] || null;
          return !!blob;
        });
        if (bmp.close) bmp.close();
        return blob;
      }).catch(function () {
        // 解码失败（HEIC、损坏文件）就安静回退成图标
        return null;
      });
    }

    function uploadThumb(code, blob) {
      return fetch('/api/thumb/' + encodeURIComponent(code), { method: 'POST', body: blob })
        .then(function () { return null; })
        .catch(function () { return null; });
    }

    // ---- 上传 ----
    function uploadParams() {
      var style = document.getElementById('fileExpireStyle');
      var value = document.getElementById('fileExpireValue');
      var max = document.getElementById('fileMaxDownloads');
      var code = document.getElementById('fileCode');
      var q = 'expire_style=' + encodeURIComponent(style ? style.value : 'day');
      q += '&expire_value=' + encodeURIComponent(value && value.value ? value.value : '7');
      q += '&max_downloads=' + encodeURIComponent(max && max.value ? max.value : '-1');
      q += '&code=' + encodeURIComponent(code ? code.value.trim() : '');
      return q;
    }

    function uploadOne(file, query, onProgress) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload?' + query);
        xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded, e.total); };
        xhr.onload = function () {
          var data = null;
          try { data = JSON.parse(xhr.responseText); } catch (err) { data = null; }
          if (xhr.status >= 200 && xhr.status < 300 && data && data.code) resolve(data);
          else reject(new Error((data && data.error) || ('上传失败（HTTP ' + xhr.status + '）')));
        };
        xhr.onerror = function () { reject(new Error('网络错误')); };
        xhr.send(file);
      });
    }

    function handleUpload(e) {
      e.preventDefault();
      var btn = document.getElementById('submitBtn');
      var bar = document.getElementById('uploadProgressBar');
      var wrap = document.getElementById('uploadProgress');
      var status = document.getElementById('uploadStatus');
      var meta = document.getElementById('uploadMeta');
      var results = document.getElementById('uploadResults');
      if (!pendingFiles.length) { alert('请先选择文件'); return false; }

      var totalBytes = pendingFiles.reduce(function (s, f) { return s + f.size; }, 0);
      var query = uploadParams();
      var startedAt = Date.now();
      var lastBytes = 0;
      var lastAt = startedAt;
      var speed = 0;

      btn.disabled = true;
      btn.textContent = '上传中…';
      wrap.style.display = 'block';
      status.style.display = 'block';
      meta.hidden = false;
      results.textContent = '';

      function paint(loadedSoFar, label) {
        var pct = totalBytes ? Math.min(100, Math.round((loadedSoFar / totalBytes) * 100)) : 0;
        bar.style.width = pct + '%';
        status.textContent = label;
        meta.textContent = fmtBytes(loadedSoFar) + ' / ' + fmtBytes(totalBytes) + ' · ' + fmtBytes(speed) + '/s';
      }

      function onProgress(loadedSoFar, fileLoaded) {
        var now = Date.now();
        var dt = now - lastAt;
        if (dt > 200) {
          speed = ((fileLoaded - lastBytes) / dt) * 1000;
          lastBytes = fileLoaded;
          lastAt = now;
        }
      }

      var done = 0;
      var jobs = pendingFiles.slice();
      var chain = Promise.resolve();
      var collected = [];
      jobs.forEach(function (file, idx) {
        chain = chain.then(function () {
          return uploadOne(file, query, function (loaded, total) {
            onProgress(0, loaded);
            paint(done + loaded, '上传中 (' + (idx + 1) + '/' + jobs.length + ') ' + file.name);
          }).then(function (data) {
            done += file.size;
            collected.push({ name: file.name, code: data.code, size: file.size });
            paint(done, '已完成 ' + collected.length + '/' + jobs.length);
            // 缩略图必须在跳转前落库，成功页才知道该不该输出 <img>；
            // 失败只回退成文件图标，不能拖垮整条上传链
            return makeThumb(file).then(function (thumb) {
              return thumb ? uploadThumb(data.code, thumb) : null;
            });
          });
        });
      });

      chain.then(function () {
        var elapsed = Math.max(1, Date.now() - startedAt);
        if (collected.length === 1) {
          status.textContent = '上传完成，跳转中…';
          // sent=1 → 上传成功视图（与文本一致），而非收件人的下载页
          window.location.href = '/r/' + collected[0].code + '?sent=1';
          return;
        }
        btn.disabled = false;
        btn.textContent = '发件并获取取件码';
        status.textContent = '全部完成 · ' + collected.length + ' 个文件 · ' + (elapsed / 1000).toFixed(1) + 's';
        // 小文件走不到采样窗口，收尾用平均速率，避免显示 0 B/s
        meta.textContent = fmtBytes(totalBytes) + ' / ' + fmtBytes(totalBytes) + ' · 平均 ' + fmtBytes((totalBytes / elapsed) * 1000) + '/s';
        collected.forEach(function (item) {
          var row = document.createElement('div');
          row.className = 'result-item';
          var name = document.createElement('span');
          name.className = 'rname';
          name.textContent = item.name;
          var code = document.createElement('span');
          code.className = 'rcode';
          code.textContent = item.code;
          var link = document.createElement('a');
          link.href = '/r/' + item.code;
          link.textContent = '打开';
          row.appendChild(name); row.appendChild(code); row.appendChild(link);
          results.appendChild(row);
        });
        pendingFiles = [];
        renderChips();
      }).catch(function (err) {
        alert(err.message || '上传失败');
        btn.disabled = false;
        btn.textContent = '发件并获取取件码';
        status.textContent = '上传中断';
        wrap.style.display = 'none';
        meta.hidden = true;
      });
      return false;
    }

    // ---- 文本分享 ----
    function updateTextBytes(el) {
      var out = document.getElementById('textBytes');
      if (out) out.textContent = fmtBytes(new TextEncoder().encode(el.value).length);
    }

    function prepareTextSubmit(e) {
      var el = document.getElementById('textInput');
      var bytes = el ? new TextEncoder().encode(el.value).length : 0;
      if (bytes > MAX_TEXT_BYTES) {
        e.preventDefault();
        alert('文本过长，最大支持 512KB（当前 ' + fmtBytes(bytes) + '）');
        return false;
      }
      var b = document.getElementById('textSubmitBtn');
      if (b) { b.disabled = true; b.textContent = '保存中…'; }
      return true;
    }

    // 浏览器后退会恢复表单页，需要把按钮还原
    window.addEventListener('pageshow', function () {
      var b = document.getElementById('textSubmitBtn');
      if (b) { b.disabled = false; b.textContent = '发件并获取取件码'; }
    });

    document.addEventListener('DOMContentLoaded', function () {
      initDropZone();
      bindExpire('fileExpireValue', 'fileExpireStyle', 'fileMaxDownloads');
      bindExpire('textExpireValue', 'textExpireStyle', 'textMaxDownloads');
      // 页头「发件」带 ?send=1 回主页：默认焦点在取件框上，这里把视线挪到发件区
      if (/[?&]send=1/.test(location.search)) {
        var dz = document.getElementById('dropZone');
        if (dz) { dz.scrollIntoView({ block: 'center' }); dz.focus(); }
      }
    });
    </script>`;
}

// ---- 取件页 ----

/**
 * 取件页：查无此码 / 码为空时的落地页。
 * 不回填失败的码 —— 四格留空并提示重新输入，语义与提示文案一致。
 */
export function retrievePage(): string {
  const content = `
    <div class="header">
      <div>
        <h1>取件</h1>
        <p>输入取件码下载文件</p>
      </div>
      <div class="header-actions">
        ${pageNav()}
      </div>
    </div>
    <div class="code-empty-tip">此取件码为空，请检查后重新输入</div>
    <form action="/r" method="get" class="pickup-form pickup-form--stack" onsubmit="return submitPickup(event)">
${codeBoxes({ groupId: 'pickupBoxes', hiddenId: 'pickupCode', name: 'code', autofocus: true, autosubmit: true })}
      <button type="submit" class="btn btn-primary">取件</button>
    </form>
    ${codeGroupsScript()}`;
  return layout('取件', card(content));
}

/** 页头三件套。发件带 ?send=1 让首页把焦点放到发件区，收件就是回主页 */
function pageNav(): string {
  return `<a href="/?send=1">发件</a>
        <a href="/">收件</a>
        <a href="/admin">管理</a>`;
}

/** 元信息行：大小 / 下载次数 / 过期时间。成功页与取件页共用，避免两处格式漂移 */
function fileMeta(meta: { size: number; download_count: number; max_downloads: number; expire_at: string }): string {
  const expireDate = new Date(meta.expire_at);
  const expireStr =
    expireDate.getTime() - Date.now() > 365 * 86400000
      ? '永久有效'
      : `过期: ${expireDate.toLocaleDateString('zh-CN')}`;
  const dlInfo =
    meta.max_downloads < 0 ? `已下载 ${meta.download_count} 次` : `已下载 ${meta.download_count}/${meta.max_downloads} 次`;
  return `<div class="meta-row">
            <span>${formatFileSize(meta.size)}</span>
            <span>${dlInfo}</span>
            <span>${expireStr}</span>
          </div>`;
}

// ---- 上传成功页 ----

export function resultPage(opts: {
  code: string;
  title: string;
  baseUrl: string;
  /** 文本分享时把正文原样渲染出来：只显字节数会让用户以为内容没传上去 */
  text?: string;
  /** 图片文件在浏览器端生成了缩略图 */
  hasThumb?: boolean;
  meta: { size: number; download_count: number; max_downloads: number; expire_at: string };
}): string {
  const { code, title, baseUrl, text, hasThumb, meta } = opts;
  const shareUrl = `${baseUrl}/r/${code}`;
  const content = `
    <div class="share-grid">
      <div class="share-left">
        <div class="header">
          <div>
            <h1>发件成功</h1>
          </div>
          <div class="header-actions">
            ${pageNav()}
          </div>
        </div>
        <div class="share-title">${escapeHtml(title)}</div>
        <div class="command-box">
          ${hasThumb ? thumbPreview(code) : ''}
          ${text !== undefined ? `<div class="command-text">${escapeHtml(text)}</div>` : ''}
          <a href="/" class="btn btn-secondary" style="width:auto;align-self:center">继续发件</a>
        </div>
        ${fileMeta(meta)}
      </div>
      ${shareRightPanel(code, shareUrl)}
    </div>`;
  return layout('发件成功', card(content), true, true);
}

// ---- 文件详情页 ----

function fileIconSvg(hidden = false): string {
  return `<div class="file-icon"${hidden ? ' hidden' : ''}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
          </div>`;
}

/**
 * 图片预览。取不到图时退回文件图标而不是留一个破图：
 * 页面渲染和实际请求之间，额度可能刚好被最后一次下载用完。
 */
function thumbPreview(code: string): string {
  return `<img class="file-thumb" src="/api/thumb/${code}" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false">
          ${fileIconSvg(true)}`;
}

/** 分享页右栏：取件码卡 + 二维码（取件页文本/文件视图与上传结果页共用） */
function shareRightPanel(code: string, shareUrl: string): string {
  return `
    <div class="share-right">
      <div class="code-card" onclick="codeCopy(this,'${escapeHtml(code)}')">
        <div class="code-label">取件码</div>
        <div class="code-value">${escapeHtml(code)}</div>
        <div class="click-hint">点击复制</div>
      </div>
      <div class="share-divider"></div>
      <img src="/qrcode/${code}" alt="QR Code" class="qr-img" loading="lazy">
      <div class="qr-title">扫码快速分享</div>
      <button class="btn btn-secondary share-link-btn" onclick="navigator.clipboard.writeText('${escapeHtml(shareUrl)}')">复制分享链接</button>
    </div>`;
}

export function filePage(file: FileRecord, baseUrl: string): string {
  const expireDate = new Date(file.expire_at);
  const expired = expireDate.getTime() < Date.now();
  const shareUrl = `${baseUrl}/r/${file.code}`;
  // 文本分享的标题是正文前 50 字（见 shared.ts 的 title 派生规则）。达到最大查看次数后
  // 正文已拒绝读取，但标题仍会把内容泄露出来，因此一律遮蔽为 ***
  const exhausted = file.max_downloads >= 0 && file.download_count >= file.max_downloads;
  const displayTitle = file.is_text === 1 && exhausted ? '***' : escapeHtml(file.filename);

  // 文本内容 — 双栏：左侧内容框，右侧取件码/二维码
  if (file.is_text === 1 && !expired) {
    const content = `
      <div class="share-grid">
        <div class="share-left">
          <div class="header">
            <div>
              <h1>取件</h1>
            </div>
            <div class="header-actions">
              ${pageNav()}
            </div>
          </div>
          <div class="share-title">${displayTitle}</div>
          <div class="command-box">
            <div class="command-text" id="textContent">加载中…</div>
            <button class="btn-copy-cmd" id="copyAllBtn" hidden onclick="var s=this.querySelector('span');navigator.clipboard.writeText(window.__shareText||'').then(function(){s.textContent='已复制';setTimeout(function(){s.textContent='复制全文'},1500)})">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              <span>复制全文</span>
            </button>
          </div>
          ${fileMeta(file)}
        </div>
        ${shareRightPanel(file.code, shareUrl)}
      </div>
      <script>
        (function(){
          var el = document.getElementById('textContent');
          var ctrl = new AbortController();
          var timer = setTimeout(function(){ ctrl.abort(); }, 8000);
          fetch('/api/text/${file.code}', { signal: ctrl.signal })
            .then(function(r){
              clearTimeout(timer);
              if (!r.ok) {
                var msg = r.status === 403 ? '\u8be5\u5185\u5bb9\u5df2\u8fbe\u6700\u5927\u67e5\u770b\u6b21\u6570\u3002'
                        : r.status === 404 ? '\u5185\u5bb9\u4e0d\u5b58\u5728\u6216\u5df2\u88ab\u6e05\u7406\u3002'
                        : '\u5185\u5bb9\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002';
                el.textContent = msg;
                el.style.color = 'var(--color-danger)';
                return null;
              }
              return r.text();
            })
            .then(function(t){
              if (t !== null) {
                window.__shareText = t;
                el.textContent = t;
                document.getElementById('copyAllBtn').hidden = false;
              }
            })
            .catch(function(err){
              clearTimeout(timer);
              if (err.name !== 'AbortError') {
                el.textContent = '内容加载失败，请稍后重试。';
                el.style.color = 'var(--color-danger)';
              } else {
                el.textContent = '加载超时，请刷新重试。';
                el.style.color = 'var(--color-danger)';
              }
            });
        })();
      </script>`;
    return layout('取件', card(content), true, true);
  }

  // 文件下载页 — 双栏：左侧文件信息/下载，右侧取件码/二维码
  const content = `
    ${expired ? '<div style="text-align:center;color:var(--color-danger);font-size:14px;margin-bottom:16px">此文件已过期</div>' : ''}
    <div class="share-grid">
      <div class="share-left">
        <div class="header">
          <div>
            <h1>取件</h1>
          </div>
          <div class="header-actions">
            ${pageNav()}
          </div>
        </div>
        <div class="share-title">${displayTitle}</div>
        <div class="command-box" style="align-items:center;justify-content:center">
          ${file.has_thumb === 1 && !expired && !exhausted ? thumbPreview(file.code) : fileIconSvg()}
          ${!expired ? `<a href="/api/download/${file.code}" class="btn btn-primary" style="width:auto;padding:12px 40px">下载文件</a>` : ''}
        </div>
        ${fileMeta(file)}
      </div>
      ${shareRightPanel(file.code, shareUrl)}
    </div>`;
  return layout('取件', card(content), true, true);
}

// ---- 错误页 ----

export function errorPage(title: string, message: string): string {
  // 两处都会回显到 HTML：message 可能来自后端异常文本，必须转义
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const content = `
    <div class="header"><h1>${safeTitle}</h1></div>
    <p style="text-align:center">${safeMessage}</p>
    <a href="/" class="btn btn-secondary" style="margin-top:16px">返回</a>`;
  return layout(safeTitle, card(content));
}

// ---- 管理员登录页 ----

export function adminLoginPage(error?: string): string {
  const content = `
    <div class="header"><h1>管理员登录</h1><p>FileCodeBox 后台管理</p></div>
    ${error ? `<div style="color:var(--color-danger);text-align:center;margin-bottom:16px;font-size:14px">${error}</div>` : ''}
    <form action="/admin/login" method="post">
      <div class="input-group"><label>密码</label><input type="password" name="password" class="input" placeholder="输入管理员密码" required autofocus></div>
      <button type="submit" class="btn btn-primary">登录</button>
    </form>
    <div style="text-align:center;margin-top:16px"><a href="/" style="font-size:13px;color:var(--color-ink-2);text-decoration:none">&larr; 返回首页</a></div>`;
  return layout('管理员登录', card(content));
}

// ---- 管理面板 ----

const SORT_LABELS: Record<string, string> = {
  newest:    '最新上传',
  oldest:    '最早上传',
  largest:   '文件最大',
  smallest:  '文件最小',
  mostDownloaded:    '下载最多',
  leastDownloaded: '下载最少',
};

/** getDashboardStats 的返回结构（db.ts），后台统计卡片用 */
export interface AdminStats {
  totalFiles: number;
  totalSize: number;
  todayCount: number;
  todaySize: number;
  yesterdayCount: number;
  yesterdaySize: number;
}

export function adminPanel(
  files: FileRecord[],
  total: number,
  page: number,
  error?: string,
  filters?: { keyword: string; dateFrom: string; dateTo: string; sort: string },
  stats?: AdminStats,
): string {
  const totalPages = Math.ceil(total / 50);
  const pagination =
    totalPages > 1
      ? `<div style="text-align:center;margin-top:14px;font-size:13px;color:var(--color-ink-2)">第 ${page}/${totalPages} 页 &middot; 共 ${total} 个文件</div>`
      : '';

  const f = filters ?? { keyword: '', dateFrom: '', dateTo: '', sort: 'newest' };

  const fileRows = files
    .map((f) => {
      const expired = new Date(f.expire_at).getTime() < Date.now();
      const size = formatFileSize(f.size);
      return `<div class="file-list-item ${expired ? 'expired' : ''}">
        <span class="tag">${f.is_text === 1 ? '文本' : '文件'}</span>
        <a class="fname" href="/r/${escapeHtml(f.code)}" title="打开取件页">${escapeHtml(f.filename)}</a>
        <span class="fmeta">${escapeHtml(f.code)}</span>
        <span class="fmeta">${size}</span>
        <span class="fmeta">${f.download_count}次</span>
        <span class="fmeta">${f.expire_at.slice(0, 10)}</span>
        <form method="post" action="/admin/delete/${f.id}" style="display:inline;margin-left:6px" onsubmit="return confirm('\u786e\u8ba4\u5220\u9664\uff1f')">
          <button type="submit" class="btn-danger" style="background:none;border:none;cursor:pointer">删除</button>
        </form>
      </div>`;
    })
    .join('');

  // 构建带筛选参数的分页链接（保留当前 filter 状态）
  function pageUrl(p: number): string {
    const qs = new URLSearchParams();
    qs.set('page', String(p));
    if (f.keyword) qs.set('keyword', f.keyword);
    if (f.dateFrom) qs.set('date_from', f.dateFrom);
    if (f.dateTo) qs.set('date_to', f.dateTo);
    if (f.sort !== 'newest') qs.set('sort', f.sort);
    return `/admin?${qs.toString()}`;
  }

  const sortOptions = Object.entries(SORT_LABELS)
    .map(([k, v]) => `<option value="${k}"${k === f.sort ? ' selected' : ''}>${v}</option>`)
    .join('');

  const statCards = stats
    ? `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">文件总数</div><div class="stat-value">${stats.totalFiles}</div><div class="stat-sub">累计 ${formatFileSize(stats.totalSize)}</div></div>
      <div class="stat-card"><div class="stat-label">今日上传</div><div class="stat-value">${stats.todayCount}</div><div class="stat-sub">${formatFileSize(stats.todaySize)}</div></div>
      <div class="stat-card"><div class="stat-label">昨日上传</div><div class="stat-value">${stats.yesterdayCount}</div><div class="stat-sub">${formatFileSize(stats.yesterdaySize)}</div></div>
      <div class="stat-card"><div class="stat-label">已用空间</div><div class="stat-value">${formatFileSize(stats.totalSize)}</div><div class="stat-sub">R2 对象存储</div></div>
    </div>`
    : '';

  const content = `
    <div class="header">
      <div>
        <h1>管理面板</h1>
        <p>共 ${total} 个文件</p>
      </div>
      <div class="header-actions">
        <a href="/">首页</a>
        <a href="/admin/settings">设置</a>
        <a href="/admin/logout">退出</a>
      </div>
    </div>
    ${statCards}
    ${error ? `<div style="color:var(--color-danger);text-align:center;margin-bottom:14px;font-size:14px">${error}</div>` : ''}

    <!-- 筛选栏 -->
    <form method="get" action="/admin" style="margin-bottom:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
      <div class="input-group" style="margin:0;flex:1;min-width:140px">
        <label>关键词</label>
        <input type="text" name="keyword" class="input" value="${escapeHtml(f.keyword)}" placeholder="文件名搜索">
      </div>
      <div class="input-group" style="margin:0">
        <label>起始日期</label>
        <input type="date" name="date_from" class="input" value="${escapeHtml(f.dateFrom)}" min="2020-01-01">
      </div>
      <div class="input-group" style="margin:0">
        <label>截止日期</label>
        <input type="date" name="date_to" class="input" value="${escapeHtml(f.dateTo)}" min="2020-01-01">
      </div>
      <div class="input-group" style="margin:0">
        <label>排序</label>
        <select name="sort" class="input">${sortOptions}</select>
      </div>
      <button type="submit" class="btn btn-primary" style="width:auto;padding:9px 16px;margin-bottom:1px">筛选</button>
      ${f.keyword || f.dateFrom || f.dateTo || f.sort !== 'newest' ? `<a href="/admin" class="btn btn-secondary" style="width:auto;padding:9px 16px;text-decoration:none;margin-bottom:1px">重置</a>` : ''}
    </form>

    <div style="margin-bottom:14px">
      <form method="post" action="/admin/cleanup" style="display:inline" onsubmit="return confirm('\u786e\u8ba4\u6e05\u7406\u6240\u6709\u8fc7\u671f\u6587\u4ef6\uff1f')">
        <button type="submit" class="btn btn-secondary btn-sm" style="text-decoration:none">清理过期文件</button>
      </form>
    </div>
    <div>${fileRows || '<div style="text-align:center;color:var(--color-ink-2);padding:20px">暂无文件</div>'}</div>
    ${pagination}
    <div style="text-align:center;margin-top:14px">
      ${page > 1 ? `<a href="${pageUrl(page - 1)}" style="font-size:13px;margin-right:10px;color:var(--color-accent);text-decoration:none">&larr; 上一页</a>` : ''}
      ${page < totalPages ? `<a href="${pageUrl(page + 1)}" style="font-size:13px;color:var(--color-accent);text-decoration:none">下一页 &rarr;</a>` : ''}
    </div>`;
  return layout('管理面板', card(content), true, true);
}

// ---- 后台设置页 ----

export interface AdminConfig {
  /** '1' 允许游客上传 / '0' 仅管理员可上传 */
  openUpload: string;
  /** 当前生效的单文件上限（字节） */
  maxFileSize: number;
  /** 当前生效的默认过期天数 */
  defaultExpireDays: number;
  /** wrangler vars 的原始值，用于提示「未覆盖时的回退值」 */
  varsMaxFileSize: number;
  varsDefaultExpireDays: number;
}

export function adminSettingsPage(config: AdminConfig, saved?: string): string {
  const mb = (n: number) => (n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1);
  const content = `
    <div class="header">
      <div>
        <h1>系统设置</h1>
        <p>覆盖 wrangler 变量，保存后立即生效，无需重新部署</p>
      </div>
      <div class="header-actions">
        <a href="/">首页</a>
        <a href="/admin">文件</a>
        <a href="/admin/logout">退出</a>
      </div>
    </div>
    ${saved ? `<div style="color:var(--color-success);text-align:center;margin-bottom:14px;font-size:14px">${escapeHtml(saved)}</div>` : ''}
    <form method="post" action="/admin/settings">
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">游客上传</div>
          <div class="setting-desc">关闭后首页表单与开放 API 都只允许管理员上传，取件不受影响。</div>
        </div>
        <select name="openUpload" class="input setting-control">
          <option value="1"${config.openUpload !== '0' ? ' selected' : ''}>允许游客上传</option>
          <option value="0"${config.openUpload === '0' ? ' selected' : ''}>仅管理员可上传</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">单文件大小上限</div>
          <div class="setting-desc">单位字节。wrangler 变量为 ${config.varsMaxFileSize}（${mb(config.varsMaxFileSize)} MB），清空保存即回退到它。</div>
        </div>
        <input type="number" name="maxFileSize" class="input setting-control" min="1024" step="1" value="${config.maxFileSize}" placeholder="${config.varsMaxFileSize}">
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">默认过期天数</div>
          <div class="setting-desc">上传时未指定有效期才使用；有效期选择器里的「永久 / 按次数」优先于它。</div>
        </div>
        <input type="number" name="defaultExpireDays" class="input setting-control" min="1" max="3650" value="${config.defaultExpireDays}" placeholder="${config.varsDefaultExpireDays}">
      </div>
      <button type="submit" class="btn btn-primary">保存设置</button>
    </form>
    <div style="text-align:center;margin-top:16px"><a href="/admin" style="font-size:13px;color:var(--color-ink-2);text-decoration:none">&larr; 返回文件列表</a></div>`;
  return layout('系统设置', card(content), true, true);
}
