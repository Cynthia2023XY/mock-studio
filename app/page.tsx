'use client';

import { MockWorkspace } from '@/components/mock-workspace';
import type { SingleMock, Combination } from '@/components/mock-workspace';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Activity, Braces, CheckCircle2, ChevronRight, CircleDot, Clock3, Copy, Database, FileJson2, MoreHorizontal, Play, Plus, RotateCcw, Search, Settings2, Shuffle, TerminalSquare, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

/** 单个 Mock 响应场景的数据结构 */
type MockVariant = { id: string; name: string; status: number; delayMs: number; headers: Record<string, string>; body: unknown };
/** 接口运行统计信息 */
type EndpointStats = { hits: number; lastHitAt: string | null };
/** 可管理 Mock 接口的数据结构 */
type MockEndpoint = { id: string; name: string; method: string; url: string; matchType: string; enabled: boolean; mode: 'fixed' | 'sequence' | 'state'; activeVariantId: string; delayMs: number; sequence: { currentIndex: number; afterEnd: 'hold-last' | 'loop' }; stats: EndpointStats; variants: MockVariant[]; stateVariants?: Record<string, string> };
/** 项目分组的数据结构 */
type MockProject = { id: string; name: string; description: string; enabled: boolean; pageUrl?: string; endpoints: MockEndpoint[]; mocks?: SingleMock[]; combinations?: Combination[]; flow?: { states: string[]; initialState: string; currentState: string; transitions: { from: string; to: string; endpointId: string; variantId: string }[] } };
/** Whistle 同步状态 */
type WhistleStatus = { ok: boolean; ruleCount: number; message: string; syncedAt: string | null };
/** 完整 Mock Studio 注册表 */
type MockRegistry = { projects: MockProject[]; runtime: { whistle: WhistleStatus }; snapshots?: { id: string; projectId: string }[] };
/** 代理实际记录的一次场景命中 */
type MockHit = { combinationId?: string; outcome?: string; actualUrl?: string; expected?: { name: string; index: number }; id: string; timestamp: string; endpointId: string; variantName: string; status: number; stateBefore: string | null; stateAfter: string | null };
/** 当前打开的场景编辑目标 */
type EditorTarget = { endpointId: string; variantId: string };

/** 本地 Mock 管理 API 地址 */
const apiBase = 'http://127.0.0.1:17321';

/** 缓存本机控制台可读取的管理接口令牌 */
let tokenPromise: Promise<string> | null = null;

/** 从本地管理服务获取本机访问令牌 */
const getManagementToken = () => {
  if (!tokenPromise) tokenPromise = fetch(`${apiBase}/api/token`).then(async (response) => {
    if (!response.ok) throw new Error('无法获取本地管理令牌');
    // 本机服务返回的令牌只用于调用管理 API。
    const data = await response.json() as { token: string };
    return data.token;
  }).catch((error) => { tokenPromise = null; throw error; });
  return tokenPromise;
};

/** 带统一错误处理的管理 API 请求 */
const apiRequest = async <T,>(pathname: string, options: RequestInit = {}): Promise<T> => {
  /** 管理 API 的原始响应 */
  const response = await fetch(`${apiBase}${pathname}`, { ...options, signal: options.signal ?? AbortSignal.timeout(25000), headers: { ...options.headers, 'content-type': 'application/json', 'x-mock-token': await getManagementToken() } });
  /** 管理 API 解析后的数据 */
  const data = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
  return data;
};

/** 将时间格式化为适合状态栏展示的短文本 */
const formatTime = (value: string | null) => {
  if (!value) return '尚未命中';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
};

