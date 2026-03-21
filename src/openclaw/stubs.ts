import SHARP_PKG from './stubs/sharp/package.json?raw';
import SHARP_CJS from './stubs/sharp/index.cjs?raw';
import SHARP_MJS from './stubs/sharp/index.mjs?raw';
import PTY_PKG from './stubs/lydell-node-pty/package.json?raw';
import PTY_CJS from './stubs/lydell-node-pty/index.cjs?raw';
import PTY_MJS from './stubs/lydell-node-pty/index.mjs?raw';
import PW_PKG from './stubs/playwright-core/package.json?raw';
import PW_CJS from './stubs/playwright-core/index.cjs?raw';
import PW_MJS from './stubs/playwright-core/index.mjs?raw';
import SQLVEC_PKG from './stubs/sqlite-vec/package.json?raw';
import SQLVEC_CJS from './stubs/sqlite-vec/index.cjs?raw';
import SQLVEC_MJS from './stubs/sqlite-vec/index.mjs?raw';
import LLAMA_PKG from './stubs/node-llama-cpp/package.json?raw';
import LLAMA_CJS from './stubs/node-llama-cpp/index.cjs?raw';
import LLAMA_MJS from './stubs/node-llama-cpp/index.mjs?raw';

/** Workspace files to mount under `.openclaw-stubs/`. */
export const STUB_FILES: Record<string, string> = {
  '.openclaw-stubs/sharp/package.json': SHARP_PKG,
  '.openclaw-stubs/sharp/index.cjs': SHARP_CJS,
  '.openclaw-stubs/sharp/index.mjs': SHARP_MJS,
  '.openclaw-stubs/lydell-node-pty/package.json': PTY_PKG,
  '.openclaw-stubs/lydell-node-pty/index.cjs': PTY_CJS,
  '.openclaw-stubs/lydell-node-pty/index.mjs': PTY_MJS,
  '.openclaw-stubs/playwright-core/package.json': PW_PKG,
  '.openclaw-stubs/playwright-core/index.cjs': PW_CJS,
  '.openclaw-stubs/playwright-core/index.mjs': PW_MJS,
  '.openclaw-stubs/sqlite-vec/package.json': SQLVEC_PKG,
  '.openclaw-stubs/sqlite-vec/index.cjs': SQLVEC_CJS,
  '.openclaw-stubs/sqlite-vec/index.mjs': SQLVEC_MJS,
  '.openclaw-stubs/node-llama-cpp/package.json': LLAMA_PKG,
  '.openclaw-stubs/node-llama-cpp/index.cjs': LLAMA_CJS,
  '.openclaw-stubs/node-llama-cpp/index.mjs': LLAMA_MJS,
};

/** Shell script to copy stubs into node_modules/ after npm install. */
export const INSTALL_STUBS_SCRIPT = `
echo "[ClawLess] Installing native dependency stubs..."
cd ..
rm -rf node_modules/sharp && cp -r workspace/.openclaw-stubs/sharp node_modules/sharp
mkdir -p node_modules/@lydell && rm -rf node_modules/@lydell/node-pty && cp -r workspace/.openclaw-stubs/lydell-node-pty node_modules/@lydell/node-pty
rm -rf node_modules/playwright-core && cp -r workspace/.openclaw-stubs/playwright-core node_modules/playwright-core
rm -rf node_modules/sqlite-vec && cp -r workspace/.openclaw-stubs/sqlite-vec node_modules/sqlite-vec
rm -rf node_modules/node-llama-cpp && cp -r workspace/.openclaw-stubs/node-llama-cpp node_modules/node-llama-cpp
cd workspace
echo "[ClawLess] Stubs installed."
`;
