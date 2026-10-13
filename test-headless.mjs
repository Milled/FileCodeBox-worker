/**
 * FileCodeBox 无头浏览器真实测试
 * 测试完整流程：首页加载 → 文本上传 → 取件查看 → 文件上传 → 下载
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'https://filebox.994613.xyz';

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), error: req.failure()?.errorText });
  });
  page.on('response', (resp) => {
    if (resp.status() >= 400) {
      failedRequests.push({ url: resp.url(), status: resp.status() });
    }
  });

  const results = {};

  // ===== 1. 首页加载 =====
  console.log('=== 测试 1: 首页加载 ===');
  try {
    const resp = await page.goto(BASE_URL + '/', { waitUntil: 'networkidle', timeout: 30000 });
    results.home = { status: resp.status() };
    const title = await page.title();
    const h1 = await page.locator('h1').first().textContent();
    results.home.title = title;
    results.home.h1 = h1;
    // 检查关键元素
    results.home.hasUploadForm = await page.locator('#uploadForm').count() > 0;
    results.home.hasTextPanel = await page.locator('#tab-text').count() > 0;
    results.home.hasRetrieveInput = await page.locator('input[name="code"]').count() > 0;
    console.log(`  状态: ${resp.status()}, 标题: ${title}, H1: ${h1}`);
    console.log(`  上传表单: ${results.home.hasUploadForm}, 文本面板: ${results.home.hasTextPanel}`);
    await page.screenshot({ path: '/tmp/test_home.png', fullPage: true });
    console.log('  截图已保存: /tmp/test_home.png');
  } catch (e) {
    results.home = { error: e.message };
    console.log(`  ❌ 错误: ${e.message}`);
  }

  // ===== 2. 文本上传 =====
  console.log('\n=== 测试 2: 文本上传 ===');
  let textCode = null;
  try {
    // 切换到文本面板
    await page.click('button.tab:has-text("文本")');
    await page.waitForTimeout(500);
    const textContent = '无头浏览器测试文本内容 ' + Date.now();
    await page.fill('#tab-text textarea', textContent);
    await page.fill('#tab-text input[name="code"]', '');
    await page.click('#textSubmitBtn');
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    // 等待跳转或结果
    await page.waitForTimeout(2000);
    const url = page.url();
    results.textUpload = { url };
    // 提取取件码
    const codeMatch = url.match(/\/r\/(\d{4})/) || (await page.locator('.code-value').textContent().catch(() => '')).match(/(\d{4})/);
    if (codeMatch) textCode = codeMatch[1];
    results.textUpload.code = textCode;
    console.log(`  URL: ${url}`);
    console.log(`  取件码: ${textCode}`);
    await page.screenshot({ path: '/tmp/test_text_upload.png', fullPage: true });
  } catch (e) {
    results.textUpload = { error: e.message };
    console.log(`  ❌ 错误: ${e.message}`);
  }

  // ===== 3. 文本取件查看 =====
  console.log('\n=== 测试 3: 文本取件查看 ===');
  try {
    if (textCode) {
      const resp = await page.goto(`${BASE_URL}/r/${textCode}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);
      results.textRetrieve = { status: resp.status() };
      const textContent = await page.locator('#textContent').textContent().catch(() => null);
      results.textRetrieve.hasText = textContent !== null && textContent !== '加载中…';
      console.log(`  状态: ${resp.status()}, 文本内容加载: ${results.textRetrieve.hasText}`);
      console.log(`  文本: ${textContent ? textContent.slice(0, 30) : 'null'}`);
      await page.screenshot({ path: '/tmp/test_text_retrieve.png', fullPage: true });
    } else {
      console.log('  跳过（无取件码）');
    }
  } catch (e) {
    results.textRetrieve = { error: e.message };
    console.log(`  ❌ 错误: ${e.message}`);
  }

  // ===== 4. 文件上传 =====
  console.log('\n=== 测试 4: 文件上传 ===');
  let fileCode = null;
  try {
    await page.goto(BASE_URL + '/', { waitUntil: 'networkidle' });
    // 创建测试文件内容
    const testFileContent = '这是一个无头浏览器测试文件，用于验证文件上传功能。' + Date.now();
    await page.setInputFiles('#fileInput', {
      name: 'test_headless.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(testFileContent, 'utf-8'),
    });
    await page.fill('#tab-file input[name="code"]', '');
    await page.click('#submitBtn');
    // 等待上传完成（可能有跳转）
    await page.waitForTimeout(5000);
    const url = page.url();
    results.fileUpload = { url };
    const codeMatch = url.match(/\/r\/(\d{4})/);
    if (codeMatch) fileCode = codeMatch[1];
    results.fileUpload.code = fileCode;
    console.log(`  URL: ${url}`);
    console.log(`  取件码: ${fileCode}`);
    await page.screenshot({ path: '/tmp/test_file_upload.png', fullPage: true });
  } catch (e) {
    results.fileUpload = { error: e.message };
    console.log(`  ❌ 错误: ${e.message}`);
  }

  // ===== 5. 文件下载 =====
  console.log('\n=== 测试 5: 文件下载 ===');
  try {
    if (fileCode) {
      const resp = await page.goto(`${BASE_URL}/r/${fileCode}`, { waitUntil: 'networkidle' });
      results.fileRetrieve = { status: resp.status() };
      const downloadBtn = await page.locator('a:has-text("下载文件")').count();
      results.fileRetrieve.hasDownloadBtn = downloadBtn > 0;
      console.log(`  状态: ${resp.status()}, 下载按钮: ${results.fileRetrieve.hasDownloadBtn}`);
      // 点击下载按钮
      if (downloadBtn > 0) {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
          page.click('a:has-text("下载文件")'),
        ]);
        if (download) {
          results.fileDownload = { filename: download.suggestedFilename() };
          console.log(`  下载文件名: ${download.suggestedFilename()}`);
        } else {
          results.fileDownload = { error: '无下载事件' };
          console.log('  ⚠️ 无下载事件');
        }
      }
      await page.screenshot({ path: '/tmp/test_file_retrieve.png', fullPage: true });
    }
  } catch (e) {
    results.fileRetrieve = { error: e.message };
    console.log(`  ❌ 错误: ${e.message}`);
  }

  // ===== 6. 管理面板访问（未登录应重定向到登录页）=====
  console.log('\n=== 测试 6: 管理面板 ===');
  try {
    const resp = await page.goto(`${BASE_URL}/admin`, { waitUntil: 'networkidle' });
    results.admin = { status: resp.status() };
    const hasLogin = await page.locator('input[name="password"]').count() > 0;
    results.admin.hasLoginForm = hasLogin;
    console.log(`  状态: ${resp.status()}, 登录表单: ${hasLogin}`);
    await page.screenshot({ path: '/tmp/test_admin.png', fullPage: true });
  } catch (e) {
    results.admin = { error: e.message };
    console.log(`  ❌ 错误: ${e.message}`);
  }

  // ===== 7. 不存在的取件码 =====
  console.log('\n=== 测试 7: 不存在的取件码 ===');
  try {
    const resp = await page.goto(`${BASE_URL}/r/9999`, { waitUntil: 'networkidle' });
    results.notFound = { status: resp.status() };
    const hasRetrieveForm = await page.locator('input[name="code"]').count() > 0;
    results.notFound.hasRetrieveForm = hasRetrieveForm;
    console.log(`  状态: ${resp.status()}, 返回取件表单: ${hasRetrieveForm}`);
  } catch (e) {
    results.notFound = { error: e.message };
    console.log(`  ❌ 错误: ${e.message}`);
  }

  // ===== 汇总 =====
  console.log('\n\n========================================');
  console.log('测试结果汇总');
  console.log('========================================');
  console.log('控制台错误:', consoleErrors.length > 0 ? consoleErrors : '无');
  console.log('失败请求:', failedRequests.length > 0 ? JSON.stringify(failedRequests, null, 2) : '无');
  console.log('\n详细结果:', JSON.stringify(results, null, 2));

  await browser.close();
}

test().catch((e) => {
  console.error('测试脚本错误:', e);
  process.exit(1);
});
