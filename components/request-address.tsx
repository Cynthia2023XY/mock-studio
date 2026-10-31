'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { describeAddress } from '@/lib/ui-model.mjs';
import { Button } from '@/components/ui/button';

export function CopyValue({ value, label, notify }: { value: string; label: string; notify: (message: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true); notify(`${label}已复制`);
      clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800);
    } catch { notify('复制失败，请手动选择并复制内容'); }
  };
  return <Button type="button" size="icon-sm" variant="ghost" title={`复制${label}`} aria-label={copied ? `${label}已复制` : `复制${label}`} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</Button>;
}

export function RequestAddress({ value, notify }: { value: string; notify: (message: string) => void }) {
  const address = describeAddress(value);
  return <div className="flex min-w-0 items-center gap-2"><div className="min-w-0 flex-1" title={value}><code className="block truncate text-xs font-medium text-foreground">{address.name}</code><span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{address.context}</span></div><CopyValue value={value} label="完整地址" notify={notify} /></div>;
}
