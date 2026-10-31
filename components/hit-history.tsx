'use client';

import { describeAddress } from '@/lib/ui-model.mjs';
import { CopyValue } from '@/components/request-address';

export type HitRecord = { id: string; timestamp: string; method?: string; endpointId?: string; mockId?: string; combinationId?: string; stepId?: string; actualUrl?: string; configuredUrl?: string; variantName?: string; status: number; delayMs?: number; outcome?: string; expected?: { name: string; index: number }; sequenceIndex?: number; delivery?: 'selected' | 'finished' | 'failed' | 'aborted'; stateBefore?: string | null; stateAfter?: string | null };
const deliveryLabels = { selected: '已匹配，等待发送', finished: '服务端已发送', failed: '发送失败', aborted: '客户端断开' };

export function HitHistory({ hits, notify }: { hits: HitRecord[]; notify: (message: string) => void }) {
  return <section className="mt-5 rounded-xl border border-border bg-card p-4"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-medium">最近命中</h2><span className="text-xs text-muted-foreground">点击记录查看详情</span></div>{hits.length ? <div className="divide-y divide-border">{hits.map((hit) => {
    const url = hit.actualUrl ?? hit.configuredUrl ?? hit.endpointId ?? '';
    const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(hit.timestamp));
    return <details key={hit.id} className="hit-record py-3"><summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-2 text-xs"><span className="hit-disclosure" aria-hidden="true">›</span><time dateTime={hit.timestamp} className="font-mono text-muted-foreground">{time}</time><span className={`http-status ${hit.status >= 400 ? 'is-error' : ''}`}>HTTP {hit.status}</span><span className="min-w-0 flex-1 truncate font-medium" title={url}>{describeAddress(url).name || '未知接口'}</span><span className="text-muted-foreground">{hit.outcome === 'order-mismatch' ? `顺序不匹配：等待 ${hit.expected?.name}` : hit.variantName}</span>{hit.delivery && <span className="text-muted-foreground">{deliveryLabels[hit.delivery]}</span>}</summary>
      <dl className="hit-detail mt-3 grid gap-3 rounded-lg bg-muted/60 p-4 text-xs sm:grid-cols-[100px_minmax(0,1fr)]"><dt>实际请求</dt><dd className="flex min-w-0 items-start gap-2"><code className="min-w-0 flex-1 break-all">{hit.method ?? '—'} {url || '未记录'}</code>{url && <CopyValue value={url} label="请求地址" notify={notify} />}</dd><dt>配置匹配值</dt><dd className="break-all font-mono">{hit.configuredUrl ?? '—'}</dd><dt>响应场景</dt><dd>{hit.variantName ?? '未返回 Mock 响应'}</dd><dt>命中编号</dt><dd className="flex min-w-0 items-center gap-2"><code className="break-all">{hit.id}</code><CopyValue value={hit.id} label="命中编号" notify={notify} /></dd>{hit.combinationId && <><dt>组合 / 步骤</dt><dd className="break-all">{hit.combinationId} / {hit.stepId ?? (hit.expected ? `等待第 ${hit.expected.index + 1} 步` : '—')}</dd></>}{hit.delayMs !== undefined && <><dt>配置延迟</dt><dd>{hit.delayMs} ms</dd></>}{hit.stateBefore && <><dt>状态变化</dt><dd>{hit.stateBefore} → {hit.stateAfter}</dd></>}</dl>
    </details>;
  })}</div> : <div className="py-6 text-center text-sm text-muted-foreground">还没有命中记录。启用项目和规则后，通过配置好代理的浏览器发送请求。</div>}</section>;
}
