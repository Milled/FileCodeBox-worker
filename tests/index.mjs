#!/usr/bin/env node
/**
 * UI 测试套件入口（Playwright + Chromium，无测试框架依赖）
 *
 * 用法：
 *   npm run test:ui                          # 默认 http://127.0.0.1:8790
 *   BASE_URL=http://127.0.0.1:8787 npm run test:ui
 *   SHOT_DIR=/tmp/fcb-shots npm run test:ui  # 额外输出全页截图
 *
 * 前置条件见 README「本地开发与测试」：本地服务已启动、D1 已建表、.dev.vars 里有 ADMIN_PASSWORD。
 * 套件会真实上传文件并修改后台设置，因此默认拒绝非本机地址（需 ALLOW_REMOTE=1）。
 */
import { launchBrowser, BASE } from './helpers.mjs';
import { publicUiSuite } from './public-ui.mjs';
import { uploadInteractionsSuite } from './upload-interactions.mjs';
import { adminSettingsSuite } from './admin-settings.mjs';
import { thumbnailSuite } from './thumbnails.mjs';
import { chunkedSuite } from './chunked-upload.mjs';
import { securityHardeningSuite } from './security-hardening.mjs';

const SUITES = [publicUiSuite, uploadInteractionsSuite, adminSettingsSuite, thumbnailSuite, chunkedSuite, securityHardeningSuite];

const browser = await launchBrowser();
const results = [];
const timings = [];
const startedAll = Date.now();

console.log(`被测地址：${BASE}`);
try {
  for (const factory of SUITES) {
    const started = Date.now();
    try {
      results.push(await factory(browser));
    } catch (e) {
      results.push({
        name: factory.name,
        lines: [`✗ 套件执行异常 — ${e.message}`],
        failed: ['套件执行异常'],
        report() {
          console.log(`\n=== ${factory.name} ===`);
          console.log(this.lines.join('\n'));
          return false;
        },
      });
    }
    timings.push([factory.name, ((Date.now() - started) / 1000).toFixed(1)]);
  }
} finally {
  await browser.close();
}

console.log('\n================ 汇总 ================');
let passed = 0;
let failed = 0;
for (const r of results) {
  const ok = r.report();
  passed += r.lines.filter((l) => l.startsWith('✓')).length;
  failed += ok ? 0 : r.failed.length;
}
console.log(`\n各套件耗时：${timings.map(([n, s]) => `${n}=${s}s`).join(' · ')}`);
console.log(`总耗时 ${((Date.now() - startedAll) / 1000).toFixed(1)}s`);
console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
