import { defineConfig } from 'vite';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';
import nodepod from '@scelar/nodepod/vite';

export default defineConfig(({ mode }) => {
  const isLib = mode === 'lib';

  return {
    plugins: [
      (monacoEditorPlugin as any).default({
        languageWorkers: ['editorWorkerService', 'json', 'css', 'html', 'typescript'],
      }),
      nodepod(),
    ],
    server: {
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
      proxy: {
        '/api/browserbase': {
          target: 'https://api.browserbase.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/browserbase/, ''),
          secure: true,
        },
      },
    },
    preview: {
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },
    css: {
      postcss: { plugins: [] },
    },
    build: isLib
      ? {
          target: 'esnext',
          lib: {
            entry: 'src/sdk.ts',
            formats: ['es'],
            fileName: 'sdk',
          },
          rollupOptions: {
            external: ['@webcontainer/api', '@scelar/nodepod', '@xterm/xterm', '@xterm/addon-fit', 'monaco-editor'],
          },
        }
      : {
          target: 'esnext',
        },
    optimizeDeps: {
      exclude: ['@webcontainer/api'],
    },
  };
});
