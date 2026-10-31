import { StudioError } from './model.mjs';
import { activeRules, matchesRequest } from './rules.mjs';

/** 跨域模式按项目配置；旧项目保留原通配行为，manual 只使用响应自定义头 */
export const validateCors = (cors) => {
  if (cors === undefined) return;
  if (!cors || !['manual', 'allow-list'].includes(cors.mode)) throw new StudioError('INVALID_CORS', '跨域模式无效');
  if (cors.mode === 'manual') return;
  if (!Array.isArray(cors.origins) || !cors.origins.length || cors.origins.length > 50 || typeof cors.credentials !== 'boolean' || !Array.isArray(cors.headers)) throw new StudioError('INVALID_CORS', '请配置允许的页面来源、请求头与凭据开关');
  for (const origin of cors.origins) {
    let url;
    try { url = new URL(origin); } catch { throw new StudioError('INVALID_CORS', '页面来源必须为完整 HTTP 或 HTTPS 来源'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new StudioError('INVALID_CORS', '页面来源只包含协议、域名和端口，不能带路径或通配符');
  }
  if (cors.headers.some((name) => typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))) throw new StudioError('INVALID_CORS', '允许的请求头名称无效');
};

/** 预检使用只读规则范围，不进入组合选择与进度事务；显式 OPTIONS 优先 */
export const resolveCors = (registry, request, url) => {
  const explicitOptions = request.method === 'OPTIONS' && registry.projects.some((project) => activeRules(project).some((rule) => matchesRequest(rule, url, 'OPTIONS')));
  const preflight = request.method === 'OPTIONS' && Boolean(request.headers['access-control-request-method']) && !explicitOptions;
  const method = preflight ? String(request.headers['access-control-request-method']).toUpperCase() : request.method;
  const project = registry.projects.find((item) => activeRules(item).some((rule) => matchesRequest(rule, url, method)))
    ?? (preflight ? registry.projects.find((item) => activeRules(item).some((rule) => matchesRequest(rule, url, rule.method))) : null);
  const policy = project?.cors;
  if (policy?.mode !== 'allow-list') return { headers: policy?.mode === 'manual' ? {} : { 'access-control-allow-origin': '*' }, preflight: false };
  const headers = { vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' };
  const origin = request.headers.origin;
  if (origin && !policy.origins.includes(origin)) return { headers, denied: true };
  if (origin) headers['access-control-allow-origin'] = origin;
  if (policy.credentials) headers['access-control-allow-credentials'] = 'true';
  if (preflight) {
    if (!activeRules(project).some((rule) => matchesRequest(rule, url, method))) return { headers, denied: true };
    const requested = String(request.headers['access-control-request-headers'] ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    const allowed = policy.headers.map((item) => item.toLowerCase());
    if (!origin || requested.some((name) => !allowed.includes(name))) return { headers, denied: true };
    headers['access-control-allow-methods'] = method;
    headers['access-control-allow-headers'] = requested.join(', ');
  }
  return { headers, preflight };
};

/** 自动策略覆盖用户跨域头并保留其他 Vary 字段，手动策略保持用户配置 */
export const mergeCorsHeaders = (configured, cors) => {
  const headers = Object.fromEntries(Object.entries(configured).map(([name, value]) => [name.toLowerCase(), value]));
  if (cors.headers.vary) {
    const vary = [...new Set(`${headers.vary ?? ''},${cors.headers.vary}`.split(',').map((item) => item.trim()).filter(Boolean))].join(', ');
    for (const name of Object.keys(headers)) if (name.startsWith('access-control-')) delete headers[name];
    return { ...headers, ...cors.headers, vary };
  }
  return { ...cors.headers, ...headers };
};
