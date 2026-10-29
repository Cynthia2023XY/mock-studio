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
    open(method, url) { this.method = method; this.responseURL = url; }
    addEventListener(_name, listener) { this.listeners.push(listener); }
    getResponseHeader(name) { return name === 'x-mock-source' && this.mocked ? 'mock-studio' : null; }
    send() { this.listeners.forEach((listener) => listener()); return 'sent'; }
  }
  // 请求代理用于验证 fetch 原始响应对象是否被保留。
  const originalFetch = async (response) => response;
  // 保存页面请求函数与位置的模拟窗口。
  const window = { fetch: originalFetch, location: { href: 'http://example.test/page' } };
  // 用于观察提示节点的模拟文档。
  const document = { body: { appendChild: (node) => { notice = node; } }, addEventListener: () => {}, createElement: () => ({ style: {}, children: [], setAttribute: () => {}, addEventListener(name, listener) { this[name] = listener; }, appendChild(child) { this.children.push(child); } }) };
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
  assert.match(browser.getNotice().children[1].textContent, /1 个接口/);
  browser.getNotice().children[1].click();
  assert.match(browser.getNotice().children[0].textContent, /queryBullMarketFundExpHome/);
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
  assert.match(browser.getNotice().children[1].textContent, /2 个接口/);
  browser.getNotice().children[1].click();
  assert.match(browser.getNotice().children[0].textContent, /receive[\s\S]*query/);
});


test('复用 XHR 与同名不同域接口保留独立命中，页面异常不破坏响应', async () => {
  // 同一请求实例连续复用，观察器不会叠加。
  const browser = await createBrowser();
  // 原生 XHR 的每次实际响应都使用当前地址。
  const xhr = new browser.Request('http://one.test/api/query?first=1', true);
  xhr.open('POST', 'http://one.test/api/query?first=1');
  xhr.send();
  xhr.open('POST', 'http://one.test/api/query?second=2');
  xhr.send();
  assert.equal(xhr.listeners.length, 1);
  assert.match(browser.getNotice().children[1].textContent, /1 个接口/);
  xhr.open('POST', 'http://two.test/api/query');
  xhr.send();
  assert.match(browser.getNotice().children[1].textContent, /2 个接口/);
  // 提示 UI 更新失败时原始业务响应仍然返回。
  const response = { url: 'not a valid absolute URL', headers: { get: () => 'mock-studio' } };
  assert.equal(await browser.window.fetch(response), response);
});
