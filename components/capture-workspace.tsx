'use client';

import { useEffect, useId, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Download,
  FileUp,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  Circle,
  Link2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

export type RecordedEntry = {
  id: string;
  method: string;
  url: string;
  order: number;
  startedAt: string;
  durationMs: number;
  requestHeaders: Record<string, string>;
  requestBody: string;
  response: { status: number; headers: Record<string, string>; body: string };
};
export type Recording = {
  id: string;
  name: string;
  scope: string;
  status: 'recording' | 'stopped';
  enabled: boolean;
  entries: RecordedEntry[];
  selectedKeys: string[];
  positions: Record<string, number>;
  pending: number;
  skipped: number;
};
export type Resource = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  type: 'file' | 'url';
  targetUrl?: string;
  fileName?: string;
  contentType?: string;
  body?: string;
  ignoreQuery: boolean;
  hits?: number;
};
type RecordingPackage = {
  format: string;
  version: number;
  recording: Recording;
};
type Props = {
  project: {
    id: string;
    enabled: boolean;
    recordings?: Recording[];
    resources?: Resource[];
  };
  mode: 'recordings' | 'resources';
  proxyReady: boolean;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
  onGuardChange: (guard: { dirty: boolean; busy: boolean }) => void;
};
const keyFor = (entry: RecordedEntry) => {
  const url = new URL(entry.url);
  return `${entry.method} ${url.origin}${url.pathname}`;
};
const groupsFor = (recording: Recording) => {
  const groups = new Map<string, RecordedEntry[]>();
  [...recording.entries]
    .sort((a, b) => a.order - b.order)
    .forEach((entry) => {
      const key = keyFor(entry);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    });
  return [...groups];
};
const download = (name: string, value: unknown) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const decode = (value: string) => {
  try {
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
    );
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text || '（空内容）';
    }
  } catch {
    return '无法预览，回放仍保留原始字节';
  }
};

/** 只解码预览，保存与回放继续使用原始字节；限制展开后的大小。 */
const responsePreview = async (entry: RecordedEntry) => {
  const encoding = entry.response.headers['content-encoding'];
  if (!encoding) return decode(entry.response.body);
  if (!['gzip', 'deflate'].includes(encoding))
    return `响应使用 ${encoding} 压缩，回放保留原始字节。`;
  try {
    const bytes = Uint8Array.from(atob(entry.response.body), (char) =>
      char.charCodeAt(0),
    );
    const reader = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream(encoding as CompressionFormat))
      .getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        return '解压后超过 2MB，已停止预览；回放保留原始字节。';
      }
      chunks.push(value);
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(combined);
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text || '（空内容）';
    }
  } catch {
    return '无法解压预览，回放保留原始字节。';
  }
};

