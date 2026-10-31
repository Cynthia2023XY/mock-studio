import examplePackage from '@/distribution/examples/demo-package.json';

export const DEMO_PROJECT_ID = 'mock-studio-demo';
export const DEMO_ORIGIN = 'http://demo.mock-studio.test';
export const demoPackage = examplePackage;

export type DemoRequest = {
  id: string;
  label: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};
export type DemoLesson = {
  id: string;
  title: string;
  subtitle: string;
  steps: string[];
  expected: string;
  requests: DemoRequest[];
};
export const demoLessons: DemoLesson[] = [
  {
    id: 'first',
    title: '第一次 Mock',
    subtitle: '让一个不存在的接口返回你的数据',
    steps: [
      '点击「创建练习项目」，再打开控制台中的练习配置。',
      '启用项目总开关和「任务查询」，等待规则同步。',
      '返回这里查询任务；修改规则中的 task.title 后再试一次。',
      '关闭规则再查询，对比结果。请求失败时检查代理与开关。',
    ],
    expected: '显示任务卡片，并在请求详情中看到 Mock 来源和命中编号。',
    requests: [
      { id: 'tasks', label: '查询任务', method: 'GET', path: '/api/tasks' },
    ],
  },
  {
    id: 'delay',
    title: '延迟与失败',
    subtitle: '体验加载中和错误响应',
    steps: [
      '启用「慢速查询」与「失败响应」两条规则。',
      '点击慢速查询，观察 1.5 秒加载状态与实际耗时。',
      '请求失败响应，确认 HTTP 500 仍然可以是一次 Mock 命中。',
    ],
    expected:
      '慢速请求显示加载状态；错误请求同时显示 HTTP 500 和 Mock 命中证据。',
    requests: [
      { id: 'slow', label: '慢速查询', method: 'GET', path: '/api/tasks/slow' },
      {
        id: 'error',
        label: '请求失败响应',
        method: 'GET',
        path: '/api/tasks/error',
      },
    ],
  },
  {
    id: 'matching',
    title: '匹配练习',
    subtitle: '完整地址、参数与方法都影响匹配',
    steps: [
      '仅启用「精确匹配 · 参数顺序」规则，对比两个参数顺序。',
      '关闭精确规则，启用「模糊匹配 · 任务搜索」，再次对比。',
      '切换为 POST 验证方法限制：上述两条规则都是 GET。不要同时启用两条练习规则。',
    ],
    expected:
      '精确匹配只命中完整地址；模糊匹配允许参数变化，但仍要求方法相同。',
    requests: [
      {
        id: 'exact',
        label: '原始参数',
        method: 'GET',
        path: '/api/tasks/search?status=todo&page=1',
      },
      {
        id: 'reordered',
        label: '调换参数顺序',
        method: 'GET',
        path: '/api/tasks/search?page=1&status=todo',
      },
      {
        id: 'post',
        label: '改为 POST',
        method: 'POST',
        path: '/api/tasks/search?status=todo&page=1',
      },
    ],
  },
  {
    id: 'combination',
    title: '领取组合',
    subtitle: '查询 → 领取 → 再查询',
    steps: [
      '在控制台启用「领取奖励流程」组合，引用的三条规则可以保持关闭。',
      '依次点击查询状态、领取奖励、再点击查询状态。',
      '重新开始后直接领取，观察 409 顺序错误。',
      '组合进度在项目内共享；其他标签页的请求也会推进。清空本页记录不会重置组合。',
    ],
    expected:
      '查询返回未领取 → 领取成功 → 查询返回已领取；乱序时返回 409，进度不推进。',
    requests: [
      {
        id: 'status',
        label: '查询领取状态',
        method: 'GET',
        path: '/api/rewards/status',
      },
      {
        id: 'claim',
        label: '领取奖励',
        method: 'POST',
        path: '/api/rewards/claim',
        body: { taskId: 'demo-task' },
      },
    ],
  },
  {
    id: 'cors',
    title: '跨域请求',
    subtitle: 'JSON POST 与自定义请求头',
    steps: [
      '启用「跨域提交」规则。示例包已允许本机控制台来源和练习请求头。',
      '点击提交，浏览器会按需发起 OPTIONS 预检。预检不增加业务命中次数。',
      '可在控制台的跨域设置中移除允许的来源或请求头后重试，再恢复配置。',
    ],
    expected:
      '浏览器能读取 JSON 响应和 Mock 标识；配置拒绝时显示网络或跨域失败，不猜测具体原因。',
    requests: [
      {
        id: 'cors',
        label: '提交 JSON 与自定义头',
        method: 'POST',
        path: '/api/submit',
        body: { taskId: 'demo-task' },
        headers: { 'x-demo-client': 'mock-studio-demo' },
      },
    ],
  },
];

export type DemoResult = {
  id: string;
  lessonId: string;
  request: DemoRequest;
  timestamp: string;
  durationMs: number;
  status: number | null;
  text: string;
  json: unknown;
  headers: Record<string, string>;
  outcome:
    | 'mock'
    | 'unconfirmed'
    | 'order-mismatch'
    | 'network-error'
    | 'timeout'
    | 'cancelled';
};

/** 普通 fetch 访问固定测试域名，不直连运行分发器，也不发送管理凭据。 */
export async function sendDemoRequest(
  lessonId: string,
  request: DemoRequest,
  signal: AbortSignal,
): Promise<DemoResult> {
  const start = performance.now();
  const result: DemoResult = {
    id: crypto.randomUUID(),
    lessonId,
    request,
    timestamp: new Date().toISOString(),
    durationMs: 0,
    status: null,
    text: '',
    json: null,
    headers: {},
    outcome: 'network-error',
  };
  try {
    const headers = new Headers(request.headers);
    if (request.body !== undefined)
      headers.set('content-type', 'application/json');
    const response = await fetch(`${DEMO_ORIGIN}${request.path}`, {
      method: request.method,
      headers,
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
    result.status = response.status;
    result.headers = Object.fromEntries(response.headers.entries());
    result.text = await response.text();
    try {
      result.json = JSON.parse(result.text);
    } catch {
      /* 非 JSON 也保留原文供核对 */
    }
    const diagnostic = result.json as { code?: string } | null;
    result.outcome =
      response.headers.get('x-mock-source') === 'mock-studio' &&
      Boolean(response.headers.get('x-mock-hit-id'))
        ? 'mock'
        : response.status === 409 &&
            diagnostic?.code === 'COMBINATION_ORDER_MISMATCH'
          ? 'order-mismatch'
          : 'unconfirmed';
  } catch {
    result.outcome = signal.aborted
      ? signal.reason?.name === 'TimeoutError'
        ? 'timeout'
        : 'cancelled'
      : 'network-error';
  } finally {
    result.durationMs = Math.round(performance.now() - start);
  }
  return result;
}

export const outcomeLabels: Record<DemoResult['outcome'], string> = {
  mock: '已确认 Mock 命中',
  unconfirmed: '已收到响应，来源未确认',
  'order-mismatch': '组合顺序不匹配',
  'network-error': '未获取到响应',
  timeout: '请求超时',
  cancelled: '请求已取消',
};
