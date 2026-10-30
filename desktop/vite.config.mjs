import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录，用于解析现有界面代码和样式 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  root: path.join(root, 'desktop'),
  base: '/',
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  resolve: { alias: { '@': root } },
  build: { outDir: path.join(root, 'desktop-dist'), emptyOutDir: true },
});
