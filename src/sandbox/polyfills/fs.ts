// ─── fs polyfill (wired to VirtualFS) ───────────────────────────────────────

import type { VirtualFS } from '../vfs.js';

/** Create the fs module object bound to a VirtualFS instance. */
export function createFsModule(vfs: VirtualFS) {
  // Wrap sync methods as async (callback + promise)
  function wrapAsync(syncFn: Function) {
    return function (...args: any[]) {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      try {
        const result = syncFn(...args);
        if (cb) cb(null, result);
        return result;
      } catch (e) {
        if (cb) cb(e);
        else throw e;
      }
    };
  }

  const fsModule = {
    // Sync
    readFileSync: (path: string, opts?: any) => {
      const enc = typeof opts === 'string' ? opts : opts?.encoding;
      return vfs.readFileSync(path, enc);
    },
    writeFileSync: (path: string, data: any, opts?: any) => {
      vfs.writeFileSync(path, typeof data === 'string' ? data : data, opts);
    },
    appendFileSync: (path: string, data: any) => vfs.appendFileSync(path, data),
    existsSync: (path: string) => vfs.existsSync(path),
    mkdirSync: (path: string, opts?: any) => vfs.mkdirSync(path, opts),
    rmdirSync: (path: string) => vfs.rmdirSync(path),
    rmSync: (path: string, opts?: any) => vfs.rmSync(path, opts),
    unlinkSync: (path: string) => vfs.unlinkSync(path),
    readdirSync: (path: string, opts?: any) => vfs.readdirSync(path, opts),
    statSync: (path: string) => vfs.statSync(path),
    lstatSync: (path: string) => vfs.lstatSync(path),
    accessSync: (path: string, mode?: number) => vfs.accessSync(path, mode),
    renameSync: (old: string, nw: string) => vfs.renameSync(old, nw),
    copyFileSync: (src: string, dest: string) => vfs.copyFileSync(src, dest),
    symlinkSync: (target: string, path: string) => vfs.symlinkSync(target, path),
    readlinkSync: (path: string) => vfs.readlinkSync(path),
    chmodSync: (path: string, mode: number) => vfs.chmodSync(path, mode),

    // Async (callback-style)
    readFile: wrapAsync((path: string, opts?: any) => {
      const enc = typeof opts === 'string' ? opts : opts?.encoding;
      return vfs.readFileSync(path, enc);
    }),
    writeFile: wrapAsync((path: string, data: any, opts?: any) => {
      vfs.writeFileSync(path, data, typeof opts === 'string' ? undefined : opts);
    }),
    appendFile: wrapAsync((path: string, data: any) => vfs.appendFileSync(path, data)),
    mkdir: wrapAsync((path: string, opts?: any) => vfs.mkdirSync(path, opts)),
    rmdir: wrapAsync((path: string) => vfs.rmdirSync(path)),
    rm: wrapAsync((path: string, opts?: any) => vfs.rmSync(path, opts)),
    unlink: wrapAsync((path: string) => vfs.unlinkSync(path)),
    readdir: wrapAsync((path: string, opts?: any) => vfs.readdirSync(path, opts)),
    stat: wrapAsync((path: string) => vfs.statSync(path)),
    lstat: wrapAsync((path: string) => vfs.lstatSync(path)),
    access: wrapAsync((path: string, mode?: number) => vfs.accessSync(path, mode)),
    rename: wrapAsync((old: string, nw: string) => vfs.renameSync(old, nw)),
    copyFile: wrapAsync((src: string, dest: string) => vfs.copyFileSync(src, dest)),
    symlink: wrapAsync((target: string, path: string) => vfs.symlinkSync(target, path)),
    readlink: wrapAsync((path: string) => vfs.readlinkSync(path)),
    chmod: wrapAsync((path: string, mode: number) => vfs.chmodSync(path, mode)),
    exists: (path: string, cb?: Function) => {
      const result = vfs.existsSync(path);
      if (cb) cb(result);
      return result;
    },

    // Watch
    watch: (path: string, opts: any, cb?: any) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      return vfs.watch(path, opts ?? {}, cb);
    },

    // Promises API
    promises: {
      readFile: async (path: string, opts?: any) => {
        const enc = typeof opts === 'string' ? opts : opts?.encoding;
        return vfs.readFileSync(path, enc);
      },
      writeFile: async (path: string, data: any) => vfs.writeFileSync(path, data),
      appendFile: async (path: string, data: any) => vfs.appendFileSync(path, data),
      mkdir: async (path: string, opts?: any) => vfs.mkdirSync(path, opts),
      rmdir: async (path: string) => vfs.rmdirSync(path),
      rm: async (path: string, opts?: any) => vfs.rmSync(path, opts),
      unlink: async (path: string) => vfs.unlinkSync(path),
      readdir: async (path: string, opts?: any) => vfs.readdirSync(path, opts),
      stat: async (path: string) => vfs.statSync(path),
      access: async (path: string) => vfs.accessSync(path),
      rename: async (old: string, nw: string) => vfs.renameSync(old, nw),
      copyFile: async (src: string, dest: string) => vfs.copyFileSync(src, dest),
    },

    // Constants
    constants: {
      F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
      COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2,
    },
  };

  return fsModule;
}
