import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/** 构建可验证脚本行为的最小浏览器环境 */
const createBrowser = async () => {
  // 保存插入页面的提示节点，避免依赖真实页面或代理。
  let notice;
  // 模拟浏览器原生 XHR，在发送时立即触发成功事件。
  class Request {
    constructor(url, mocked) { this.responseURL = url; this.mocked = mocked; this.listeners = []; }
    addEventListener(_name, listener) { this.listeners.push(listener); }
    getResponseHeader(name) { return name === 'x-mock-source' && this.mocked ? 'mock-studio' : null; }
    send() { this.listeners.forEach((listener) => listener()); return 'sent'; }
  }
  // 请求代理用于验证 fetch 原始响应对象是否被保留。
  const originalFetch = async (response) => response;
  // 保存页面请求函数与位置的模拟窗口。
  const window = { fetch: originalFetch, location: { href: 'http://example.test/page' } };
  // 用于观察提示节点的模拟文档。
  const document = { body: { appendChild: (node) => { notice = node; } }, getElementById: () => notice, createElement: () => ({ style: {}, setAttribute: () => {} }) };
  // 加载生产脚本，在独立上下文中安装监听器。
  const source = await readFile(new URL('./mock-notice.js', import.meta.url), 'utf8');
  // 运行页面提示脚本的隔离上下文。
  const context = vm.createContext({ window, document, XMLHttpRequest: Request, URL, console: { info: () => {} }, setTimeout: () => 1, clearTimeout: () => {} });
  vm.runInContext(source, context);
  return { window, Request, getNotice: () => notice, context, source };
};

test('XHR 仅对 Mock 响应提示并使用原始请求接口名', async () => {
  // 普通请求不应提示，Mock 请求应展示真实 URL 的接口名。
  const browser = await createBrowser();
  // 不应触发提示的普通请求。
  const plain = new browser.Request('http://example.test/plain', false);
  assert.equal(plain.send(), 'sent');
  assert.equal(browser.getNotice(), undefined);
  // 应展示接口名称的 Mock 请求。
  const mocked = new browser.Request('http://example.test/gw/queryBullMarketFundExpHome?x=1', true);
  assert.equal(mocked.send(), 'sent');
  assert.match(browser.getNotice().textContent, /接口名称：queryBullMarketFundExpHome/);
});

test('fetch 与 XHR 命中按首次顺序去重，不改变原响应', async () => {
  // 第二次注入不得重复包装，混合请求应汇总不同接口名。
  const browser = await createBrowser();
  // 首次注入后保存的请求函数。
  const installedFetch = browser.window.fetch;
  vm.runInContext(browser.source, browser.context);
  assert.equal(browser.window.fetch, installedFetch);
  // 服务或浏览器返回的响应。
  const response = { url: 'http://example.test/api/receive', headers: { get: () => 'mock-studio' } };
  assert.equal(await browser.window.fetch(response), response);
  new browser.Request('http://example.test/api/query', true).send();
  new browser.Request('http://example.test/api/receive', true).send();
  assert.match(browser.getNotice().textContent, /接口名称：receive、query$/);
});