/** 录制接口各自排队回放；本地资源按选择时内容保存，分享后仍可用。 */
export function CaptureWorkspace({
  project,
  mode,
  proxyReady,
  request,
  refresh,
  notify,
  onGuardChange,
}: Props) {
  const fieldId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showRecord, setShowRecord] = useState(false);
  const [recordName, setRecordName] = useState('');
  const [scope, setScope] = useState('');
  const [draft, setDraft] = useState<Partial<Resource> | null>(null);
  const [original, setOriginal] = useState('');
  const [preview, setPreview] = useState<RecordedEntry | null>(null);
  const [previewBody, setPreviewBody] = useState('');
  useEffect(() => {
    let active = true;
    if (preview)
      void responsePreview(preview).then((text) => {
        if (active) setPreviewBody(text);
      });
    return () => {
      active = false;
    };
  }, [preview]);
  const [importDraft, setImportDraft] = useState<RecordingPackage | null>(null);
  const dirty = Boolean(
    (showRecord && (recordName || scope)) ||
    (draft && JSON.stringify(draft) !== original),
  );
  useEffect(() => {
    onGuardChange({ dirty, busy });
  }, [dirty, busy, onGuardChange]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const base = `/api/projects/${project.id}`;
  const mutate = async (path: string, method: string, body?: unknown) => {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      const result = await request<{ sync?: { ok: boolean; message: string } }>(
        `${base}/${path}`,
        {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      await refresh();
      notify(
        result.sync?.ok === false
          ? `已保存；${result.sync.message}`
          : '已保存，代理规则已同步',
      );
      return true;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '操作失败';
      setError(message);
      notify(message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const closeDraft = () => {
    if (busy || (dirty && !window.confirm('有未保存的修改，确定放弃吗？')))
      return;
    setDraft(null);
    setShowRecord(false);
    setError('');
  };
  const openResource = (resource?: Resource) => {
    const next = resource
      ? { ...resource }
      : { name: '', url: '', type: 'file' as const, ignoreQuery: true };
    setDraft(next);
    setOriginal(JSON.stringify(next));
    setError('');
  };
  const loadFile = async (file?: File) => {
    if (!file || !draft) return;
    if (file.size > 2 * 1024 * 1024) {
      setError('请选择 2MB 以内的文件');
      return;
    }
    const extension = file.name.split('.').pop()?.toLowerCase();
    const type =
      extension === 'js' || extension === 'mjs'
        ? 'text/javascript'
        : extension === 'css'
          ? 'text/css'
          : file.type.startsWith('image/')
            ? file.type
            : '';
    if (!type) {
      setError('请选择 JS、CSS 或图片');
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let raw = '';
      for (let index = 0; index < bytes.length; index += 16384)
        raw += String.fromCharCode(...bytes.subarray(index, index + 16384));
      setDraft({
        ...draft,
        body: btoa(raw),
        contentType: type,
        fileName: file.name,
      });
      setError('');
    } catch {
      setError('读取文件失败，请重新选择');
    } finally {
      setBusy(false);
    }
  };
  const loadPackage = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('录制包不能超过 10MB');
      const value = JSON.parse(await file.text());
      if (
        value?.format !== 'mock-studio-recording' ||
        value.version !== 1 ||
        !Array.isArray(value.recording?.entries)
      )
        throw new Error('请选择 Mock Studio 录制包（v1）');
      setImportDraft(value);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '录制包格式错误');
    }
  };
  const reorder = (
    session: Recording,
    key: string,
    entries: RecordedEntry[],
    index: number,
    offset: number,
  ) => {
    const ids = entries.map((entry) => entry.id);
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    void mutate(`recordings/${session.id}/responses`, 'PATCH', { key, ids });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {mode === 'recordings' ? '接口录制' : '资源替换'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === 'recordings'
              ? '录下真实接口响应，分享给同事；每个接口独立按顺序回放，不匹配入参。'
              : '将 JS、CSS 或图片替换为本地文件内容，或转发到另一个 URL。新建规则默认关闭。'}
          </p>
        </div>
        <div className="flex gap-2">
          {mode === 'recordings' ? (
            <>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <FileUp className="size-4" />
                导入录制包
                <input
                  type="file"
                  aria-label="导入录制包"
                  accept=".json,application/json"
                  className="hidden"
                  disabled={busy}
                  onChange={(event) => {
                    void loadPackage(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </label>
              <Button
                disabled={
                  busy ||
                  !project.enabled ||
                  project.recordings?.some(
                    (item) => item.status === 'recording',
                  )
                }
                onClick={() => {
                  setRecordName('');
                  setScope('');
                  setShowRecord(true);
                  setError('');
                }}
              >
                <Circle />
                开始录制
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => openResource()}>
              <Plus />
              添加资源替换
            </Button>
          )}
        </div>
      </div>
      {(!project.enabled || !proxyReady) && (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {!project.enabled
            ? '项目已关闭。启用项目总开关后，录制、回放和资源替换才会接管请求。'
            : '请确认 Whistle 规则同步成功，并让目标浏览器经过代理；保存成功不代表已实际命中。'}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {mode === 'recordings' && (
        <>
          {!project.recordings?.length && (
            <div className="rounded-xl border border-dashed border-border px-6 py-14 text-center text-sm text-muted-foreground">
              开始录制后操作业务页面，问题出现后停止并导出；也可以直接导入同事的录制包。
            </div>
          )}
          {(project.recordings ?? []).map((session) => (
            <article
              key={session.id}
              className="rounded-xl border border-border bg-card p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-medium">
                    {session.name}{' '}
                    <span
                      className={`ml-2 text-xs ${session.status === 'recording' ? 'text-red-500' : 'text-muted-foreground'}`}
                    >
                      {session.status === 'recording'
                        ? '● 正在录制'
                        : session.enabled
                          ? '回放已开启'
                          : '已停止'}
                    </span>
                  </h3>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    范围：{session.scope} · {session.entries.length} 条响应
                    {session.pending
                      ? ` · ${session.pending} 个请求处理中`
                      : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {session.status === 'recording' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void mutate(`recordings/${session.id}/stop`, 'POST')
                      }
                    >
                      <Square />
                      停止录制
                    </Button>
                  ) : (
                    <>
                      <label
                        htmlFor={`${fieldId}-${session.id}`}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Switch
                          id={`${fieldId}-${session.id}`}
                          aria-label={`启用回放：${session.name}`}
                          checked={session.enabled}
                          disabled={
                            busy ||
                            Boolean(session.pending) ||
                            !session.selectedKeys.length
                          }
                          onCheckedChange={(enabled) =>
                            void mutate(`recordings/${session.id}`, 'PATCH', {
                              enabled,
                            })
                          }
                        />
                        回放
                      </label>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void mutate(`recordings/${session.id}/reset`, 'POST')
                        }
                      >
                        <RotateCcw />
                        重置进度
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          busy ||
                          Boolean(session.pending) ||
                          !session.entries.length ||
                          !session.selectedKeys.length
                        }
                        onClick={() => {
                          void request(
                            `${base}/recordings/${session.id}/export`,
                          )
                            .then((value) => download(session.name, value))
                            .catch((failure) => setError(failure.message));
                        }}
                      >
                        <Download />
                        导出
                      </Button>
                      <Button
                        size="icon-sm"
                        aria-label={`删除录制：${session.name}`}
                        variant="ghost"
                        disabled={busy || Boolean(session.pending)}
                        onClick={() => {
                          if (window.confirm(`删除录制「${session.name}」？`))
                            void mutate(`recordings/${session.id}`, 'DELETE');
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {session.skipped > 0 && (
                <output className="mt-3 block text-sm text-amber-600">
                  有 {session.skipped} 条请求未保存：可能是请求中断、304
                  无响应体或达到大小上限。必要时关闭页面缓存后重新录制。
                </output>
              )}
              <div className="mt-4 space-y-2">
                {groupsFor(session).map(([key, entries]) => (
                  <details
                    key={key}
                    className="rounded-lg border border-border p-3"
                  >
                    <summary className="cursor-pointer break-all text-sm">
                      <span className="mr-2">
                        {session.selectedKeys.includes(key)
                          ? '已选择'
                          : '未选择'}
                      </span>
                      {key}
                      <span className="ml-3 text-xs text-muted-foreground">
                        {entries.length} 条响应 · 已回放{' '}
                        {Math.min(session.positions[key] ?? 0, entries.length)}/
                        {entries.length}
                        {(session.positions[key] ?? 0) >= entries.length
                          ? ' · 已到最后一条'
                          : ''}
                      </span>
                    </summary>
                    <div className="mt-3 space-y-2">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          aria-label={`回放接口：${key}`}
                          checked={session.selectedKeys.includes(key)}
                          disabled={
                            busy ||
                            session.enabled ||
                            session.status === 'recording' ||
                            Boolean(session.pending)
                          }
                          onChange={(event) =>
                            void mutate(`recordings/${session.id}`, 'PATCH', {
                              selectedKeys: event.target.checked
                                ? [...session.selectedKeys, key]
                                : session.selectedKeys.filter(
                                    (value) => value !== key,
                                  ),
                            })
                          }
                        />
                        回放 / 导出这个接口
                      </label>
                      {entries.map((entry, index) => (
                        <div
                          key={entry.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
                        >
                          <button
                            className="text-left text-sm underline-offset-4 hover:underline"
                            onClick={() => {
                              setPreviewBody('');
                              setPreview(entry);
                            }}
                          >
                            第 {index + 1} 条 · HTTP {entry.response.status} ·{' '}
                            {entry.durationMs}ms · 查看出入参
                          </button>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`上移响应 ${index + 1}`}
                              disabled={
                                busy ||
                                index === 0 ||
                                session.enabled ||
                                session.status === 'recording' ||
                                Boolean(session.pending)
                              }
                              onClick={() =>
                                reorder(session, key, entries, index, -1)
                              }
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`下移响应 ${index + 1}`}
                              disabled={
                                busy ||
                                index === entries.length - 1 ||
                                session.enabled ||
                                session.status === 'recording' ||
                                Boolean(session.pending)
                              }
                              onClick={() =>
                                reorder(session, key, entries, index, 1)
                              }
                            >
                              <ArrowDown />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`删除响应 ${index + 1}`}
                              disabled={
                                busy ||
                                entries.length === 1 ||
                                session.enabled ||
                                session.status === 'recording' ||
                                Boolean(session.pending)
                              }
                              onClick={() => {
                                if (window.confirm('删除这条录制响应？'))
                                  void mutate(
                                    `recordings/${session.id}/responses`,
                                    'PATCH',
                                    {
                                      key,
                                      ids: entries
                                        .filter((item) => item.id !== entry.id)
                                        .map((item) => item.id),
                                    },
                                  );
                              }}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                按方法 + 域名 +
                路径识别，忽略查询参数和请求体；同路径多业务需分开录制。响应取完后保持最后一条，其他接口正常回源。重启服务会停止录制。
              </p>
            </article>
          ))}
        </>
      )}
      {mode === 'resources' && (
        <div className="space-y-3">
          {!project.resources?.length && (
            <div className="rounded-xl border border-dashed border-border px-6 py-14 text-center text-sm text-muted-foreground">
              添加目标资源地址，再选择本地 JS、CSS、图片，或填写另一个 URL。
            </div>
          )}
          {(project.resources ?? []).map((resource) => (
            <article
              key={resource.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4"
            >
              <div className="min-w-0 flex-1">
                <h3 className="font-medium">{resource.name}</h3>
                <p className="mt-2 break-all text-sm">{resource.url}</p>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  <Link2 className="mr-1 inline size-3" />
                  {resource.type === 'file'
                    ? `本地文件快照：${resource.fileName}`
                    : resource.targetUrl}{' '}
                  · {resource.ignoreQuery ? '忽略查询参数' : '完整 URL 匹配'} ·{' '}
                  {resource.hits ?? 0} 次命中
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  aria-label={`启用资源：${resource.name}`}
                  checked={resource.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    void mutate(`resources/${resource.id}`, 'PATCH', {
                      enabled,
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => openResource(resource)}
                >
                  编辑
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`删除资源：${resource.name}`}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`删除「${resource.name}」？`))
                      void mutate(`resources/${resource.id}`, 'DELETE');
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Dialog
        open={showRecord}
        onOpenChange={(open) => {
          if (!open) closeDraft();
        }}
      >
        <DialogContent>
          <DialogTitle>开始接口录制</DialogTitle>
          <DialogDescription>
            指定接口 URL
            前缀，录制期间请求真实后端。开始后在业务页面操作，完成后回来停止。
          </DialogDescription>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                if (
                  await mutate('recordings', 'POST', {
                    name: recordName,
                    scope,
                  })
                ) {
                  setShowRecord(false);
                  setRecordName('');
                  setScope('');
                }
              })();
            }}
          >
            <label htmlFor={`${fieldId}-record-name`} className="editor-label">
              录制名称
              <Input
                id={`${fieldId}-record-name`}
                aria-label="录制名称"
                required
                maxLength={160}
                value={recordName}
                onChange={(event) => setRecordName(event.target.value)}
                placeholder="例如：领取后列表没有更新"
              />
            </label>
            <label htmlFor={`${fieldId}-scope`} className="editor-label">
              接口 URL 前缀
              <Input
                id={`${fieldId}-scope`}
                aria-label="接口 URL 前缀"
                required
                type="url"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                placeholder="https://api.example.com/api/"
              />
            </label>
            <p className="text-xs leading-5 text-muted-foreground">
              Cookie、Authorization 和 Set-Cookie
              不写入录制包；出入参仍可能包含个人信息，分享前请查看。单份内容最多
              2MB，每次最多 300 条、6MB。HTTPS 需配置 Whistle 证书。
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              开始记录真实请求
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(importDraft)}
        onOpenChange={(open) => {
          if (!open && !busy) setImportDraft(null);
        }}
      >
        <DialogContent>
          <DialogTitle>预览录制包</DialogTitle>
          <DialogDescription>
            导入会新增一份关闭的录制，不覆盖现有配置。
          </DialogDescription>
          {importDraft && (
            <>
              <p>{importDraft.recording.name}</p>
              <p className="break-all text-sm text-muted-foreground">
                {importDraft.recording.scope}
              </p>
              <p className="text-sm">
                包含 {importDraft.recording.entries.length}{' '}
                条响应。导入后可选择接口再启用回放。
              </p>
              <Button
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    if (
                      await mutate('recordings', 'POST', {
                        package: importDraft,
                      })
                    )
                      setImportDraft(null);
                  })();
                }}
              >
                确认导入录制包
              </Button>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Sheet
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open) closeDraft();
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-[620px]">
          <SheetHeader>
            <SheetTitle>
              {draft?.id ? '编辑资源替换' : '添加资源替换'}
            </SheetTitle>
            <SheetDescription>
              浏览器仍访问原地址，代理返回替换资源；刷新业务页面以重新加载资源。
            </SheetDescription>
          </SheetHeader>
          {draft && (
            <form
              className="space-y-4 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void (async () => {
                  if (
                    await mutate(
                      `resources${draft.id ? `/${draft.id}` : ''}`,
                      draft.id ? 'PATCH' : 'POST',
                      draft,
                    )
                  )
                    setDraft(null);
                })();
              }}
            >
              <label
                htmlFor={`${fieldId}-resource-name`}
                className="editor-label"
              >
                名称
                <Input
                  id={`${fieldId}-resource-name`}
                  aria-label="资源名称"
                  required
                  maxLength={160}
                  value={draft.name ?? ''}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </label>
              <label htmlFor={`${fieldId}-source-url`} className="editor-label">
                原资源 URL
                <Input
                  id={`${fieldId}-source-url`}
                  aria-label="原资源 URL"
                  required
                  type="url"
                  value={draft.url ?? ''}
                  onChange={(event) =>
                    setDraft({ ...draft, url: event.target.value })
                  }
                  placeholder="https://cdn.example.com/app.js"
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.ignoreQuery}
                  onChange={(event) =>
                    setDraft({ ...draft, ignoreQuery: event.target.checked })
                  }
                />
                忽略 URL 查询参数
              </label>
              <label className="editor-label">
                替换来源
                <select
                  aria-label="替换来源"
                  className="editor-input rounded-md px-3"
                  value={draft.type}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      type: event.target.value as Resource['type'],
                    })
                  }
                >
                  <option value="file">本地文件</option>
                  <option value="url">另一个 URL</option>
                </select>
              </label>
              {draft.type === 'file' ? (
                <>
                  <label
                    htmlFor={`${fieldId}-resource-file`}
                    className="editor-label"
                  >
                    选择 JS / CSS / 图片
                    <Input
                      id={`${fieldId}-resource-file`}
                      aria-label="选择本地资源文件"
                      type="file"
                      accept=".js,.mjs,.css,image/*"
                      onChange={(event) =>
                        void loadFile(event.target.files?.[0])
                      }
                    />
                  </label>
                  <p className="text-sm text-muted-foreground">
                    {draft.fileName || '尚未选择文件'}
                    。保存选择时的文件内容，原文件修改后需重新选择；最多 2MB。
                  </p>
                </>
              ) : (
                <label
                  htmlFor={`${fieldId}-target-url`}
                  className="editor-label"
                >
                  替换资源 URL
                  <Input
                    id={`${fieldId}-target-url`}
                    aria-label="替换资源 URL"
                    required
                    type="url"
                    value={draft.targetUrl ?? ''}
                    onChange={(event) =>
                      setDraft({ ...draft, targetUrl: event.target.value })
                    }
                    placeholder="http://127.0.0.1:5173/app.js"
                  />
                </label>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={closeDraft}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={busy || (draft.type === 'file' && !draft.fileName)}
                >
                  保存资源替换
                </Button>
              </div>
            </form>
          )}
        </SheetContent>
      </Sheet>
      <Sheet
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-[740px]">
          <SheetHeader>
            <SheetTitle>录制请求详情</SheetTitle>
            <SheetDescription className="break-all">
              {preview?.method} {preview?.url}
            </SheetDescription>
          </SheetHeader>
          {preview && (
            <div className="space-y-4 p-4">
              {[
                ['请求头', JSON.stringify(preview.requestHeaders, null, 2)],
                ['请求体', decode(preview.requestBody)],
                [
                  `响应头 · HTTP ${preview.response.status}`,
                  JSON.stringify(preview.response.headers, null, 2),
                ],
                ['响应内容', previewBody || '正在读取响应…'],
              ].map(([title, text]) => (
                <section key={title}>
                  <h3 className="mb-2 text-sm font-medium">{title}</h3>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
                    {text}
                  </pre>
                </section>
              ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
