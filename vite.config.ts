import { defineConfig } from 'vite';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';

export default defineConfig(({ mode }) => {
  const isLib = mode === 'lib';

  return {
    plugins: [
      (monacoEditorPlugin as any).default({
        languageWorkers: ['editorWorkerService', 'json', 'css', 'html', 'typescript'],
      }),
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
    build: isLib
      ? {
          target: 'esnext',
          lib: {
            entry: 'src/sdk.ts',
            formats: ['es'],
            fileName: 'sdk',
          },
          rollupOptions: {
            external: ['@webcontainer/api', '@xterm/xterm', '@xterm/addon-fit', 'monaco-editor'],
          },
        }
      : {
          target: 'esnext',
          rollupOptions: {
            external: ['quickjs-emscripten'],
          },
        },
    optimizeDeps: {
      exclude: [
        '@webcontainer/api',
        'quickjs-emscripten',
        'quickjs-emscripten-core',
        '@jitl/quickjs-wasmfile-release-sync',
        '@jitl/quickjs-wasmfile-release-asyncify',
        '@jitl/quickjs-wasmfile-debug-asyncify',
      ],
    },
    assetsInclude: ['**/*.wasm'],
  };
});
