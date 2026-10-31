'use client';

import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Theme = 'light' | 'dark';
const applyTheme = (theme: Theme) => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
};

const subscribe = (notify: () => void) => {
  const sync = (event: StorageEvent) => {
    if (event.key !== 'mock-studio-theme') return;
    const next = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(next); notify();
  };
  window.addEventListener('storage', sync);
  window.addEventListener('mock-studio-theme-change', notify);
  return () => { window.removeEventListener('storage', sync); window.removeEventListener('mock-studio-theme-change', notify); };
};
const getTheme = (): Theme => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
const serverTheme = (): Theme => 'dark';

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getTheme, serverTheme);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('mock-studio-theme', next); } catch { /* 禁用存储时仍可在当前页面切换 */ }
    window.dispatchEvent(new Event('mock-studio-theme-change'));
  };
  const label = theme === 'dark' ? '白天模式' : '黑夜模式';
  return <Button type="button" variant="outline" className="shrink-0 gap-2" aria-label={`切换到${label}`} title={`切换到${label}`} onClick={toggle}>{theme === 'dark' ? <Sun /> : <Moon />}<span className="hidden sm:inline">{label}</span></Button>;
}
