'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  FlaskConical,
  Gift,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { ThemeToggle } from '@/components/theme-toggle';
import { RequestAddress } from '@/components/request-address';
import { apiRequest } from '@/lib/management-api';
import {
  DEMO_ORIGIN,
  DEMO_PROJECT_ID,
  demoLessons,
  demoPackage,
  outcomeLabels,
  sendDemoRequest,
} from '@/lib/demo';
import type { DemoRequest, DemoResult } from '@/lib/demo';

type DemoProject = {
  id: string;
  enabled: boolean;
  revision?: string;
  combinations: {
    id: string;
    name: string;
    enabled: boolean;
    currentIndex: number;
    steps: unknown[];
  }[];
};
type DemoState = { projects: DemoProject[] };
const consoleUrl = `/?project=${DEMO_PROJECT_ID}`;

function TaskPreview({ result }: { result?: DemoResult }) {
  if (!result || result.status === null)
    return (
      <div className="demo-empty">
        <Gift className="size-9" />
        <p>准备好你的第一个响应</p>
        <span>点击下方按钮，观察接口返回的数据。</span>
      </div>
    );
  const body = result.json as {
    task?: { title?: unknown; reward?: unknown; claimed?: unknown };
    message?: unknown;
  } | null;
  const task = body?.task;
  if (!task || typeof task.title !== 'string')
    return (
      <div className="demo-empty">
        <CircleHelp className="size-8" />
        <p>
          {typeof body?.message === 'string'
            ? body.message
            : '响应已返回，请查看请求详情'}
        </p>
        <span>
          HTTP {result.status} · {outcomeLabels[result.outcome]}
        </span>
      </div>
    );
  return (
    <div className="demo-task">
      <div className="demo-task-icon">
        <Gift className="size-6" />
      </div>
      <div className="min-w-0 flex-1">
        <span className="text-xs text-muted-foreground">今日体验任务</span>
        <h3 className="mt-2 break-words text-lg font-semibold">{task.title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {typeof task.reward === 'number'
            ? `${task.reward} 积分奖励`
            : '奖励由响应 JSON 决定'}
        </p>
      </div>
      <span
        className={`demo-pill ${task.claimed === true ? 'status-success' : ''}`}
      >
        {task.claimed === true ? '已领取' : '未领取'}
      </span>
    </div>
  );
}

export function DemoPage() {
  const [lessonId, setLessonId] = useState('first');
  const [results, setResults] = useState<DemoResult[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [project, setProject] = useState<DemoProject | null>(null);
  const [managing, setManaging] = useState(false);
  const [feedback, setFeedback] = useState('正在读取练习配置…');
  const [resetOpen, setResetOpen] = useState(false);
  const [resetError, setResetError] = useState('');
  const [counts, setCounts] = useState({ requests: 0, confirmed: 0 });
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const refreshVersion = useRef(0);
  const lesson = demoLessons.find((item) => item.id === lessonId)!;
  const selected = results.find((item) => item.id === selectedId);
  const latest = results.find((item) => item.lessonId === lessonId);
  const combination = project?.combinations.find(
    (item) => item.id === 'demo-reward-flow',
  );

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const state = await apiRequest<DemoState>('/api/state');
    const found =
      state.projects.find((item) => item.id === DEMO_PROJECT_ID) ?? null;
    if (alive.current && version === refreshVersion.current) setProject(found);
    return found;
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh()
      .then((found) => {
        if (alive.current)
          setFeedback(
            found
              ? '已找到练习项目，可以继续上次的配置。'
              : '先创建练习项目，再到控制台启用对应规则。',
          );
      })
      .catch(() => {
        if (alive.current)
          setFeedback(
            '暂未连接管理服务。请启动 Mock Studio，也可以先下载示例包。',
          );
      });
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, [refresh]);

  const createProject = async () => {
    if (managing) return;
    setManaging(true);
    try {
      const existing = await refresh();
      if (existing) {
        setFeedback('练习项目已存在，已保留你的修改。请打开练习配置继续操作。');
        return;
      }
      const result = await apiRequest<{
        sync?: { ok: boolean; message: string };
      }>('/api/packages/apply', {
        method: 'POST',
        body: JSON.stringify({
          projectId: DEMO_PROJECT_ID,
          package: demoPackage,
        }),
      });
      await refresh();
      setFeedback(
        `练习项目已创建，项目与规则默认关闭。请到控制台启用。${result.sync?.ok === false ? ` ${result.sync.message}` : ''}`,
      );
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '创建练习项目失败');
    } finally {
      setManaging(false);
    }
  };

  const run = async (request: DemoRequest) => {
    if (controller.current) return;
    const next = new AbortController();
    controller.current = next;
    setPending(request.id);
    const timeout = window.setTimeout(
      () => next.abort(new DOMException('请求超过 12 秒', 'TimeoutError')),
      12000,
    );
    try {
      const result = await sendDemoRequest(lessonId, request, next.signal);
      if (!alive.current) return;
      setResults((previous) => [result, ...previous].slice(0, 20));
      setCounts((previous) => ({
        requests: previous.requests + 1,
        confirmed: previous.confirmed + Number(result.outcome === 'mock'),
      }));
      setSelectedId(result.id);
      // 只读刷新管理状态；不会重发业务请求或推进组合。
      void refresh().catch(() => {});
    } finally {
      window.clearTimeout(timeout);
      controller.current = null;
      if (alive.current) setPending(null);
    }
  };

  const resetCombination = async () => {
    if (!project || !combination || managing || pending) return;
    setManaging(true);
    try {
      await apiRequest(
        `/api/projects/${DEMO_PROJECT_ID}/combinations/${combination.id}/reset`,
        {
          method: 'POST',
          headers: project.revision
            ? { 'if-match': `"${project.revision}"` }
            : {},
        },
      );
      await refresh();
      setFeedback('组合已回到第一步。此项目其他页面的组合进度也已重置。');
      setResetOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : '重置失败';
      setResetError(message);
      setFeedback(message);
    } finally {
      setManaging(false);
    }
  };

  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(demoPackage, null, 2)], {
        type: 'application/json',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mock-studio-demo.json';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <main className="demo-page min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/80">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-3 px-4 py-4 sm:px-8">
          <a
            href={consoleUrl}
            className="flex items-center gap-2 rounded-lg text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            <span>返回控制台</span>
          </a>
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Zap className="size-4 text-primary" />
            Mock Studio
            <span className="hidden font-normal text-muted-foreground sm:inline">
              / 功能体验
            </span>
          </span>
          <ThemeToggle />
        </div>
      </header>
      <div className="mx-auto max-w-[1500px] px-4 pb-10 pt-8 sm:px-8">
        <section className="demo-hero">
          <div>
            <div className="mb-4 flex items-center gap-2 text-xs font-medium tracking-widest text-primary">
              <FlaskConical className="size-4" />
              互动实验室 · 5 个练习
            </div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              让每一次请求，<span className="text-primary">看得见 Mock。</span>
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
              在这里发送请求，在控制台改变响应。从第一次命中，到一个完整的领取流程。
            </p>
          </div>
          <div className="demo-hero-stats">
            <div>
              <strong>{counts.requests}</strong>
              <span>本页请求</span>
            </div>
            <div>
              <strong className="status-success">{counts.confirmed}</strong>
              <span>已确认命中</span>
            </div>
          </div>
        </section>

        <section aria-label="练习配置" className="demo-setup">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              <span
                className={`status-dot ${project?.enabled ? 'status-success' : 'status-neutral'}`}
              />
              {project
                ? project.enabled
                  ? '练习项目已开启'
                  : '练习项目已关闭'
                : '准备练习项目'}
              <span className="text-xs font-normal text-muted-foreground">
                配置快照 · 不代表请求已命中
              </span>
            </p>
            <p
              aria-live="polite"
              className="mt-2 text-xs leading-6 text-muted-foreground"
            >
              {feedback}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={managing || Boolean(pending)}
              onClick={() => void createProject()}
            >
              {managing ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <FlaskConical />
              )}
              {project ? '继续已有练习' : '创建练习项目'}
            </Button>
            <a
              className={`demo-link-button ${!project ? 'opacity-50' : ''}`}
              href={consoleUrl}
              aria-disabled={!project}
              onClick={(event) => {
                if (!project) event.preventDefault();
              }}
            >
              打开练习配置
              <ArrowRight className="size-4" />
            </a>
            <Button variant="ghost" onClick={download}>
              <Download />
              下载示例包
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新练习配置"
              disabled={managing || Boolean(pending)}
              onClick={() =>
                void refresh()
                  .then((found) =>
                    setFeedback(
                      found ? '已读取最新练习配置。' : '尚未创建练习项目。',
                    ),
                  )
                  .catch(() =>
                    setFeedback('无法连接管理服务，请确认本地服务已启动。'),
                  )
              }
            >
              <RefreshCw />
            </Button>
          </div>
        </section>

        <div className="demo-layout">
          <nav aria-label="体验练习" className="demo-lessons">
            {demoLessons.map((item, index) => (
              <button
                key={item.id}
                disabled={Boolean(pending)}
                onClick={() => setLessonId(item.id)}
                aria-current={lessonId === item.id ? 'step' : undefined}
                className={`demo-lesson ${lessonId === item.id ? 'is-active' : ''}`}
              >
                <span className="demo-lesson-number">
                  {results.some(
                    (result) =>
                      result.lessonId === item.id && result.outcome === 'mock',
                  ) ? (
                    <Check className="size-4" />
                  ) : (
                    String(index + 1).padStart(2, '0')
                  )}
                </span>
                <span>
                  {item.title}
                  <small>{item.subtitle}</small>
                </span>
                <ChevronRight className="size-4 shrink-0" />
              </button>
            ))}
          </nav>

          <div className="min-w-0 space-y-5">
            <section className="demo-panel" aria-labelledby="lesson-title">
              <span className="text-xs font-medium text-primary">
                练习 {String(demoLessons.indexOf(lesson) + 1).padStart(2, '0')}
              </span>
              <h2 id="lesson-title" className="mt-2 text-xl font-semibold">
                {lesson.title}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {lesson.subtitle}
              </p>
              <ol className="demo-instructions">
                {lesson.steps.map((step, index) => (
                  <li key={step}>
                    <span>{index + 1}</span>
                    <p>{step}</p>
                  </li>
                ))}
              </ol>
              <div className="demo-expectation">
                <Check className="mt-0.5 size-4 shrink-0" />
                <p>{lesson.expected}</p>
              </div>
            </section>

            <section className="demo-panel" aria-label="业务体验">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">任务与奖励</h2>
                <span className="demo-pill">手动请求 · 不自动重试</span>
              </div>
              {pending ? (
                <div className="demo-empty" aria-live="polite">
                  <LoaderCircle className="size-8 animate-spin text-primary" />
                  <p>正在等待响应…</p>
                  <span>最多等待 12 秒，延迟由 Mock 配置决定。</span>
                </div>
              ) : (
                <TaskPreview result={latest} />
              )}
              <div className="mt-5 flex flex-wrap gap-2">
                {lesson.requests.map((request) => (
                  <Button
                    key={request.id}
                    disabled={Boolean(pending) || managing}
                    onClick={() => void run(request)}
                  >
                    <Play className="size-3.5" />
                    {request.label}
                  </Button>
                ))}
                {pending && (
                  <Button
                    variant="outline"
                    onClick={() => controller.current?.abort()}
                  >
                    取消请求
                  </Button>
                )}
              </div>
              {lessonId === 'combination' && (
                <div className="mt-5 rounded-xl border border-border bg-muted/40 p-3 text-xs leading-6">
                  <p>
                    {combination
                      ? `配置快照：${combination.enabled ? '组合已开启' : '组合已关闭'} · 当前等待第 ${combination.currentIndex + 1} / ${combination.steps.length} 步`
                      : '创建练习项目后，在控制台启用「领取奖励流程」。'}
                  </p>
                  <p className="text-muted-foreground">
                    重新开始会重置项目共享进度；本页保留历史请求供对比。
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    disabled={!combination || managing || Boolean(pending)}
                    onClick={() => {
                      setResetError('');
                      setResetOpen(true);
                    }}
                  >
                    <RotateCcw />
                    重新开始组合
                  </Button>
                </div>
              )}
              <details className="mt-5 text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  本练习会请求哪些地址？
                </summary>
                <div className="mt-3 space-y-3">
                  {lesson.requests.map((request) => (
                    <div key={request.id}>
                      <span className="method-badge mr-2">
                        {request.method}
                      </span>
                      <RequestAddress
                        value={`${DEMO_ORIGIN}${request.path}`}
                        notify={setFeedback}
                      />
                    </div>
                  ))}
                </div>
              </details>
            </section>
          </div>

          <aside
            className="demo-panel min-w-0 self-start"
            aria-label="请求观察台"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">请求观察台</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  最近 20 条 · 仅保存在当前页面
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="清空本页请求记录"
                disabled={!results.length || Boolean(pending)}
                onClick={() => {
                  setResults([]);
                  setSelectedId(null);
                  setCounts({ requests: 0, confirmed: 0 });
                }}
              >
                <Trash2 />
              </Button>
            </div>
            {!selected ? (
              <div className="demo-inspector-empty">
                <div className="demo-request-line">
                  <span />
                  <span />
                  <span />
                </div>
                <p>发送一次请求，从这里查看结果</p>
                <span>状态码、耗时、响应 JSON 与命中证据</span>
              </div>
            ) : (
              <section className="mt-5 space-y-4" aria-label="当前请求详情">
                <div
                  className={`demo-result-banner ${selected.outcome === 'mock' ? 'status-success' : selected.outcome === 'order-mismatch' || selected.status === null ? 'status-warning' : 'status-neutral'}`}
                  aria-live="polite"
                >
                  <span className="status-dot" />
                  <div>
                    <strong className="text-sm font-medium">
                      {outcomeLabels[selected.outcome]}
                    </strong>
                    <p className="mt-1 text-xs">
                      {selected.status === null
                        ? '无可读取的 HTTP 响应'
                        : `HTTP ${selected.status}`}
                      <span className="mx-2">·</span>
                      {selected.durationMs} ms
                    </p>
                  </div>
                </div>
                {selected.status === null && (
                  <p className="text-xs leading-6 text-muted-foreground">
                    {selected.outcome === 'cancelled'
                      ? '已停止等待；请求若已到达服务端，组合进度仍可能推进。'
                      : selected.outcome === 'timeout'
                        ? '已超过 12 秒。检查响应延迟、规则开关和浏览器代理配置。'
                        : '测试地址没有原始服务。请确认项目与规则已开启、Whistle 已同步，且当前浏览器正在使用代理。网络或跨域问题也可能导致此结果。'}
                  </p>
                )}
                {selected.outcome === 'unconfirmed' && (
                  <p className="text-xs leading-6 text-muted-foreground">
                    收到响应，但未读取到完整的 Mock
                    来源与命中编号。请核对响应头和控制台记录，HTTP
                    成功不能单独证明 Mock 生效。
                  </p>
                )}
                <div className="min-w-0 text-xs">
                  <span className="method-badge mb-2">
                    {selected.request.method}
                  </span>
                  <RequestAddress
                    value={`${DEMO_ORIGIN}${selected.request.path}`}
                    notify={setFeedback}
                  />
                </div>
                <dl className="demo-evidence">
                  <dt>Mock 来源</dt>
                  <dd>{selected.headers['x-mock-source'] ?? '未读取到'}</dd>
                  <dt>命中编号</dt>
                  <dd data-testid="demo-hit-id">
                    {selected.headers['x-mock-hit-id'] ??
                      (selected.outcome === 'order-mismatch'
                        ? String(
                            (selected.json as { hitId?: string })?.hitId ??
                              '未读取到',
                          )
                        : '未读取到')}
                  </dd>
                  <dt>响应步骤</dt>
                  <dd>{selected.headers['x-mock-sequence'] ?? '—'}</dd>
                  <dt>请求时间</dt>
                  <dd>
                    {new Date(selected.timestamp).toLocaleTimeString('zh-CN')}
                  </dd>
                </dl>
                <div>
                  <h3 className="mb-2 text-xs font-medium">响应内容</h3>
                  <pre className="demo-response" data-testid="demo-response">
                    {selected.text
                      ? selected.json !== null ||
                        selected.text.trim() === 'null'
                        ? JSON.stringify(selected.json, null, 2)
                        : selected.text
                      : '暂无响应内容'}
                  </pre>
                </div>
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    请求参数与可读取的响应头
                  </summary>
                  <pre className="demo-response mt-3">
                    {JSON.stringify(
                      {
                        request: {
                          headers: selected.request.headers ?? {},
                          body: selected.request.body ?? null,
                        },
                        responseHeaders: selected.headers,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </section>
            )}
            {results.length > 0 && (
              <div className="mt-6 border-t border-border pt-4">
                <h3 className="mb-3 text-xs font-medium text-muted-foreground">
                  本页记录
                </h3>
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {results.map((result) => (
                    <button
                      key={result.id}
                      onClick={() => setSelectedId(result.id)}
                      aria-pressed={selectedId === result.id}
                      className="demo-history-row"
                    >
                      <span className="min-w-0">
                        <strong>{result.request.label}</strong>
                        <small>{outcomeLabels[result.outcome]}</small>
                      </span>
                      <span className="shrink-0 font-mono text-xs">
                        {result.status ?? '—'}
                        <small>{result.durationMs} ms</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
        <footer className="mt-6 flex flex-wrap items-start gap-2 text-xs leading-6 text-muted-foreground">
          <Clock3 className="mt-1 size-3.5 shrink-0" />
          <p>
            测试地址固定为 <code className="break-all">{DEMO_ORIGIN}</code>
            ，没有真实后端。所有业务请求由你手动触发；刷新页面会清空本页记录，保留控制台配置和组合进度。
          </p>
        </footer>
      </div>
      <Dialog
        open={resetOpen}
        onOpenChange={(open) => {
          if (!managing) setResetOpen(open);
        }}
      >
        <DialogContent>
          <DialogTitle>重新开始领取组合？</DialogTitle>
          <DialogDescription>
            将练习项目的共享进度重置到第一步，其他标签页也会受影响。不会清空本页记录，也不会修改规则内容或开关。
          </DialogDescription>
          <p role="alert" className="text-sm text-rose-300">
            {resetError}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={managing}
              onClick={() => setResetOpen(false)}
            >
              取消
            </Button>
            <Button disabled={managing} onClick={() => void resetCombination()}>
              确认重置
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
