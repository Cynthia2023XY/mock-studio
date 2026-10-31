import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 独立配置避免加载页面开发服务中的 RSC、Cloudflare 和 Whistle。
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 5000,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['app/page.tsx', 'app/demo/page.tsx', 'components/*.tsx', 'lib/ui-model.mjs', 'lib/demo.ts', 'lib/management-api.ts'],
      exclude: ['components/ui/**'],
    },
  },
});
