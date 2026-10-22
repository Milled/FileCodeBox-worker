import type { ChunkTask, FileRecord } from '../types';
import { CHUNK_PART_SIZE, CHUNK_THRESHOLD } from '../chunk';
import { formatFileSize, escapeHtml } from '../utils';
import { FALLBACK_MAX_FILE_SIZE } from '../shared';
import { layout } from './layout';

/** layout 不再包卡片，页面自行决定卡片数量（首页三张，其余一张） */
const card = (inner: string) => `<div class="card">${inner}</div>`;

// ---- 首页 ----

export interface HomeOptions {
  /** open_upload 设置；为 false 时首页只显示登录引导 */
  uploadAllowed?: boolean;
  /** 当前生效的默认过期天数（fc_settings 优先于 wrangler vars） */
  defaultExpireDays?: number;
  /** 当前生效的单文件上限，前端据此拦截超限文件 */
  maxFileSize?: number;
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
  const maxBytes = typeof opts.maxFileSize === 'number' && opts.maxFileSize > 0 ? opts.maxFileSize : FALLBACK_MAX_FILE_SIZE;

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
    ${uploadAllowed ? uploadUi(days, maxBytes) : guestBlockedUi()}
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
function uploadUi(days: number, maxBytes: number): string {
  return `
    <div class="tabs">
      <button class="tab active" data-tab="file" onclick="switchTab('file')">文件</button>
      <button class="tab" data-tab="text" onclick="switchTab('text')">文本</button>
    </div>

    <!-- 文件上传面板 -->
    <div id="tab-file" class="tab-panel active">
      <form id="uploadForm" onsubmit="return handleUpload(event)">
        <div class="input-group">
          <div class="dz" id="dropZone" tabindex="0" role="button" aria-label="点击或拖拽文件上传" data-max-bytes="${maxBytes}">
            <span class="dz-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V5"/><path d="m7 10 5-5 5 5"/><path d="M5 19h14"/></svg></span>
            <span class="dz-title">点击选择，或拖拽文件到此处</span>
            <span class="dz-hint">支持直接粘贴 · 可多选，每个文件各自生成取件码 · 单个文件上限 ${escapeHtml(formatFileSize(maxBytes))}</span>
            <input type="file" name="file" id="fileInput" class="dz-input" multiple>
          </div>
          <div class="file-chips" id="fileList"></div>
          <p class="upload-notice" id="uploadNotice" role="alert" hidden></p>
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
              <label>自定义取件码 <span class="hint" id="fileCodeHint">（可选，留空自动生成）</span></label>
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
    // 上传限流是 10 次/分钟，批量再多也只会撞 429；前后端统一到 10
    var MAX_BATCH_FILES = 10;
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
      if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
      if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
      return Math.round(n) + ' B';
    }

    // ---- 文件选择：点击 / 拖拽 / 粘贴 ----
    // 上限由服务端写进 dropzone 的 data-max-bytes（fc_settings 优先于 wrangler vars），
    // 前端写死数字会让后台一改设置就失真
    function maxBytes() {
      var dz = document.getElementById('dropZone');
      var n = dz ? parseInt(dz.getAttribute('data-max-bytes'), 10) : 0;
      return Number.isFinite(n) && n > 0 ? n : Infinity;
    }

    function overLimit() {
      var cap = maxBytes();
      return pendingFiles.filter(function (f) { return f.size > cap; });
    }

    function notice(msg) {
      var el = document.getElementById('uploadNotice');
      if (!el) return;
      el.textContent = msg || '';
      el.hidden = !msg;
    }

    // 超限文件允许留在列表里（否则用户不知道被丢了哪个），但标红并在提交时整体拦下
    function reportOverLimit() {
      var overs = overLimit();
      if (!overs.length) { notice(''); return overs; }
      var cap = maxBytes();
      notice(overs.length + ' 个文件超过 ' + fmtBytes(cap) + ' 上限，点击发件不会开始上传：'
        + overs.map(function (f) { return f.name + '（' + fmtBytes(f.size) + '）'; }).join('、'));
      return overs;
    }

    function addFiles(list) {
      var seen = {};
      var truncated = false;
      pendingFiles.forEach(function (f) { seen[f.name + ':' + f.size] = true; });
      Array.prototype.forEach.call(list, function (f) {
        var key = f.name + ':' + f.size;
        if (seen[key]) return;
        if (pendingFiles.length >= MAX_BATCH_FILES) { truncated = true; return; }
        pendingFiles.push(f);
        seen[key] = true;
      });
      renderChips();
      reportOverLimit();
      if (truncated) notice('一次最多上传 ' + MAX_BATCH_FILES + ' 个文件；多出的已忽略');
    }

    function renderChips() {
      var box = document.getElementById('fileList');
      if (!box) return;
      var cap = maxBytes();
      box.textContent = '';
      pendingFiles.forEach(function (f, i) {
        var over = f.size > cap;
        var chip = document.createElement('div');
        chip.className = over ? 'file-chip chip-over' : 'file-chip';
        var name = document.createElement('span');
        name.className = 'chip-name';
        name.textContent = f.name;
        var size = document.createElement('span');
        size.className = 'chip-size';
        size.textContent = over ? fmtBytes(f.size) + ' · 超上限' : fmtBytes(f.size);
        if (over) size.title = '超过 ' + fmtBytes(cap) + ' 的发件上限，不会被上传';
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'chip-remove';
        rm.setAttribute('aria-label', '移除 ' + f.name);
        rm.textContent = '×';
        rm.onclick = function () { pendingFiles.splice(i, 1); renderChips(); reportOverLimit(); };
        chip.appendChild(name); chip.appendChild(size); chip.appendChild(rm);
        box.appendChild(chip);
      });
      syncCodeFieldForBatch();
    }

    // 多文件时把自定义码字段禁用掉：一个码只能对应一个文件，
    // 让 N 个文件共用一个码的结果是第 2 个起全部「取件码已被占用」
    function syncCodeFieldForBatch() {
      var group = document.getElementById('fileCodeBoxes');
      if (!group) return;
      var multi = pendingFiles.length > 1;
      var hint = document.getElementById('fileCodeHint');
      if (hint) hint.textContent = multi ? '（多文件时自动分配连号取件码）' : '（可选，留空自动生成）';
      group.classList.toggle('is-disabled', multi);
      Array.prototype.forEach.call(group.querySelectorAll('input'), function (b) { b.disabled = multi; });
      // 已填的值不清空：从 3 个文件删回 1 个时，用户填的码还能用
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
        // 同 filePage：错误响应也要把 body 读掉，避免请求一直挂在网络上
        .then(function (r) { return r.arrayBuffer().catch(function () {}); })
        .then(function () { return null; })
        .catch(function () { return null; });
    }

    // ---- 上传 ----
    // 取件码不在这里拼：单文件用自定义码，多文件用服务端分配的连号，逐个文件各自带
    function uploadParams() {
      var style = document.getElementById('fileExpireStyle');
      var value = document.getElementById('fileExpireValue');
      var max = document.getElementById('fileMaxDownloads');
      var q = 'expire_style=' + encodeURIComponent(style ? style.value : 'day');
      q += '&expire_value=' + encodeURIComponent(value && value.value ? value.value : '7');
      q += '&max_downloads=' + encodeURIComponent(max && max.value ? max.value : '-1');
      return q;
    }

    // 拿不到连号就返回空数组，让服务端随机生成 —— 批次不能因为分配失败而卡住
    function fetchCodeRun(n) {
      if (n < 2) return Promise.resolve([]);
      return fetch('/api/codes/' + n)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return d && d.codes && d.codes.length === n ? d.codes : []; })
        .catch(function () { return []; });
    }

    function uploadOne(file, query, code, onProgress) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload?' + query + '&code=' + encodeURIComponent(code || ''));
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

    // ---- 分片上传（大文件） ----
    // 单次请求除了受套餐的体积上限约束，还受时间约束：慢上行下一个大 PUT 会在半途被掐断，
    // 而且没有重试粒度。所以超过阈值的文件一律切开，每片是独立 PUT（带 Content-Length 的
    // Blob），服务端把它们直接流进同一个 R2 multipart 会话，complete 时由 R2 合成一个对象
    // —— 仍然只有一个取件码。阈值与片大小都取自服务端常量（src/chunk.ts），两端不各写一个数字
    var CHUNK_AT = ${CHUNK_THRESHOLD};

    function fetchJson(url, init) {
      return fetch(url, init).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) {
          if (r.ok && j) return j;
          throw new Error((j && (j.error || j.msg)) || ('上传失败（HTTP ' + r.status + '）'));
        });
      });
    }

    // 用 XHR 而不是 fetch：只有它能报「上传方向」的进度。
    // fetch 要等整片传完才有结果，130MB 的文件在慢上行下会长时间停在 0 B/s，
    // 用户完全分不清是慢还是卡死
    function putPart(s, file, n, attempt, onLoaded) {
      var start = (n - 1) * s.part_size;
      var blob = file.slice(start, Math.min(start + s.part_size, file.size));
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/upload/chunk/' + s.session + '/' + n);
        xhr.upload.onprogress = function (e) { if (e.lengthComputable) onLoaded(n, e.loaded); };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) { onLoaded(n, blob.size); resolve(); return; }
          var msg = '';
          try { msg = JSON.parse(xhr.responseText).error; } catch (err) { msg = ''; }
          reject(new Error(msg || ('分片 ' + n + ' 上传失败（HTTP ' + xhr.status + '）')));
        };
        xhr.onerror = function () { reject(new Error('分片 ' + n + ' 网络错误')); };
        xhr.send(blob);
      }).catch(function (e) {
        // 弱网下只重传这一片，不用整个文件重来
        if (attempt < 2) return putPart(s, file, n, attempt + 1, onLoaded);
        throw e;
      });
    }

    // 3 路并发，进度是所有在飞片的字节之和（否则会来回跳）
    function runPartPool(s, todo, file, base, onProgress) {
      var queue = todo.slice();
      var live = {};
      var finished = 0;
      var bail = null;
      function report() {
        var bytes = base;
        for (var k in live) bytes += live[k];
        // 外层回调的签名是 (loaded, total, extra)，标签必须放第三位，否则会盖掉 total
        onProgress(bytes, file.size, '分片 ' + finished + '/' + s.total_parts);
      }
      function onLoaded(n, bytes) {
        if (live[n] === bytes) return;
        live[n] = bytes;
        report();
      }
      function worker() {
        // 一片彻底失败后不再取新片：继续传只是白耗上行带宽，而各泳道各自 reject 会让
        // Promise.all 之外的错误变成未捕获异常（控制台一片红，用户看不出到底哪片坏了）
        if (bail || !queue.length) return Promise.resolve();
        var n = queue.shift();
        return putPart(s, file, n, 0, onLoaded).then(function () {
          finished += 1;
          return worker();
        }, function (e) {
          if (!bail) bail = e;
        });
      }
      report();  // 先出一次「分片 0/N」，让界面立刻证明分片通道已经跑起来
      var workers = [];
      var lanes = Math.min(3, queue.length);
      for (var i = 0; i < lanes; i++) workers.push(worker());
      return Promise.all(workers).then(function () { if (bail) throw bail; });
    }

    // 正在飞的会话，页面被关掉时用 keepalive 兜底 abort（那时 .catch 根本不会执行，
    // 而挂着不管的分片会一直占存储直到 6 小时超时）
    var liveChunks = {};
    function abortLiveChunks() {
      Object.keys(liveChunks).forEach(function (id) {
        fetch('/api/upload/chunk/abort/' + id, { method: 'POST', keepalive: true }).catch(function () {});
      });
    }
    window.addEventListener('pagehide', abortLiveChunks);

    function chunkUpload(file, query, code, onProgress) {
      var p = {};
      query.split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i > 0) p[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
      });
      var handle = '';
      return fetchJson('/api/upload/chunk/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          content_type: file.type || 'application/octet-stream',
          code: code || '',
          expire_style: p.expire_style,
          expire_value: p.expire_value,
          max_downloads: p.max_downloads,
        }),
      }).then(function (s) {
        handle = s.session;
        liveChunks[handle] = true;
        var indexes = [];
        for (var n = 1; n <= s.total_parts; n++) indexes.push(n);
        // 先问服务端已经收到哪些片，重试时不白传
        return fetchJson('/api/upload/chunk/status/' + handle, {})
          .catch(function () { return { done: [] }; })
          .then(function (st) {
            var got = {};
            (st && st.done ? st.done : []).forEach(function (n) { got[n] = true; });
            var todo = indexes.filter(function (n) { return !got[n]; });
            // 已完成的片按真实字节计入（末片通常不是完整 part_size），
            // 否则续传时进度元信息会超过文件总大小
            var base = 0;
            (st && st.done ? st.done : []).forEach(function (n) {
              base += n < s.total_parts ? s.part_size : file.size - s.part_size * (s.total_parts - 1);
            });
            return runPartPool(s, todo, file, base, onProgress);
          })
          .then(function () {
            return fetchJson('/api/upload/chunk/complete/' + handle, { method: 'POST' })
              .then(function (r) {
                delete liveChunks[handle];
                return r;
              });
          });
      }).catch(function (e) {
        // 传败了要自己 abort：未完成的分片不是对象，R2 面板看不见、后台「清理过期文件」也
        // 扫不到，留着就一直占存储。abort 失败也要把原错误抛出去，别盖掉真正的失败原因
        if (!handle) throw e;
        delete liveChunks[handle];
        return fetchJson('/api/upload/chunk/abort/' + handle, { method: 'POST' })
          .catch(function () {})
          .then(function () { throw e; });
      });
    }

    function sendOne(file, query, code, onProgress) {
      if (file.size > CHUNK_AT) return chunkUpload(file, query, code, onProgress);
      return uploadOne(file, query, code, onProgress);
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
      // 有一个超限就整批不发：半批上传会让人以为全部成功了
      if (reportOverLimit().length) {
        status.style.display = 'block';
        status.textContent = '未开始上传';
        return false;
      }
      notice('');

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
      var collected = [];
      var failed = [];
      // 一个码只能对应一个文件，所以多文件时自定义码不可用，改用服务端分配的连号段；
      // 单文件仍走用户填的自定义码（留空则由服务端随机生成）
      var custom = document.getElementById('fileCode');
      var runPromise = jobs.length > 1
        ? fetchCodeRun(jobs.length)
        : Promise.resolve([custom ? custom.value.trim() : '']);
      runPromise.then(function (run) {
        var chain = Promise.resolve();
        jobs.forEach(function (file, idx) {
          chain = chain.then(function () {
            return sendOne(file, query, run[idx] || '', function (loaded, total, extra) {
              onProgress(0, loaded);
              paint(done + loaded, '上传中 (' + (idx + 1) + '/' + jobs.length + ') ' + file.name
                + (extra ? ' · ' + extra : ''));
            }).then(function (data) {
              done += file.size;
              collected.push({ name: file.name, code: data.code, size: file.size });
              paint(done, '已完成 ' + (collected.length + failed.length) + '/' + jobs.length);
              // 缩略图必须在跳转前落库，成功页才知道该不该输出 <img>；
              // 失败只回退成文件图标，不能拖垮整条上传链
              return makeThumb(file).then(function (thumb) {
                return thumb ? uploadThumb(data.code, thumb) : null;
              });
            }).catch(function (err) {
              // 单个文件失败不再中断整批：后面的继续传，最后统一汇总
              done += file.size;
              failed.push({ file: file, name: file.name, reason: (err && err.message) || '上传失败' });
              paint(done, '已完成 ' + (collected.length + failed.length) + '/' + jobs.length);
            });
          });
        });
        return chain;
      }).then(function () {
        var elapsed = Math.max(1, Date.now() - startedAt);
        if (collected.length === 1 && !failed.length) {
          status.textContent = '上传完成，跳转中…';
          // sent=1 → 上传成功视图（与文本一致），而非收件人的下载页
          window.location.href = '/r/' + collected[0].code + '?sent=1';
          return;
        }
        btn.disabled = false;
        btn.textContent = '发件并获取取件码';
        status.textContent = (failed.length
          ? (collected.length ? '成功 ' + collected.length + ' 个 · 失败 ' + failed.length + ' 个' : '全部上传失败')
          : '全部完成 · ' + collected.length + ' 个文件') + ' · ' + (elapsed / 1000).toFixed(1) + 's';
        // 小文件走不到采样窗口，收尾用平均速率，避免显示 0 B/s
        var sentBytes = collected.reduce(function (s, f) { return s + f.size; }, 0);
        meta.textContent = fmtBytes(sentBytes) + ' / ' + fmtBytes(totalBytes) + ' · 平均 ' + fmtBytes((sentBytes / elapsed) * 1000) + '/s';
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
        failed.forEach(function (item) {
          var row = document.createElement('div');
          row.className = 'result-item result-failed';
          var name = document.createElement('span');
          name.className = 'rname';
          name.textContent = item.name;
          var reason = document.createElement('span');
          reason.className = 'rfail';
          reason.textContent = item.reason;
          row.appendChild(name); row.appendChild(reason);
          results.appendChild(row);
        });
        // 失败的留在列表里，用户移除坏文件后可直接重试其余的
        pendingFiles = failed.map(function (item) { return item.file; });
        renderChips();
        if (failed.length) notice(failed.length + ' 个文件上传失败，已保留在列表中；其余 ' + collected.length + ' 个已完成。');
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

    // 浏览器后退会从 bfcache 恢复表单页：按钮/进度条可能还停在「上传中」，
    // 必须一起还原，否则看起来像卡死
    window.addEventListener('pageshow', function () {
      var b = document.getElementById('textSubmitBtn');
      if (b) { b.disabled = false; b.textContent = '发件并获取取件码'; }
      var ub = document.getElementById('submitBtn');
      if (ub) { ub.disabled = false; ub.textContent = '发件并获取取件码'; }
      var wrap = document.getElementById('uploadProgress');
      if (wrap) wrap.style.display = 'none';
      var bar = document.getElementById('uploadProgressBar');
      if (bar) bar.style.width = '0%';
      var meta = document.getElementById('uploadMeta');
      if (meta) meta.hidden = true;
      var status = document.getElementById('uploadStatus');
      if (status) status.textContent = '';
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

/** 页头三件套。发件带 ?send=1 让首页把焦点放到发件区，取件就是回主页 */
function pageNav(): string {
  return `<a href="/?send=1">发件</a>
        <a href="/">取件</a>
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
  // 与取件页同一套优先级：图片看缩略图，文本看正文，其余给文件图标
  const preview = hasThumb
    ? thumbPreview(code)
    : text !== undefined
      ? `<div class="command-text">${escapeHtml(text)}</div>`
      : fileIconSvg();
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
          ${preview}
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
                // 必须读掉错误响应体：不消费 403/404 的 body 时 Chromium 会一直把请求
                // 算作在飞，页面永远到不了 networkidle（自动化测试与部分空闲检测会卡住）
                return r.text().catch(function () { return null; }).then(function () { return null; });
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
  /** 配额视角的已用/上限（含缩略图，且与 R2 实测对账），与 enforcement 用的是同一个数；
   *  sessions 是进行中的分片上传，未 abort 的分片不在 list() 里，只能在这里清 */
  storage?: { used: number; limit: number; sessions?: Array<ChunkTask & { parts_done: number }> },
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

  // 未完成的分片会话：R2 的 multipart 不是对象，面板看不到、孤儿扫描 list() 也扫不到，
  // 只有 abort 能释放，所以必须给管理员一个立刻放弃的入口，而不是干等超时
  const sessions = storage?.sessions ?? [];
  const sessionRows = sessions
    .map((s) => {
      const sec = Math.max(0, Math.floor((Date.now() - new Date(s.created_at).getTime()) / 1000));
      const held = sec < 60 ? `${sec} 秒` : sec < 3600 ? `${Math.floor(sec / 60)} 分钟` : `${Math.floor(sec / 3600)} 小时`;
      return `<div class="file-list-item">
        <span class="tag">分片</span>
        <span class="fname" title="取件码 ${escapeHtml(s.code)}">${escapeHtml(s.filename)}</span>
        <span class="fmeta">${formatFileSize(s.size)}</span>
        <span class="fmeta">${s.parts_done}/${s.total_parts} 片</span>
        <span class="fmeta">挂起 ${held}</span>
        <form method="post" action="/admin/chunk/abort" style="display:inline;margin-left:6px" onsubmit="return confirm('\u786e\u8ba4\u653e\u5f03\u8fd9\u4e2a\u5206\u7247\u4f1a\u8bdd\uff1f\u5df2\u4e0a\u4f20\u7684\u5206\u7247\u4f1a\u88ab\u5220\u9664')">
          <input type="hidden" name="upload_id" value="${escapeHtml(s.upload_id)}">
          <button type="submit" class="btn-danger" style="background:none;border:none;cursor:pointer">放弃</button>
        </form>
      </div>`;
    })
    .join('');

  const sessionBlock = sessions.length
    ? `<div class="chunk-sessions">
      <div class="cs-head">
        <span>进行中的分片上传 ${sessions.length} 个 · 已声明 ${formatFileSize(sessions.reduce((n, s) => n + s.size, 0))}</span>
        <form method="post" action="/admin/chunk/abort-all" onsubmit="return confirm('\u786e\u8ba4\u653e\u5f03\u5168\u90e8\u5206\u7247\u4f1a\u8bdd\uff1f\u6b63\u5728\u4e0a\u4f20\u7684\u4f1a\u8bdd\u4f1a\u5931\u8d25')">
          <button type="submit" class="btn btn-secondary btn-sm">全部放弃</button>
        </form>
      </div>
      <div class="setting-desc">这些是还没传完的分片，不占文件列表也不出现在 R2 面板里，只有放弃（abort）才会释放其存储占用。若有人正在上传请勿误点。「全部放弃」每批最多处理 8 个，列表仍有残留时再点一次。</div>
      ${sessionRows}
    </div>`
    : '';

  const statCards = stats
    ? `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">文件总数</div><div class="stat-value">${stats.totalFiles}</div><div class="stat-sub">累计 ${formatFileSize(stats.totalSize)}</div></div>
      <div class="stat-card"><div class="stat-label">今日上传</div><div class="stat-value">${stats.todayCount}</div><div class="stat-sub">${formatFileSize(stats.todaySize)}</div></div>
      <div class="stat-card"><div class="stat-label">昨日上传</div><div class="stat-value">${stats.yesterdayCount}</div><div class="stat-sub">${formatFileSize(stats.yesterdaySize)}</div></div>
      <div class="stat-card"><div class="stat-label">已用空间</div><div class="stat-value">${formatFileSize(storage?.used ?? stats.totalSize)}</div><div class="stat-sub">${storage && storage.limit > 0 ? `上限 ${formatFileSize(storage.limit)} · 剩余 ${formatFileSize(Math.max(0, storage.limit - storage.used))}` : '未设总占用上限'}</div></div>
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
      <form method="post" action="/admin/cleanup" style="display:inline" onsubmit="return confirm('\u786e\u8ba4\u6e05\u7406\u6240\u6709\u8fc7\u671f\u6587\u4ef6\uff1f')" title="同时放弃超过 6 小时未完成的分片上传">
        <button type="submit" class="btn btn-secondary btn-sm" style="text-decoration:none">清理过期文件</button>
      </form>
    </div>
    ${sessionBlock}
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
  /** R2 总占用上限（字节）；0 = 不限制 */
  maxTotalStorage: number;
  /** storage_used 计数器的当前值（字节），由 Cron 与 R2 实测值对账 */
  storageUsed: number;
  /** wrangler vars 的原始值，用于提示「未覆盖时的回退值」 */
  varsMaxFileSize: number;
  varsDefaultExpireDays: number;
}

export function adminSettingsPage(config: AdminConfig, saved?: string): string {
  const mb = (n: number) => (n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1);
  // 表单以 MB 为单位（字节数对人不直观），存进去仍是字节：
  // 服务端比较、兼容 API 与 fc_settings 的语义都不变
  const toMb = (bytes: number) => (bytes > 0 ? String(Math.round((bytes / 1048576) * 100) / 100) : '');
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
          <div class="setting-title">单文件大小上限（MB）</div>
          <div class="setting-desc">
            <div>单位 MB（可填小数，如 0.5）。生效优先级：此处填写值 &gt; wrangler 变量 ${mb(config.varsMaxFileSize)} MB &gt; 内置兜底 100 MB；清空保存即回退到变量值。</div>
            <div>超过 ${Math.round(CHUNK_THRESHOLD / 1048576)} MiB 的文件会自动走分片上传（每片 ${Math.round(CHUNK_PART_SIZE / 1048576)} MiB，由 R2 合并成一个对象，仍然只有一个取件码），所以这里填多大都能传 —— 不受 Cloudflare 单次请求体上限（Free/Pro 100 MB、Business 200 MB）约束。分片仍受「R2 总占用上限」以及单次会话 1000 片（约 16 GiB）的限制。</div>
          </div>
        </div>
        <input type="number" name="maxFileSizeMb" class="input setting-control" min="0.1" max="5120" step="0.1" value="${toMb(config.maxFileSize)}" placeholder="${toMb(config.varsMaxFileSize)}">
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">R2 总占用上限（MB）</div>
          <div class="setting-desc">
            <div>单位 MB，留空或 0 = 不限制。当前已用 ${formatFileSize(config.storageUsed)}${config.maxTotalStorage > 0 ? ` / 上限 ${formatFileSize(config.maxTotalStorage)}（剩余 ${formatFileSize(Math.max(0, config.maxTotalStorage - config.storageUsed))}）` : ''}。</div>
            <div>统计口径是本应用写入的 R2 对象（主文件 + 缩略图），不含你手动放进桶里的其他文件；数值随上传与删除实时增减，并由每 30 分钟一次的定时任务用 R2 实测值对账。</div>
            <div>撞到上限时新的上传与文本分享都会被拒（507），已有文件不受影响；删除文件或等它们过期即释放空间。</div>
            <div>R2 免费额度为 10 GiB 存储，超出部分按量计费且不会自动熔断，建议按预算设一个上限。</div>
          </div>
        </div>
        <input type="number" name="maxTotalStorageMb" class="input setting-control" min="0" step="0.1" value="${toMb(config.maxTotalStorage)}" placeholder="0 = 不限制">
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
