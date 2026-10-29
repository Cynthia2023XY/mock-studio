/** 为当前页面显示 Mock Studio 的真实接口命中提示。 */
(() => {
  // 避免同一页面被多条注入规则重复包装。
  if (window.__mockStudioNoticeInstalled) return;
  window.__mockStudioNoticeInstalled = true;
  console.info('[Mock Studio] 页面命中提示已启用');
  // 当前提示的自动隐藏定时器。
  let hideTimer;
  // 保存本次页面中实际命中的接口名称和首次命中顺序。
  const hitEndpoints = new Set();
  // 从实际请求地址提取接口路径末段，保留原始地址作为兜底。
  const getRequestName = (url) => {
    if (!url) return '未知接口';
    try {
      // 使用页面地址解析相对路径，并忽略查询参数和末尾斜杠。
      const parsed = new URL(url, window.location.href);
      // 网关接口通常使用路径最后一段作为真实接口名。
      const segment = parsed.pathname.split('/').filter(Boolean).pop();
      return segment ? decodeURIComponent(segment) : parsed.host;
    } catch {
      return String(url);
    }
  };
  // 在页面顶部展示本次页面已命中的接口名称。
  const showNotice = (url) => {
    // DOM 尚未就绪时等待解析完成再展示。
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => showNotice(url), { once: true });
      return;
    }
    // 使用独立节点避免影响业务页面的布局。
    let notice = document.getElementById('mock-studio-hit-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'mock-studio-hit-notice';
      notice.setAttribute('role', 'status');
      notice.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:12px 20px;border:2px solid #fff;border-radius:12px;background:#6d28d9;color:#fff;font:600 15px/1.5 system-ui,sans-serif;box-shadow:0 6px 24px #0007;pointer-events:none;max-width:90vw;text-align:center';
      document.body.appendChild(notice);
    }
    hitEndpoints.add(getRequestName(url));
    notice.textContent = `Mock Studio 已接管接口响应\n接口名称：${Array.from(hitEndpoints).join('、')}`;
    notice.style.whiteSpace = 'pre-line';
    notice.style.display = 'block';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { notice.style.display = 'none'; }, 6000);
  };
  // 监听 XHR 已完成响应，只有识别到 Mock 标记才提示。
  const originalSend = Reflect.get(XMLHttpRequest.prototype, 'send');
  // 保留浏览器原生响应头读取方法，避免页面调试工具替换实例方法。
  const originalGetResponseHeader = Reflect.get(XMLHttpRequest.prototype, 'getResponseHeader');
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      if (originalGetResponseHeader.call(this, 'x-mock-source') === 'mock-studio') {
        console.info('[Mock Studio] 已命中接口响应');
        showNotice(this.responseURL);
      }
    }, { once: true });
    return originalSend.apply(this, args);
  };
  // 同样监听 fetch 响应，保持原始响应和失败语义。
  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = function (...args) {
    return originalFetch.apply(this, args).then((response) => {
      if (response.headers.get('x-mock-source') === 'mock-studio') showNotice(response.url);
      return response;
    });
  };
})();
