'use client';

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

/** 独立 JSON Mock，不携带旧场景模式 */
export type SingleMock = { id: string; name: string; enabled: boolean; method: string; match: { type: 'exact' | 'contains'; value: string }; response: { status: number; delayMs: number; headers: Record<string, string>; body: unknown }; stats?: { hits: number; lastHitAt: string | null } };
/** 引用已有规则的严格顺序组合 */
export type Combination = { id: string; name: string; enabled: boolean; steps: { id: string; mockId: string }[]; currentIndex: number; afterEnd: 'hold-last' | 'loop'; onUnexpectedRequest: 'error' };
/** 单条编辑器的文本草稿 */
type MockDraft = { id?: string; name: string; method: string; type: 'exact' | 'contains'; value: string; status: string; delay: string; headers: string; body: string };
/** 高级组合的可编辑配置草稿 */
type CombinationDraft = Pick<Combination, 'name' | 'steps' | 'afterEnd'> & { id?: string };
/** 管理操作返回的独立代理同步结果 */
type SyncResult = { sync?: { ok: boolean; message: string } };
/** 组合运行详情所需的最近命中字段 */
type RecentHit = { id: string; timestamp: string; combinationId?: string; outcome?: string; actualUrl?: string; expected?: { name: string; index: number }; variantName?: string };
/** 工作区依赖的项目配置与服务调用 */
type WorkspaceProps = { project: { id: string; enabled: boolean; mocks?: SingleMock[]; combinations?: Combination[] }; search: string; hits: RecentHit[]; request: <T>(path: string, options?: RequestInit) => Promise<T>; refresh: () => Promise<void>; notify: (message: string) => void };

