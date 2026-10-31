'use client';

import { useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Braces, CheckCircle2, Expand, LocateFixed, Minimize2 } from 'lucide-react';
import { inspectJson, jsonTokens } from '@/lib/ui-model.mjs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

type Props = { label: string; ariaLabel?: string; value: string; onChange: (value: string) => void; disabled?: boolean; actions?: ReactNode };

/** 透明输入层与着色层共用字体、行高和滚动坐标，输入值保持原始 JSON 文本。 */
function EditorSurface({ value, onChange, disabled, ariaLabel, full = false }: Pick<Props, 'value' | 'onChange' | 'disabled' | 'ariaLabel'> & { full?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const id = useId();
  const check = useMemo(() => inspectJson(value), [value]);
  const tokens = useMemo(() => jsonTokens(value), [value]);
  const lines = value.split('\n').length;
  const locate = () => {
    const element = input.current;
    if (!element) return;
    element.focus(); element.setSelectionRange(check.offset, Math.min(value.length, check.offset + 1));
    element.scrollTop = Math.max(0, (check.line - 4) * 24);
    element.scrollLeft = Math.max(0, (check.column - 20) * 8);
    if (highlight.current) { highlight.current.scrollTop = element.scrollTop; highlight.current.scrollLeft = element.scrollLeft; }
    if (gutter.current) gutter.current.scrollTop = element.scrollTop;
  };
  return <div className={`json-surface ${full ? 'json-surface-full' : ''}`}>
    <div className="json-code-area">
      <div className="json-gutter" ref={gutter} aria-hidden="true">{Array.from({ length: lines }, (_, index) => <div key={index} className={!check.valid && index + 1 === check.line ? 'json-error-line' : ''}>{index + 1}</div>)}</div>
      <div className="json-code-stack">
        <pre className="json-highlight" ref={highlight} aria-hidden="true">{tokens.map((token, index) => <span key={index} className={`json-token-${token.kind}`}>{token.text}</span>)}{'\n'}</pre>
        <textarea ref={input} aria-label={ariaLabel} aria-invalid={!check.valid} aria-describedby={id} disabled={disabled} value={value} wrap="off" spellCheck={false} autoCapitalize="off" autoComplete="off" className="json-input" onChange={(event) => onChange(event.target.value)} onScroll={(event) => {
          const { scrollTop, scrollLeft } = event.currentTarget;
          if (highlight.current) { highlight.current.scrollTop = scrollTop; highlight.current.scrollLeft = scrollLeft; }
          if (gutter.current) gutter.current.scrollTop = scrollTop;
        }} onKeyDown={(event) => {
          // Tab 插入两个空格；Shift+Tab 保留浏览器的反向焦点导航。
          if (event.key !== 'Tab' || event.shiftKey || disabled) return;
          event.preventDefault();
          const element = event.currentTarget;
          const start = element.selectionStart;
          onChange(`${value.slice(0, start)}  ${value.slice(element.selectionEnd)}`);
          requestAnimationFrame(() => { element.selectionStart = start + 2; element.selectionEnd = start + 2; });
        }} />
      </div>
    </div>
    <div id={id} className={`json-validation ${check.valid ? 'is-valid' : 'is-invalid'}`} aria-live="polite">
      {check.valid ? <><CheckCircle2 className="size-3.5" />JSON 格式正确<span className="ml-auto">{lines} 行</span></> : <><span>{check.message} · 第 {check.line} 行，第 {check.column} 列</span><button type="button" disabled={disabled} className="ml-auto inline-flex shrink-0 items-center gap-1 underline underline-offset-2" onClick={locate}><LocateFixed className="size-3.5" />定位错误</button></>}
    </div>
  </div>;
}

export function JsonEditor({ label, ariaLabel = label, value, onChange, disabled, actions }: Props) {
  const [expanded, setExpanded] = useState(false);
  const valid = useMemo(() => inspectJson(value).valid, [value]);
  const format = () => { if (valid) onChange(JSON.stringify(JSON.parse(value), null, 2)); };
  return <div className="json-editor">
    <div className="json-toolbar"><span className="font-medium">{label}</span><div className="flex flex-wrap items-center justify-end gap-1">{actions}<Button type="button" size="sm" variant="ghost" disabled={disabled || !valid} onClick={format}><Braces />格式化</Button><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setExpanded(true)} aria-label={`全屏编辑${label}`}><Expand />全屏</Button></div></div>
    <EditorSurface value={value} onChange={onChange} disabled={disabled} ariaLabel={ariaLabel} />
    <Dialog open={expanded} onOpenChange={setExpanded}><DialogContent className="json-fullscreen-dialog" showCloseButton={false} initialFocus={() => document.querySelector<HTMLTextAreaElement>('.json-fullscreen-dialog .json-input')}>
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-4"><div><DialogTitle>{label} · 全屏编辑</DialogTitle><DialogDescription className="mt-1">修改保留在草稿中，退出全屏后点击「保存」才会应用。</DialogDescription></div><Button type="button" variant="outline" onClick={() => setExpanded(false)}><Minimize2 />退出全屏</Button></div>
      <div className="flex shrink-0 justify-end px-5 py-2"><Button type="button" size="sm" variant="ghost" disabled={disabled || !valid} onClick={format}><Braces />格式化 JSON</Button></div>
      <EditorSurface value={value} onChange={onChange} disabled={disabled} ariaLabel={`${ariaLabel}（全屏）`} full />
    </DialogContent></Dialog>
  </div>;
}
