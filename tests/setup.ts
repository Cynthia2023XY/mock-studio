import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// jsdom 不进行布局；组件测试只验证可见行为，布局和配色由真实浏览器验收。
Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true })) });
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', TestResizeObserver);
HTMLElement.prototype.scrollIntoView = function () {};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = 'dark';
  document.documentElement.classList.add('dark');
  document.documentElement.style.colorScheme = 'dark';
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