/** Mock Studio 可视化控制台首页 */
export default function Home() {
  /** 服务端返回的完整注册表 */
  const [registry, setRegistry] = useState<MockRegistry | null>(null);
  /** 当前选中的项目编号 */
  const [activeProjectId, setActiveProjectId] = useState('gold-bean');
  /** 接口名称与地址搜索关键词 */
  const [searchText, setSearchText] = useState('');
  /** 场景编辑抽屉的选中目标 */
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  /** 场景编辑器内的 JSON 文本 */
  const [editorBody, setEditorBody] = useState('');
  /** 场景编辑器内的响应名称 */
  const [editorName, setEditorName] = useState('');
  /** 场景编辑器内的延迟时间 */
  const [editorDelay, setEditorDelay] = useState('0');
  /** 当前正在编辑基本信息的接口编号 */
  const [endpointEditorId, setEndpointEditorId] = useState<string | null>(null);
  /** 待保存的接口展示名称 */
  const [endpointName, setEndpointName] = useState('');
  /** 待保存的接口请求方法 */
  const [endpointMethod, setEndpointMethod] = useState('POST');
  /** 待保存的接口完整请求地址 */
  const [endpointUrl, setEndpointUrl] = useState('');
  /** 接口信息编辑面板内的错误或同步提示 */
  const [endpointError, setEndpointError] = useState('');
  /** 顶部操作反馈文本 */
  const [feedback, setFeedback] = useState('正在连接本地服务…');
  /** 管理 API 当前是否可访问 */
  const [connected, setConnected] = useState(false);
  /** 当前是否正在保存配置 */
  const [saving, setSaving] = useState(false);
  /** 当前项目最近的接口命中记录 */
  const [hits, setHits] = useState<MockHit[]>([]);

  /** 从本地服务刷新注册表状态 */
  const loadRegistry = useCallback(async (silent = false) => {
    try {
      /** 最新注册表状态 */
      const nextRegistry = await apiRequest<MockRegistry>('/api/state');
      setRegistry(nextRegistry);
      setConnected(true);
      if (!silent) setFeedback('配置已与本地服务同步');
    } catch {
      setConnected(false);
      if (!silent) setFeedback('本地服务未启动，请执行 npm run dev');
    }
  }, []);

  useEffect(() => {
    void loadRegistry();
    /** 实时刷新接口命中数和顺序进度的定时器 */
    const timer = window.setInterval(() => void loadRegistry(true), 2000);
    return () => window.clearInterval(timer);
  }, [loadRegistry]);

  /** 当前选中的项目 */
  const activeProject = useMemo(() => registry?.projects.find((project) => project.id === activeProjectId) ?? registry?.projects[0] ?? null, [activeProjectId, registry]);
  // 统计包含组合接管的实际启用范围，项目关闭时显示零。
  const activeMockCount = activeProject?.enabled ? new Set([...(activeProject.mocks ?? []).filter((item) => item.enabled).map((item) => item.id), ...(activeProject.combinations ?? []).filter((item) => item.enabled).flatMap((item) => item.steps.map((step) => step.mockId))]).size + activeProject.endpoints.filter((item) => item.enabled).length : 0;
  /** 当前项目最近一次导入所保存的恢复快照 */
  const activeSnapshot = useMemo(() => registry?.snapshots?.slice().reverse().find((item) => item.projectId === activeProject?.id), [registry?.snapshots, activeProject?.id]);
  /** 经过搜索过滤后的接口列表 */
  const visibleEndpoints = useMemo(() => {
    /** 标准化后的搜索关键词 */
    const keyword = searchText.trim().toLowerCase();
    if (!keyword) return activeProject?.endpoints ?? [];
    return (activeProject?.endpoints ?? []).filter((endpoint) => `${endpoint.name} ${endpoint.url}`.toLowerCase().includes(keyword));
  }, [activeProject, searchText]);
  /** 编辑抽屉当前关联的接口 */
  const editorEndpoint = useMemo(() => activeProject?.endpoints.find((endpoint) => endpoint.id === editorTarget?.endpointId) ?? null, [activeProject, editorTarget]);
  /** 编辑抽屉当前关联的响应场景 */
  const editorVariant = useMemo(() => editorEndpoint?.variants.find((variant) => variant.id === editorTarget?.variantId) ?? null, [editorEndpoint, editorTarget]);

  useEffect(() => {
    if (!activeProject?.id) return;
    // 定期刷新当前项目命中记录，供页面与代理日志对照。
    const refresh = () => apiRequest<{ hits: MockHit[] }>(`/api/hits?projectId=${encodeURIComponent(activeProject.id)}&limit=20`).then((result) => setHits(result.hits)).catch(() => {});
    void refresh();
    // 仅在当前项目有效时刷新，切换项目会清理定时器。
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [activeProject?.id]);

  /** 创建、复制、删除或调整当前场景 */
  const manageVariant = async (action: 'add' | 'clone' | 'delete' | 'up' | 'down', body?: unknown, name?: string) => {
    if (!editorEndpoint || !editorTarget) return;
    try {
      // 场景变更统一由服务端校验并返回新的接口配置。
      let endpoint: MockEndpoint;
      if (action === 'add') endpoint = await apiRequest(`/api/endpoints/${editorEndpoint.id}/variants`, { method: 'POST', body: JSON.stringify({ name: name || '新场景', body: body ?? {} }) });
      else if (action === 'clone') endpoint = await apiRequest(`/api/endpoints/${editorEndpoint.id}/variants/${editorTarget.variantId}/clone`, { method: 'POST' });
      else if (action === 'delete') endpoint = await apiRequest(`/api/endpoints/${editorEndpoint.id}/variants/${editorTarget.variantId}`, { method: 'DELETE' });
      else {
        // 保留当前场景编号，调整它在场景序列中的相邻位置。
        const ids = editorEndpoint.variants.map((variant) => variant.id);
        // 目标资源在当前集合中的位置。
        const index = ids.indexOf(editorTarget.variantId);
        // 场景调整后的目标位置。
        const next = index + (action === 'up' ? -1 : 1);
        if (next < 0 || next >= ids.length) return;
        [ids[index], ids[next]] = [ids[next], ids[index]];
        endpoint = await apiRequest(`/api/endpoints/${editorEndpoint.id}/variants/reorder`, { method: 'POST', body: JSON.stringify({ ids }) });
      }
      await loadRegistry(true);
      // 创建或复制后打开新场景，删除后显示有效场景。
      const variant = action === 'add' || action === 'clone' ? endpoint.variants[endpoint.variants.length - 1] : endpoint.variants.find((item) => item.id === editorTarget.variantId) ?? endpoint.variants[0];
      openEditor(endpoint, variant);
      setFeedback('场景配置已更新');
    } catch (error) { setFeedback(error instanceof Error ? error.message : '场景操作失败'); }
  };

  /** 批量解析用户选择的 JSON 文件并一次性创建场景 */
  const importVariantFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    // 保留文件输入引用，用于操作结束后允许再次选择相同文件。
    const input = event.currentTarget;
    try {
      // 在发送任何变更之前先解析全部所选文件。
      const files = Array.from(input.files ?? []);
      if (!files.length || !editorTarget) return;
      // 每个文件对应一个使用文件名命名的响应场景。
      const variants = await Promise.all(files.map(async (file) => ({ name: file.name.replace(/\.json$/i, ''), body: JSON.parse(await file.text()) })));
      await apiRequest(`/api/endpoints/${editorTarget.endpointId}/variants/batch`, { method: 'POST', body: JSON.stringify({ variants }) });
      await loadRegistry(true);
      setFeedback(`已导入 ${files.length} 个场景`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '导入失败');
    } finally { input.value = ''; }
  };

  /** 导入包含内联 JSON 响应的场景包 */
  const importPackage = async (file: File) => {
    try {
      // 先验证完整场景包，再创建一个默认关闭的新项目。
      const pack = JSON.parse(await file.text());
      // 目标项目的稳定编号。
      const projectId = `project-${crypto.randomUUID()}`;
      // 客户端提交的配置内容。
      const payload = { package: pack, projectId };
      // 服务端校验后的导入预览。
      const preview = await apiRequest<{ project: MockProject }>('/api/packages/preview', { method: 'POST', body: JSON.stringify(payload) });
      if (!window.confirm(`将导入「${preview.project.name}」，包含 ${preview.project.endpoints.length} 个旧接口、${preview.project.mocks?.length ?? 0} 条 Mock，项目默认关闭。继续吗？`)) return;
      // 本次管理操作的执行结果。
      const result = await apiRequest<{ project: MockProject; snapshotId: string; sync: WhistleStatus }>('/api/packages/apply', { method: 'POST', body: JSON.stringify(payload) });
      setActiveProjectId(result.project.id);
      await loadRegistry(true);
      setFeedback(result.sync.ok ? '场景包已导入，项目默认关闭' : result.sync.message);
    } catch (error) { setFeedback(error instanceof Error ? error.message : '导入失败'); }
  };

  /** 恢复最近一次未被后续配置修改的场景包导入 */
  const restorePackage = async () => {
    if (!activeSnapshot) return;
    try {
      // 本次管理操作的执行结果。
      const result = await apiRequest<{ sync: WhistleStatus }>('/api/packages/restore', { method: 'POST', body: JSON.stringify({ snapshotId: activeSnapshot.id }) });
      await loadRegistry(true);
      setFeedback(result.sync.ok ? '已恢复导入前配置' : result.sync.message);
    } catch (error) { setFeedback(error instanceof Error ? error.message : '恢复失败'); }
  };

  /** 将当前项目导出为包含内联响应的可移植场景包 */
  const exportPackage = async () => {
    if (!activeProject) return;
    // 导出只携带可复用配置，不携带命中记录和当前运行计数。
    const pack = await apiRequest(`/api/projects/${activeProject.id}/export`);
    // 经校验的页面或资源地址。
    const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }));
    // 用于触发场景包下载的页面链接。
    const link = document.createElement('a');
    link.href = url;
    link.download = `${activeProject.id}-mock-package.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  /** 更新接口配置并刷新界面 */
  const patchEndpoint = async (endpointId: string, patch: Partial<MockEndpoint>) => {
    setSaving(true);
    try {
      // 接口配置保存与代理同步是两个独立结果。
      const result = await apiRequest<{ sync: WhistleStatus }>(`/api/endpoints/${endpointId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setFeedback(result.sync.ok ? '接口配置已保存，Whistle 规则已刷新' : result.sync.message);
      await loadRegistry(true);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '接口保存失败');
    } finally { setSaving(false); }
  };

  /** 使用接口当前信息打开基本配置面板 */
  const openEndpointEditor = (endpoint: MockEndpoint) => {
    setEndpointEditorId(endpoint.id);
    setEndpointName(endpoint.name);
    setEndpointMethod(endpoint.method);
    setEndpointUrl(endpoint.url);
    setEndpointError('');
  };

  /** 保存接口基本信息并检查代理规则是否同步成功 */
  const saveEndpoint = async () => {
    if (!endpointEditorId || saving) return;
    // 保留用户输入中的真实地址，仅去除首尾空格。
    const name = endpointName.trim();
    // 将编辑后的请求地址交给服务端统一校验。
    const url = endpointUrl.trim();
    if (!name || !url) {
      setEndpointError('请填写接口名称和完整的 HTTP 或 HTTPS 地址');
      return;
    }
    setSaving(true);
    setEndpointError('');
    try {
      // 配置保存成功与 Whistle 规则同步成功分别检查。
      const result = await apiRequest<{ sync: WhistleStatus }>(`/api/endpoints/${endpointEditorId}`, { method: 'PATCH', body: JSON.stringify({ name, method: endpointMethod, url }) });
      await loadRegistry(true);
      if (!result.sync.ok) {
        setEndpointError(`接口信息已保存，但 ${result.sync.message}`);
        setFeedback(result.sync.message);
        return;
      }
      setEndpointEditorId(null);
      setFeedback('接口信息已保存，Whistle 规则已同步');
    } catch (error) {
      setEndpointError(error instanceof Error ? error.message : '接口保存失败');
    } finally { setSaving(false); }
  };
  /** 更新项目总开关并刷新界面 */
  const patchProject = async (projectId: string, enabled: boolean) => {
    setSaving(true);
    try {
      // 代理同步失败时明确提示，避免误以为切换已生效。
      const result = await apiRequest<{ sync: WhistleStatus }>(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
      setFeedback(result.sync.ok ? (enabled ? '项目 Mock 已启用' : '项目已切换为线上透传') : result.sync.message);
      await loadRegistry(true);
    } catch (error) { setFeedback(error instanceof Error ? error.message : '项目配置失败'); } finally { setSaving(false); }
  };
  /** 重置指定接口的顺序计数与命中统计 */
  const resetEndpoint = async (endpointId: string) => {
    await apiRequest(`/api/endpoints/${endpointId}/reset`, { method: 'POST' });
    setFeedback('顺序已回到第 1 个响应');
    await loadRegistry(true);
  };
  /** 手动让指定接口前进到下一个响应 */
  const advanceEndpoint = async (endpointId: string) => {
    await apiRequest(`/api/endpoints/${endpointId}/advance`, { method: 'POST' });
    setFeedback('已手动切换到下一个响应');
    await loadRegistry(true);
  };
  /** 打开指定响应场景的 JSON 编辑抽屉 */
  const openEditor = (endpoint: MockEndpoint, variant: MockVariant) => {
    setEditorTarget({ endpointId: endpoint.id, variantId: variant.id });
    setEditorName(variant.name);
    setEditorDelay(String(variant.delayMs));
    setEditorBody(JSON.stringify(variant.body, null, 2));
  };
  /** 格式化编辑器中的 JSON 文本 */
  const formatEditorJson = () => {
    try {
      setEditorBody(JSON.stringify(JSON.parse(editorBody), null, 2));
      setFeedback('JSON 格式正确');
    } catch { setFeedback('JSON 格式错误，请检查逗号或引号'); }
  };
  /** 保存当前响应场景 */
  const saveVariant = async () => {
    if (!editorTarget) return;
    try {
      /** 编辑器解析后的响应对象 */
      const body = JSON.parse(editorBody);
      setSaving(true);
      await apiRequest(`/api/endpoints/${editorTarget.endpointId}/variants/${editorTarget.variantId}`, { method: 'PUT', body: JSON.stringify({ name: editorName, delayMs: Number(editorDelay), body }) });
      setEditorTarget(null);
      setFeedback('响应 JSON 已保存，下次请求立即生效');
      await loadRegistry(true);
    } catch (error) {
      setFeedback(error instanceof SyntaxError ? 'JSON 格式错误，暂未保存' : '保存响应失败');
    } finally { setSaving(false); }
  };
  /** 通过轻量输入快速创建项目分组 */
  const createProject = async () => {
    /** 用户输入的新项目名称 */
    const name = window.prompt('项目名称');
    if (!name?.trim()) return;
    /** 新建完成的项目 */
    const project = await apiRequest<MockProject>('/api/projects', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    setActiveProjectId(project.id);
    setFeedback(`项目「${project.name}」已创建`);
    await loadRegistry(true);
  };
  /** 克隆接口及其全部响应场景，并保持副本关闭 */
  const cloneEndpoint = async (endpointId: string) => {
    /** 克隆完成的接口 */
    const endpoint = await apiRequest<MockEndpoint>(`/api/endpoints/${endpointId}/clone`, { method: 'POST' });
    setFeedback(`已创建「${endpoint.name}」，默认保持关闭`);
    await loadRegistry(true);
  };

  /** 预览旧接口的稳定映射，确认后备份并原子迁移 */
  const migrateProject = async () => {
    if (!activeProject) return;
    try {
      // 预览不会写入注册表，界面列出语义变化及当前启用状态。
      const preview = await apiRequest<{ retainedLegacy: boolean; message?: string; fingerprint: string; warnings: string[]; project: MockProject }>(`/api/projects/${activeProject.id}/migration/preview`, { method: 'POST' });
      if (preview.retainedLegacy) { setFeedback(preview.message ?? '保留旧版状态流程'); return; }
      if (!window.confirm(`迁移预览：生成 ${preview.project.mocks?.length ?? 0} 条 Mock、${preview.project.combinations?.length ?? 0} 个组合。\n${preview.warnings.join('\n')}\n保留启用状态与当前进度，写入前备份原注册表。继续迁移？`)) return;
      // 服务端核对配置指纹，迁移时使用最新共享进度。
      const result = await apiRequest<{ backupPath: string; sync: WhistleStatus }>(`/api/projects/${activeProject.id}/migration/apply`, { method: 'POST', body: JSON.stringify({ fingerprint: preview.fingerprint }) });
      await loadRegistry(true);
      setFeedback(`已迁移，备份：${result.backupPath}；${result.sync.message}`);
    } catch (error) { setFeedback(error instanceof Error ? error.message : '迁移失败'); }
  };

  return (
    <main className="min-h-screen bg-[#080b10] text-slate-100">
      <header className="sticky top-0 z-30 border-b border-white/8 bg-[#0b0e14]/92 backdrop-blur-xl">
        <div className="flex min-h-16 items-center gap-5 px-5 lg:px-8">
          <div className="flex items-center gap-3 pr-4"><div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-cyan-400 shadow-[0_0_24px_rgba(124,92,255,.28)]"><Zap className="size-4 fill-white text-white" /></div><div><p className="text-sm font-semibold tracking-tight">Mock Studio</p><p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Local response lab</p></div></div>
          <nav className="no-scrollbar flex min-w-0 flex-1 items-end gap-1 overflow-x-auto self-stretch pt-3">
            {(registry?.projects ?? []).map((project) => <button key={project.id} onClick={() => setActiveProjectId(project.id)} className={`relative flex h-full min-w-fit items-center gap-2 rounded-t-lg px-4 text-sm transition ${activeProject?.id === project.id ? 'bg-white/6 text-white' : 'text-slate-500 hover:bg-white/3 hover:text-slate-300'}`}><span className={`size-1.5 rounded-full ${project.enabled ? 'bg-emerald-400' : 'bg-slate-700'}`} />{project.name}{activeProject?.id === project.id && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-violet-400" />}</button>)}
            <button onClick={() => void createProject()} className="grid size-9 min-w-9 place-items-center self-center rounded-lg border border-dashed border-white/12 text-slate-500 hover:border-violet-400/50 hover:text-violet-300" title="新增项目"><Plus className="size-4" /></button>
          </nav>

        </div>
      </header>

      <section className="mx-auto max-w-[1560px] px-5 py-7 lg:px-8">
        <div className="mb-7 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div><div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.15em] text-violet-300/80"><Database className="size-3.5" />Project workspace</div><h1 className="text-2xl font-semibold tracking-tight text-white">{activeProject?.name ?? 'Mock 项目'}</h1><p className="mt-1 text-sm text-slate-500">{activeProject?.description ?? '管理本地接口响应与切换状态'}</p></div>
          <div className="flex flex-wrap items-center gap-3"><details className="relative"><summary className="cursor-pointer rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300">项目菜单</summary><div className="absolute right-0 z-20 mt-2 flex w-48 flex-col gap-2 rounded-xl border border-white/10 bg-[#111620] p-3"><label className="cursor-pointer px-2 py-1 text-sm text-slate-300">导入场景包<input type="file" accept=".json,application/json" className="hidden" onChange={(event) => { if (event.target.files?.[0]) void importPackage(event.target.files[0]); event.target.value = ''; }} /></label><Button variant="ghost" onClick={() => void exportPackage().catch((error) => setFeedback(error.message))}>导出场景包</Button>{activeSnapshot && <Button variant="ghost" onClick={() => void restorePackage()}>恢复导入</Button>}{Boolean(activeProject?.endpoints.length) && <Button variant="ghost" onClick={() => void migrateProject()}>预览旧数据迁移</Button>}</div></details><div className="relative w-full sm:w-72"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-600" /><Input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索名称或 URL" className="h-10 border-white/8 bg-white/4 pl-9 text-slate-200 placeholder:text-slate-600" /></div></div>
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="metric-card"><div className="metric-icon bg-violet-400/10 text-violet-300"><Activity /></div><div><p className="metric-value">{(activeProject?.mocks?.length ?? 0) + (activeProject?.endpoints.length ?? 0)}</p><p className="metric-label">接口总数</p></div></div>
          <div className="metric-card"><div className="metric-icon bg-emerald-400/10 text-emerald-300"><CircleDot /></div><div><p className="metric-value">{activeMockCount}</p><p className="metric-label">正在拦截</p></div></div>
          <div className="metric-card"><div className="metric-icon bg-cyan-400/10 text-cyan-300"><Shuffle /></div><div><p className="metric-value">{activeProject?.combinations?.length ?? 0}</p><p className="metric-label">高级组合</p></div></div>
          <div className="metric-card"><div className={`metric-icon ${registry?.runtime.whistle.ok ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-300'}`}><TerminalSquare /></div><div><p className="metric-value text-sm!">{registry?.runtime.whistle.ok ? 'Whistle 已连接' : '等待 Whistle'}</p><p className="metric-label">{registry?.runtime.whistle.ruleCount ?? 0} 条规则已生成</p></div></div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/8 bg-[#0d1118] shadow-2xl shadow-black/20">
          <div className="flex flex-col gap-4 border-b border-white/8 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><Switch checked={activeProject?.enabled ?? false} disabled={!activeProject || saving} onCheckedChange={(checked) => activeProject && void patchProject(activeProject.id, checked)} className="data-checked:bg-violet-500" /><div><p className="text-sm font-medium">项目总开关</p><p className="text-xs text-slate-500">关闭后所有接口直接访问线上服务</p></div></div><div className="flex items-center gap-2 text-xs text-slate-500"><span className={`size-2 rounded-full ${connected ? 'animate-pulse bg-emerald-400' : 'bg-rose-400'}`} />{feedback}</div></div>
          {activeProject && <div className="p-5"><MockWorkspace key={activeProject.id} project={activeProject} search={searchText} hits={hits} request={apiRequest} refresh={() => loadRegistry(true)} notify={setFeedback} /></div>}
          {Boolean(activeProject?.endpoints.length) && <><div className="px-5 pb-3 text-sm text-slate-400">旧版接口 / 流程 · 保留原有固定、顺序及共享状态行为</div><div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] border-collapse text-left"><thead className="bg-white/[0.018] text-[11px] uppercase tracking-[0.12em] text-slate-600"><tr><th className="w-16 px-5 py-3.5">状态</th><th className="px-4 py-3.5">接口</th><th className="px-4 py-3.5">请求</th><th className="px-4 py-3.5">响应策略</th><th className="px-4 py-3.5">当前场景</th><th className="px-4 py-3.5">延迟</th><th className="px-4 py-3.5">命中</th><th className="px-5 py-3.5 text-right">操作</th></tr></thead>
              <tbody>{visibleEndpoints.map((endpoint) => {
                /** 固定模式当前选择的响应场景 */
                const activeVariant = endpoint.variants.find((variant) => variant.id === endpoint.activeVariantId) ?? endpoint.variants[0];
                /** 顺序模式当前即将返回的响应场景 */
                const sequenceVariant = endpoint.variants[Math.min(endpoint.sequence.currentIndex, endpoint.variants.length - 1)];
                /** 当前界面需要展示的响应场景 */
                const displayedVariant = endpoint.mode === 'sequence' ? sequenceVariant : endpoint.mode === 'state' ? endpoint.variants.find((item) => item.id === endpoint.stateVariants?.[activeProject?.flow?.currentState ?? '']) : activeVariant;
                return <tr key={endpoint.id} className="group border-t border-white/6 transition hover:bg-white/[0.025]">
                  <td className="px-5 py-5"><Switch checked={endpoint.enabled} disabled={saving || !activeProject?.enabled} onCheckedChange={(checked) => void patchEndpoint(endpoint.id, { enabled: checked })} className="data-checked:bg-violet-500" /></td>
                  <td className="max-w-[440px] px-4 py-5"><div className="mb-1.5 flex items-center gap-2"><span className="font-medium text-slate-200">{endpoint.name}</span>{endpoint.mode === 'sequence' && <span className="badge-sequence"><Shuffle />SEQ</span>}</div><p className="truncate font-mono text-xs text-slate-600" title={endpoint.url}>{endpoint.url}</p></td>
                  <td className="px-4 py-5"><span className="method-badge">{endpoint.method}</span><p className="mt-2 text-[11px] text-slate-600">精确匹配</p></td>
                  <td className="px-4 py-5"><div className="inline-flex rounded-lg border border-white/8 bg-black/20 p-1"><button onClick={() => void patchEndpoint(endpoint.id, { mode: 'fixed' })} className={`strategy-button ${endpoint.mode === 'fixed' ? 'strategy-button-active' : ''}`}>固定</button><button onClick={() => void patchEndpoint(endpoint.id, { mode: 'sequence' })} className={`strategy-button ${endpoint.mode === 'sequence' ? 'strategy-button-active' : ''}`}>顺序</button></div></td>
                  <td className="min-w-52 px-4 py-5"><button className="flex w-full items-center gap-3 text-left" onClick={() => displayedVariant && openEditor(endpoint, displayedVariant)}><div className="grid size-8 place-items-center rounded-lg bg-white/5 text-slate-400"><FileJson2 className="size-4" /></div><div className="min-w-0 flex-1"><p className="truncate text-sm text-slate-300">{displayedVariant?.name ?? '无场景'}</p><p className="text-[11px] text-slate-600">{endpoint.mode === 'sequence' ? `下一次 ${endpoint.sequence.currentIndex + 1} / ${endpoint.variants.length}` : endpoint.mode === 'state' ? `流程状态：${activeProject?.flow?.currentState ?? '未配置'}` : `${endpoint.variants.length} 个可选场景`}</p></div><ChevronRight className="size-4 text-slate-700" /></button></td>
                  <td className="px-4 py-5"><div className="flex items-center gap-1.5 text-sm text-slate-400"><Clock3 className="size-3.5 text-slate-600" />{displayedVariant?.delayMs ?? endpoint.delayMs}ms</div></td>
                  <td className="px-4 py-5"><p className="text-sm text-slate-400">{endpoint.stats.hits} 次</p><p className="mt-1 text-[11px] text-slate-600">{formatTime(endpoint.stats.lastHitAt)}</p></td>
                  <td className="px-5 py-5"><div className="flex justify-end gap-1">{endpoint.mode === 'sequence' && <><Button size="icon-sm" variant="ghost" title="回到第一步" onClick={() => void resetEndpoint(endpoint.id)}><RotateCcw /></Button><Button size="icon-sm" variant="ghost" title="前进一个响应" onClick={() => void advanceEndpoint(endpoint.id)}><Play /></Button></>}<Button size="icon-sm" variant="ghost" title="编辑当前响应" onClick={() => displayedVariant && openEditor(endpoint, displayedVariant)}><Braces /></Button><Button size="icon-sm" variant="ghost" title="克隆接口" onClick={() => void cloneEndpoint(endpoint.id)}><Copy /></Button><Button size="icon-sm" variant="ghost" title="编辑接口信息" aria-label={`编辑接口信息：${endpoint.name}`} onClick={() => openEndpointEditor(endpoint)}><MoreHorizontal /></Button></div></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          </>}
          {Boolean(activeProject?.endpoints.length) && visibleEndpoints.length === 0 && <div className="grid min-h-64 place-items-center text-center"><div><Search className="mx-auto mb-3 size-8 text-slate-700" /><p className="text-sm text-slate-400">没有匹配的接口</p><p className="mt-1 text-xs text-slate-600">换个关键词，或为当前项目添加接口</p></div></div>}
        </div>
        <details className="mt-4 rounded-xl border border-white/10 p-4 text-xs text-slate-500"><summary className="cursor-pointer">角标诊断与注入条件</summary><p className="mt-2 leading-6">自动注入需要文档请求包含 Sec-Fetch-Dest: document 或 iframe，且页面允许执行注入脚本。普通 HTTP 域名页面可能不携带此头；CSP、缓存或其他代理规则也可能阻止注入。此时接口仍可命中，请查看最近命中与 x-mock-source 响应头。角标仅统计成功返回 Mock 的接口，顺序不匹配单独记入日志。</p></details><div className="mt-5 rounded-xl border border-white/10 p-4"><h2 className="mb-3 text-sm font-medium text-slate-200">最近命中</h2>{hits.length ? hits.map((hit) => <p key={hit.id} className="mb-1 text-xs text-slate-400">{formatTime(hit.timestamp)} · {hit.endpointId ?? hit.actualUrl} · {hit.outcome === 'order-mismatch' ? `顺序不匹配：等待 ${hit.expected?.name}` : hit.variantName} · HTTP {hit.status}{hit.stateBefore ? ` · ${hit.stateBefore} → ${hit.stateAfter}` : ''}</p>) : <p className="text-xs text-slate-500">暂无命中记录</p>}</div><footer className="mt-4 flex flex-col gap-2 px-1 text-xs text-slate-600 sm:flex-row sm:items-center sm:justify-between"><p className="flex items-center gap-2"><CheckCircle2 className="size-3.5 text-emerald-500" />配置写入本地文件，页面与 CLI 实时共享</p><p className="font-mono">npm run mock -- list</p></footer>
      </section>

      <Sheet open={Boolean(endpointEditorId)} onOpenChange={(open) => { if (!open && !saving) setEndpointEditorId(null); }}>
        <SheetContent className="w-full border-white/10 bg-[#0c1017] p-0 sm:max-w-[600px]" showCloseButton>
          <SheetHeader className="border-b border-white/8 px-6 py-5">
            <SheetTitle className="text-lg text-white">编辑接口信息</SheetTitle>
            <SheetDescription className="text-slate-400">修改后将同步 Whistle 规则。已启用的接口会按新的地址和方法匹配。</SheetDescription>
          </SheetHeader>
          <form className="flex flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void saveEndpoint(); }}>
            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
              <label className="editor-label">接口名称<Input aria-label="接口名称" value={endpointName} onChange={(event) => setEndpointName(event.target.value)} className="editor-input" /></label>
              <label className="editor-label">请求方法<select aria-label="请求方法" value={endpointMethod} onChange={(event) => setEndpointMethod(event.target.value)} className="editor-input h-10 w-full rounded-md px-3"><option value="GET">GET</option><option value="POST">POST</option><option value="PUT">PUT</option><option value="PATCH">PATCH</option><option value="DELETE">DELETE</option></select></label>
              <label className="editor-label">接口地址<Input aria-label="接口地址" type="url" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} placeholder="http://example.com/api/query" className="editor-input" /></label>
              {endpointError && <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-200">{endpointError}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-white/8 px-6 py-4"><Button type="button" variant="ghost" disabled={saving} onClick={() => setEndpointEditorId(null)}>取消</Button><Button type="submit" disabled={saving} className="bg-violet-500 text-white hover:bg-violet-400">{saving ? '保存中…' : '保存接口信息'}</Button></div>
          </form>
        </SheetContent>
      </Sheet>

      <Sheet open={Boolean(editorTarget)} onOpenChange={(open) => !open && setEditorTarget(null)}><SheetContent className="w-full border-white/10 bg-[#0c1017] p-0 sm:max-w-[720px]" showCloseButton><SheetHeader className="border-b border-white/8 px-6 py-5"><div className="mb-2 flex items-center gap-2 text-xs text-violet-300"><Settings2 className="size-3.5" />响应场景编辑器</div><SheetTitle className="text-lg text-white">{editorEndpoint?.name}</SheetTitle><SheetDescription className="font-mono text-xs text-slate-600">{editorEndpoint?.method} {editorEndpoint?.url}</SheetDescription></SheetHeader><div className="flex-1 space-y-5 overflow-y-auto px-6 py-5"><div className="flex gap-2 overflow-x-auto">{editorEndpoint?.variants.map((variant) => <button key={variant.id} onClick={() => openEditor(editorEndpoint, variant)} className={`rounded-lg border px-3 py-2 text-xs ${editorTarget?.variantId === variant.id ? 'border-violet-400/40 bg-violet-400/10 text-violet-200' : 'border-white/8 bg-white/3 text-slate-500'}`}>{variant.name}</button>)}</div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => void manageVariant('add')}>新增场景</Button><Button size="sm" variant="outline" onClick={() => void manageVariant('clone')}>复制</Button><Button size="sm" variant="outline" onClick={() => void manageVariant('delete')}>删除</Button><Button size="sm" variant="outline" onClick={() => void manageVariant('up')}>上移</Button><Button size="sm" variant="outline" onClick={() => void manageVariant('down')}>下移</Button><label className="cursor-pointer rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-300">导入 JSON<input type="file" accept=".json,application/json" multiple className="hidden" onChange={(event) => void importVariantFiles(event)} /></label>{editorEndpoint && editorTarget && <Button size="sm" variant="outline" onClick={() => void patchEndpoint(editorEndpoint.id, { mode: 'fixed', activeVariantId: editorTarget.variantId })}>设为固定场景</Button>}{editorEndpoint && <Button size="sm" variant="outline" onClick={() => void patchEndpoint(editorEndpoint.id, { sequence: { ...editorEndpoint.sequence, afterEnd: editorEndpoint.sequence.afterEnd === 'loop' ? 'hold-last' : 'loop' } })}>结束：{editorEndpoint.sequence.afterEnd === 'loop' ? '循环' : '停留'}</Button>}</div><div className="grid gap-4 sm:grid-cols-[1fr_140px]"><label className="editor-label">场景名称<Input value={editorName} onChange={(event) => setEditorName(event.target.value)} className="editor-input" /></label><label className="editor-label">延迟（ms）<Input type="number" min="0" value={editorDelay} onChange={(event) => setEditorDelay(event.target.value)} className="editor-input" /></label></div><div><div className="mb-2 flex items-center justify-between"><span className="editor-label mb-0">响应 JSON</span><Button size="sm" variant="ghost" onClick={formatEditorJson}><Braces />格式化</Button></div><Textarea aria-label="响应 JSON" value={editorBody} onChange={(event) => setEditorBody(event.target.value)} spellCheck={false} className="min-h-[460px] resize-none border-white/8 bg-[#080b10] p-4 font-mono text-[12px] leading-6 text-cyan-100/85 focus-visible:border-violet-400/50" /></div><div className="rounded-xl border border-cyan-400/10 bg-cyan-400/5 p-4 text-xs leading-5 text-cyan-100/55">保存后无需重启服务，下一个命中该场景的请求会直接使用新 JSON。响应头会自动加入 <code className="text-cyan-300">x-mock-source: mock-studio</code>，便于在 DevTools 中确认 Mock 是否生效。</div></div><div className="flex items-center justify-between border-t border-white/8 bg-black/15 px-6 py-4"><span className="text-xs text-slate-600">状态码 {editorVariant?.status ?? 200}</span><div className="flex gap-2"><Button variant="ghost" onClick={() => setEditorTarget(null)}>取消</Button><Button disabled={saving} className="bg-violet-500 text-white hover:bg-violet-400" onClick={() => void saveVariant()}>{saving ? '保存中…' : '保存并立即生效'}</Button></div></div></SheetContent></Sheet>
    </main>
  );
}
