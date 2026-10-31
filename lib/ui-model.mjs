/** JSON 校验保留引擎报告的位置，不把错误内容拼成 HTML。 */
export const inspectJson = (source) => {
  try { JSON.parse(source); return { valid: true, message: '', offset: 0, line: 1, column: 1 }; }
  catch (error) {
    const message = error instanceof Error ? error.message : '无效 JSON';
    const position = /position\s+(\d+)/i.exec(message);
    const location = /line\s+(\d+)\s+column\s+(\d+)/i.exec(message);
    let offset = position ? Math.min(source.length, Number(position[1])) : source.length;
    if (!position && location) offset = source.split('\n').slice(0, Number(location[1]) - 1).reduce((sum, line) => sum + line.length + 1, 0) + Number(location[2]) - 1;
    const preceding = source.slice(0, offset).split('\n');
    return { valid: false, message: source.trim() ? 'JSON 格式错误，请检查此处的引号、逗号或括号' : '请输入 JSON 内容', offset, line: preceding.length, column: preceding[preceding.length - 1].length + 1 };
  }
};

/** 仅做词法着色，所有文本仍由 React 转义。 */
export const jsonTokens = (source) => {
  const pattern = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}:,]|\[|\]/g;
  const tokens = [];
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > offset) tokens.push({ text: source.slice(offset, match.index), kind: 'plain' });
    const text = match[0];
    const kind = text.startsWith('"') ? /^\s*:/.test(source.slice(match.index + text.length)) ? 'key' : 'string' : /^[\d-]/.test(text) ? 'number' : /^(true|false|null)$/.test(text) ? 'literal' : 'punctuation';
    tokens.push({ text, kind });
    offset = match.index + text.length;
  }
  if (offset < source.length) tokens.push({ text: source.slice(offset), kind: 'plain' });
  return tokens;
};

/** 长地址突出最后的接口名，复制始终使用未经缩短的原值。 */
export const describeAddress = (value) => {
  try {
    const url = new URL(value);
    const segment = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
    let name = segment;
    try { name = decodeURIComponent(segment); } catch { /* 保留原编码 */ }
    return { name, context: `${url.host}${url.pathname}${url.search}` };
  } catch { return { name: value, context: '包含此文本的请求地址' }; }
};

/** 状态明确区分配置可用与请求实际经过代理，旧服务没有验证时间时不冒充成功。 */
export const projectStatus = ({ connected, enabled, count, pending, whistle, now = Date.now() }) => {
  if (!connected) return { tone: 'danger', label: '本地服务未连接', hint: '请先启动 Mock Studio 服务。' };
  if (!enabled) return { tone: 'neutral', label: '项目已关闭', hint: '本项目不会返回 Mock；启用项目后才会使用已开启的规则。' };
  if (pending) return { tone: 'warning', label: '正在保存并同步', hint: '正在更新配置，请稍候。' };
  if (!count) return { tone: 'neutral', label: '尚未启用规则', hint: '先准备响应内容，再打开规则开关或启用一个组合。' };
  if (!whistle?.ok) return { tone: 'warning', label: '规则待同步', hint: whistle?.message || '配置已保存，正在等待 Whistle 接收规则。' };
  const checked = Date.parse(whistle.checkedAt ?? '');
  if (whistle.verified === false || !Number.isFinite(checked) || now - checked > 60000 || (whistle.desiredDigest && whistle.desiredDigest !== whistle.verifiedDigest)) return { tone: 'warning', label: '规则待验证', hint: '代理验证结果已过期或配置尚未验证，请检查 Whistle 连接。' };
  return { tone: 'success', label: '规则可用', hint: '已同步并验证 Whistle 规则；实际命中还需浏览器经过代理，HTTPS 需正确配置证书。' };
};