/** 单条规则与高级组合的列表、编辑及运行面板 */
export function MockWorkspace({ project, search, hits, request, refresh, notify }: WorkspaceProps) {
  // 当前独立 Mock 编辑草稿，轮询不覆盖未保存内容。
  const [draft, setDraft] = useState<MockDraft | null>(null);
  // 组合草稿独立于服务器实时进度。
  const [combinationDraft, setCombinationDraft] = useState<CombinationDraft | null>(null);
  // 用于识别关闭侧栏时是否有未保存修改。
  const [original, setOriginal] = useState('');
  // 所有管理变更串行执行，避免重复提交。
  const [busy, setBusy] = useState(false);
  // 编辑器错误就地显示，保存失败保留用户草稿。
  const [error, setError] = useState('');
  // 鼠标拖拽中的规则编号。
  const [dragId, setDragId] = useState<string | null>(null);
  // 当前侧栏是否有未保存输入。
  const dirty = Boolean((draft || combinationDraft) && JSON.stringify(draft || combinationDraft) !== original);
  // 当前项目的服务端规则顺序。
  const mocks = project.mocks ?? [];
  // 当前项目独立的组合列表。
  const combinations = project.combinations ?? [];
  // 启用组合使用独立规则原有开关之外的接管标识。
  const controlled = new Set(combinations.filter((item) => item.enabled && project.enabled).flatMap((item) => item.steps.map((step) => step.mockId)));
  // 项目范围资源地址。
  const base = `/api/projects/${project.id}`;
  // 正在编辑规则的引用影响范围，包括停用组合。
  const references = combinations.filter((item) => item.steps.some((step) => step.mockId === draft?.id));

  useEffect(() => {
    // 离开页面或刷新时保护未保存 JSON。
    const preventUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [dirty]);

  // 侧栏关闭统一检查未保存输入。
  const closeEditor = () => {
    if (busy || (dirty && !window.confirm('有未保存的修改，确定放弃吗？'))) return;
    setDraft(null); setCombinationDraft(null); setError('');
  };
  // 管理变更同时显示持久化与代理同步结果。
  const mutate = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError('');
    try {
      // API 校验失败不会关闭编辑器。
      const result = await request<SyncResult>(`${base}/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      await refresh();
      notify(result.sync?.ok === false ? `配置已保存；${result.sync.message}` : '配置已保存，代理规则已同步');
      return true;
    } catch (failure) {
      // 服务端错误包含可读的冲突和引用说明。
      const message = failure instanceof Error ? failure.message : '操作失败';
      setError(message); notify(message); return false;
    } finally { setBusy(false); }
  };
  // 新建和编辑使用同一套表单。
  const openMock = (mock?: SingleMock) => {
    // 响应体与响应头保留为可校验的 JSON 文本。
    const next: MockDraft = mock ? { id: mock.id, name: mock.name, method: mock.method, type: mock.match.type, value: mock.match.value, status: String(mock.response.status), delay: String(mock.response.delayMs), headers: JSON.stringify(mock.response.headers, null, 2), body: JSON.stringify(mock.response.body, null, 2) } : { name: '', method: 'POST', type: 'contains', value: '', status: '200', delay: '0', headers: '{}', body: '{\n  "success": true\n}' };
    setOriginal(JSON.stringify(next)); setDraft(next); setError('');
  };
  // 保存前校验 JSON 和数值，配置由服务端再次整体检查。
  const saveMock = async () => {
    if (!draft || busy) return;
    try {
      // 输入转换失败保留草稿与侧栏。
      const response = { status: Number(draft.status), delayMs: Number(draft.delay), headers: JSON.parse(draft.headers), body: JSON.parse(draft.body) };
      if (!draft.name.trim() || !draft.value.trim() || !draft.status.trim() || !draft.delay.trim() || !Number.isInteger(response.status) || !Number.isFinite(response.delayMs)) throw new Error('请填写名称、匹配值和有效状态码、延迟');
      if (await mutate(`mocks${draft.id ? `/${draft.id}` : ''}`, draft.id ? 'PATCH' : 'POST', { name: draft.name, method: draft.method, match: { type: draft.type, value: draft.value }, response })) setDraft(null);
    } catch (failure) { setError(failure instanceof SyntaxError ? '响应 JSON 或响应头 JSON 格式错误' : (failure as Error).message); }
  };
  // 使用独立步骤编号，支持同一 Mock 被多次选中。
  const openCombination = (combination?: Combination) => {
    // 不把实时进度复制到可编辑草稿，保存步骤时明确重新开始。
    const next: CombinationDraft = combination ? { id: combination.id, name: combination.name, afterEnd: combination.afterEnd, steps: structuredClone(combination.steps) } : { name: '', afterEnd: 'hold-last', steps: mocks[0] ? [{ id: `step-${crypto.randomUUID()}`, mockId: mocks[0].id }] : [] };
    setOriginal(JSON.stringify(next)); setCombinationDraft(next); setError('');
  };
  // 通过服务端排序保持规则优先级与可见顺序一致。
  const moveMock = async (id: string, targetId: string) => {
    // 拖动与键盘操作使用完整列表，搜索不会丢失隐藏规则。
    const ids = mocks.map((item) => item.id);
    ids.splice(ids.indexOf(id), 1); ids.splice(ids.indexOf(targetId), 0, id);
    await mutate('mocks/reorder', 'POST', { ids });
  };
  // 调整组合中的相邻步骤，独立规则顺序保持原样。
  const moveStep = (index: number, offset: number) => {
    if (!combinationDraft) return;
    // 复制数组后只交换步骤引用。
    const steps = [...combinationDraft.steps];
    [steps[index], steps[index + offset]] = [steps[index + offset], steps[index]];
    setCombinationDraft({ ...combinationDraft, steps });
  };
  // 文件只导入响应 JSON，不默默覆盖匹配信息。
  const importBody = async (file?: File) => {
    if (!file || !draft) return;
    try { setDraft({ ...draft, body: JSON.stringify(JSON.parse(await file.text()), null, 2) }); setError(''); } catch { setError('文件不是有效的 JSON'); }
  };

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Mock 规则</h2><p className="mt-1 text-xs text-slate-500">同项目按列表顺序匹配；高级组合优先。新建规则默认关闭。</p></div><div className="flex gap-2"><Button variant="outline" disabled={busy || !mocks.length} onClick={() => openCombination()}><Plus />新建高级组合 Mock</Button><Button disabled={busy} onClick={() => openMock()}><Plus />添加 Mock</Button></div></div>
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-[#0d1118]"><table className="w-full min-w-[1050px] text-left text-sm"><thead className="text-xs text-slate-500"><tr>{['拖拽', '开关', '方法', '名称', '地址', '匹配方式', '延迟', '操作'].map((label) => <th className="px-3 py-3" key={label}>{label}</th>)}</tr></thead><tbody>{mocks.filter((mock) => `${mock.name} ${mock.match.value}`.toLowerCase().includes(search.toLowerCase())).map((mock) => <tr key={mock.id} className="border-t border-white/8" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (dragId && dragId !== mock.id) void moveMock(dragId, mock.id); setDragId(null); }}>
      <td className="px-3 py-4"><button draggable={!busy} aria-label={`拖动排序：${mock.name}`} onDragStart={(event) => { event.dataTransfer.setData('text/plain', mock.id); setDragId(mock.id); }} onDragEnd={() => setDragId(null)} className="cursor-grab text-slate-600"><GripVertical className="size-4" /></button></td>
      <td className="px-3"><Switch aria-label={`启用 Mock：${mock.name}`} checked={mock.enabled} disabled={busy} onCheckedChange={(enabled) => void mutate(`mocks/${mock.id}`, 'PATCH', { enabled })} /></td><td className="px-3"><span className="method-badge">{mock.method}</span></td>
      <td className="px-3"><p>{mock.name}</p>{controlled.has(mock.id) && <span className="text-xs text-violet-300">由组合接管</span>}<p className="mt-1 text-xs text-slate-600">{mock.stats?.hits ?? 0} 次命中</p></td><td className="max-w-80 truncate px-3 font-mono text-xs text-slate-400" title={mock.match.value}>{mock.match.value}</td><td className="px-3 text-xs text-slate-400">{mock.match.type === 'exact' ? '精确匹配' : '模糊匹配'}</td><td className="px-3 text-xs text-slate-400">{mock.response.delayMs}ms</td>
      <td className="px-3"><div className="flex gap-1"><Button size="sm" variant="ghost" disabled={busy} onClick={() => openMock(mock)}>编辑</Button><Button size="icon-sm" variant="ghost" aria-label={`克隆 Mock：${mock.name}`} disabled={busy} onClick={() => void mutate(`mocks/${mock.id}/clone`, 'POST')}><Copy /></Button><Button size="icon-sm" variant="ghost" aria-label={`删除 Mock：${mock.name}`} disabled={busy} onClick={() => { if (window.confirm(`删除「${mock.name}」？`)) void mutate(`mocks/${mock.id}`, 'DELETE'); }}><Trash2 /></Button><Button size="icon-sm" variant="ghost" aria-label={`上移 Mock：${mock.name}`} disabled={busy || mocks.indexOf(mock) === 0} onClick={() => void moveMock(mock.id, mocks[mocks.indexOf(mock) - 1].id)}><ArrowUp /></Button><Button size="icon-sm" variant="ghost" aria-label={`下移 Mock：${mock.name}`} disabled={busy || mocks.indexOf(mock) === mocks.length - 1} onClick={() => void moveMock(mock.id, mocks[mocks.indexOf(mock) + 1].id)}><ArrowDown /></Button></div></td>
    </tr>)}</tbody></table>{!mocks.length && <p className="px-5 py-12 text-center text-sm text-slate-500">添加第一条 Mock，准备响应后再启用。</p>}</div>
    <div><h2 className="mb-3 text-sm font-semibold">高级组合 <span className="font-normal text-slate-500">· 项目全局共享进度，多个页面共同推进</span></h2><div className="grid gap-3 lg:grid-cols-2">{combinations.map((combination) => {
      // 使用最新服务端进度展示等待接口和最近命中。
      const waiting = mocks.find((item) => item.id === combination.steps[combination.currentIndex]?.mockId);
      // 顺序错误与成功命中分开展示。
      const recent = hits.filter((hit) => hit.combinationId === combination.id).slice(0, 4);
      return <article key={combination.id} className="rounded-xl border border-white/10 bg-[#0d1118] p-4"><div className="flex items-center justify-between"><button onClick={() => openCombination(combination)} className="font-medium">{combination.name}</button><Switch aria-label={`启用组合：${combination.name}`} checked={combination.enabled} disabled={busy} onCheckedChange={(enabled) => void mutate(`combinations/${combination.id}`, 'PATCH', { enabled })} /></div><p className="mt-3 text-sm text-violet-300">当前步骤 {combination.currentIndex + 1} / {combination.steps.length} · 等待 {waiting?.name}</p><p className="mt-1 break-all font-mono text-xs text-slate-500">{waiting?.method} {waiting?.match.value}</p><p className="mt-2 text-xs text-slate-500">结束后{combination.afterEnd === 'loop' ? '循环' : '停留最后一步'}{!project.enabled && ' · 项目总开关已关闭'}</p><div className="my-3 flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate(`combinations/${combination.id}/reset`, 'POST')}>重新开始</Button><Button size="sm" variant="ghost" onClick={() => openCombination(combination)}>编辑步骤</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm(`删除组合「${combination.name}」？`)) void mutate(`combinations/${combination.id}`, 'DELETE'); }}>删除组合</Button></div>{recent.length ? recent.map((hit) => <p key={hit.id} className={`mt-1 truncate text-xs ${hit.outcome === 'order-mismatch' ? 'text-amber-300' : 'text-slate-500'}`}>{new Date(hit.timestamp).toLocaleTimeString('zh-CN')} · {hit.outcome === 'order-mismatch' ? `顺序不匹配，等待 ${hit.expected?.name}` : `返回 ${hit.variantName}`} · {hit.actualUrl}</p>) : <p className="text-xs text-slate-600">尚无运行记录</p>}</article>;
    })}</div></div>

    <Sheet open={Boolean(draft)} onOpenChange={(open) => { if (!open) closeEditor(); }}><SheetContent className="w-full overflow-y-auto border-white/10 bg-[#0c1017] sm:max-w-[700px]"><SheetHeader><SheetTitle>{draft?.id ? '编辑 Mock' : '添加 Mock'}</SheetTitle><SheetDescription>精确：完整 URL 与方法相同，包含查询参数。模糊：完整 URL 包含输入文本，方法相同。域名与协议小写、移除默认端口和片段；路径大小写、百分号编码及参数顺序保留。</SheetDescription></SheetHeader>{draft && <form className="space-y-4 p-4" onSubmit={(event) => { event.preventDefault(); void saveMock(); }}>
      <label className="editor-label">名称<Input aria-label="Mock 名称" required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <div className="grid grid-cols-2 gap-4"><label className="editor-label">方法<select aria-label="Mock 方法" value={draft.method} onChange={(event) => setDraft({ ...draft, method: event.target.value })} className="editor-input w-full rounded-md px-3">{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => <option key={method}>{method}</option>)}</select></label><label className="editor-label">匹配方式<select aria-label="匹配方式" value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as MockDraft['type'] })} className="editor-input w-full rounded-md px-3"><option value="exact">精确匹配</option><option value="contains">模糊匹配</option></select></label></div>
      <label className="editor-label">地址 / 匹配文本<Input aria-label="匹配文本" required maxLength={2048} value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} placeholder={draft.type === 'exact' ? 'https://example.test/api/query?a=1' : 'queryBullMarketFundExpHome'} /></label>
      <div className="grid grid-cols-2 gap-4"><label className="editor-label">状态码<Input aria-label="状态码" required type="number" min={200} max={599} value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })} /></label><label className="editor-label">延迟（ms）<Input aria-label="延迟" required type="number" min={0} max={120000} value={draft.delay} onChange={(event) => setDraft({ ...draft, delay: event.target.value })} /></label></div>
      <details><summary className="cursor-pointer text-xs text-slate-400">响应头 JSON</summary><Textarea aria-label="响应头 JSON" value={draft.headers} onChange={(event) => setDraft({ ...draft, headers: event.target.value })} className="mt-2 font-mono" /></details>
      <div className="flex items-center justify-between text-xs text-slate-400"><span>响应 JSON</span><div className="flex gap-3"><label className="cursor-pointer">导入 JSON<input type="file" accept=".json,application/json" className="hidden" onChange={(event) => { void importBody(event.target.files?.[0]); event.target.value = ''; }} /></label><button type="button" onClick={() => { try { setDraft({ ...draft, body: JSON.stringify(JSON.parse(draft.body), null, 2) }); setError(''); } catch { setError('响应 JSON 格式错误'); } }}>格式化</button></div></div><Textarea aria-label="Mock 响应 JSON" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} spellCheck={false} className="min-h-64 font-mono text-xs leading-6" />
      {references.length > 0 && <p className="text-xs text-amber-300">保存将影响引用此规则的组合：{references.map((item) => item.name).join('、')}。组合下一次请求使用修改后的响应。</p>}{error && <p role="alert" className="text-sm text-rose-300">{error}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={closeEditor}>取消</Button><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存 Mock'}</Button></div>
    </form>}</SheetContent></Sheet>
    <Sheet open={Boolean(combinationDraft)} onOpenChange={(open) => { if (!open) closeEditor(); }}><SheetContent className="w-full overflow-y-auto border-white/10 bg-[#0c1017] sm:max-w-[680px]"><SheetHeader><SheetTitle>{combinationDraft?.id ? '编辑高级组合' : '新建高级组合 Mock'}</SheetTitle><SheetDescription>步骤引用独立 Mock，允许重复引用。保存步骤或启用组合时从第一步开始；多个页面共享进度。顺序不匹配返回 409，不推进。</SheetDescription></SheetHeader>{combinationDraft && <form className="space-y-5 p-4" onSubmit={(event) => { event.preventDefault(); void (async () => { if (await mutate(`combinations${combinationDraft.id ? `/${combinationDraft.id}` : ''}`, combinationDraft.id ? 'PATCH' : 'POST', combinationDraft)) setCombinationDraft(null); })(); }}>
      <label className="editor-label">组合名称<Input aria-label="组合名称" required value={combinationDraft.name} onChange={(event) => setCombinationDraft({ ...combinationDraft, name: event.target.value })} /></label>
      <div className="space-y-3">{combinationDraft.steps.map((step, index) => <div key={step.id} className="flex items-center gap-2"><span className="w-5 text-sm text-violet-300">{index + 1}</span><select aria-label={`第 ${index + 1} 步 Mock`} value={step.mockId} className="editor-input min-w-0 flex-1 rounded-md px-2" onChange={(event) => setCombinationDraft({ ...combinationDraft, steps: combinationDraft.steps.map((item) => item.id === step.id ? { ...item, mockId: event.target.value } : item) })}>{mocks.map((mock) => <option key={mock.id} value={mock.id}>{mock.name} · {mock.method} {mock.match.value}</option>)}</select><Button type="button" size="icon-sm" variant="ghost" aria-label={`上移步骤 ${index + 1}`} disabled={!index} onClick={() => moveStep(index, -1)}><ArrowUp /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`下移步骤 ${index + 1}`} disabled={index === combinationDraft.steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`移除步骤 ${index + 1}`} onClick={() => setCombinationDraft({ ...combinationDraft, steps: combinationDraft.steps.filter((item) => item.id !== step.id) })}><Trash2 /></Button></div>)}</div>
      <Button type="button" variant="outline" disabled={!mocks.length} onClick={() => setCombinationDraft({ ...combinationDraft, steps: [...combinationDraft.steps, { id: `step-${crypto.randomUUID()}`, mockId: mocks[0].id }] })}>添加步骤</Button><label className="editor-label">结束策略<select aria-label="结束策略" className="editor-input w-full rounded-md px-3" value={combinationDraft.afterEnd} onChange={(event) => setCombinationDraft({ ...combinationDraft, afterEnd: event.target.value as Combination['afterEnd'] })}><option value="hold-last">停留最后一步</option><option value="loop">循环</option></select></label>{error && <p role="alert" className="text-sm text-rose-300">{error}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={closeEditor}>取消</Button><Button type="submit" disabled={busy || !combinationDraft.steps.length}>保存组合</Button></div>
    </form>}</SheetContent></Sheet>
  </div>;
}
