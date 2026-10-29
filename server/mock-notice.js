/** 在实际命中 Mock 后显示当前页面的常驻状态角标。 */
(() => {
  // 防止同一页面多次注入时重复包装请求。
  if (window.__mockStudioNoticeInstalled) return;
  window.__mockStudioNoticeInstalled = true;
  // 本次页面中实际命中的接口及最近命中时间。
  const hitEndpoints = new Map();
  // 当前页面最近一次命中的时间。
  let latestHit = '';
  // 用户是否展开接口详情。
  let expanded = false;
  // 可展开详情的角标按钮。
  let badge;
  // 展示当前页面命中接口的详情节点。
  let details;
  // 使用真实请求地址的最后一段作为接口名称。
  const getRequestName = (url) => {
    try {
      // 基于当前页面解析完整请求地址。
      const parsed = new URL(url, window.location.href);
      // 从网关地址中提取实际接口名称。
      const segment = parsed.pathname.split('/').filter(Boolean).pop();
      return segment ? decodeURIComponent(segment) : parsed.host;
    } catch { return String(url || '未知接口'); }
  };
  // 构建独立节点，避免业务页面样式影响角标。
  const render = () => {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', render, { once: true });
      return;
    }
    if (!badge) {
      // 与业务内容独立的悬浮容器。
      const container = document.createElement('div');
      container.id = 'mock-studio-hit-notice';
      container.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;color:#fff;font:14px/1.5 system-ui,sans-serif;max-width:min(360px,90vw)';
      badge = document.createElement('button');
      badge.type = 'button';
      badge.style.cssText = 'display:block;border:1px solid #c4b5fd;border-radius:999px;background:#6d28d9;color:#fff;padding:9px 16px;cursor:pointer;font:600 14px system-ui,sans-serif;box-shadow:0 4px 16px #0006';
      badge.setAttribute('aria-expanded', 'false');
      badge.addEventListener('click', () => { expanded = !expanded; render(); });
      details = document.createElement('div');
      details.style.cssText = 'margin-bottom:8px;padding:14px;border:1px solid #a78bfa;border-radius:12px;background:#201438;color:white;box-shadow:0 4px 16px #0006;overflow-wrap:anywhere';
      container.appendChild(details);
      container.appendChild(badge);
      // Shadow DOM 隔离页面全局样式；老浏览器保留内联样式回退。
      if (container.attachShadow) {
        // 详情和按钮从普通树移入隔离树，原有事件绑定保持不变。
        const shadow = container.attachShadow({ mode: 'open' });
        shadow.appendChild(details);
        shadow.appendChild(badge);
      }
      document.body.appendChild(container);
    }
    badge.textContent = `🟣 Mock 已接管 · ${hitEndpoints.size} 个接口`;
    badge.setAttribute('aria-expanded', String(expanded));
    details.style.display = expanded ? 'block' : 'none';
    details.textContent = `Mock Studio 已接管当前页面接口\n\n${Array.from(hitEndpoints.values(), (name) => `● ${name}`).join('\n')}\n\n最近命中：${latestHit}`;
    details.style.whiteSpace = 'pre-line';
  };
  // 命中成功后更新本次页面的去重列表。
  const recordHit = (url, method = 'GET') => {
    // 同名路径可以属于不同域名，查询参数变化仍算同一个接口。
    const parsed = new URL(url, window.location.href);
    // 首次插入顺序保留，重复命中只更新最近时间。
    const key = `${method.toUpperCase()} ${parsed.origin}${parsed.pathname}`;
    hitEndpoints.set(key, getRequestName(url));
    latestHit = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    render();
  };
  // 只观察带有 Mock Studio 标记的响应。
  const originalSend = Reflect.get(XMLHttpRequest.prototype, 'send');
  // 复用 XHR 对象时只注册一个观察器，避免前次监听残留。
  const observed = new WeakSet();
  // 原生方法用于跨域响应头读取，不覆盖业务返回值。
  const originalGetResponseHeader = Reflect.get(XMLHttpRequest.prototype, 'getResponseHeader');
  // 保存 XHR 请求方法，仅用于接口去重。
  const methods = new WeakMap();
  // 在业务注册 onload 前安装观察器，保证立即复用 XHR 也保留当前响应。
  const observeRequest = (xhr) => {
    if (observed.has(xhr)) return;
    observed.add(xhr);
    xhr.addEventListener('load', () => {
      try { if (originalGetResponseHeader.call(xhr, 'x-mock-source') === 'mock-studio') recordHit(xhr.responseURL, methods.get(xhr)); } catch { /* 提示异常不能影响业务请求。 */ }
    }, true);
  };
  // 原生 open 仍完整接收原始参数。
  const originalOpen = Reflect.get(XMLHttpRequest.prototype, 'open');
  if (originalOpen) XMLHttpRequest.prototype.open = function (...args) {
    try { methods.set(this, String(args[0])); observeRequest(this); } catch { /* 提示异常不能影响请求。 */ }
    return originalOpen.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try { observeRequest(this); } catch { /* 无法安装观察器时仍发送原业务请求。 */ }
    return originalSend.apply(this, args);
  };
  // 保持 fetch 返回原有的响应对象和异常语义。
  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = function (...args) {
    return originalFetch.apply(this, args).then((response) => {
      try { if (response.headers.get('x-mock-source') === 'mock-studio') recordHit(response.url, args[1]?.method || (typeof args[0] === 'object' && args[0]?.method) || 'GET'); } catch { /* 提示异常不能影响业务请求。 */ }
      return response;
    });
  };
})();
