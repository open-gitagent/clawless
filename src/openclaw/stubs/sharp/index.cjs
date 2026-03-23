'use strict';
function createBuilder() {
  const b = {};
  // All chainable methods return builder; add more as needed during D3 debugging
  for (const m of ['resize','rotate','flip','flop','sharpen','blur','flatten','negate',
    'normalize','greyscale','grayscale','removeAlpha','extract','trim','extend',
    'composite','png','jpeg','webp','avif','tiff','gif','raw','toFormat','withMetadata']) {
    b[m] = () => b;
  }
  b.toBuffer = () => Promise.resolve(Buffer.alloc(0));
  b.toFile = () => Promise.reject(new Error('sharp unavailable in WebContainer'));
  b.metadata = () => Promise.resolve({ width: 0, height: 0, format: 'unknown', channels: 0, hasAlpha: false });
  b.clone = () => createBuilder();
  b.pipe = () => b;
  return b;
}
function sharp() { return createBuilder(); }
sharp.cache = () => {};
sharp.concurrency = () => 0;
sharp.counters = () => ({ queue: 0, process: 0 });
sharp.simd = () => false;
sharp.versions = { vips: '0.0.0', sharp: '0.34.5' };
sharp.format = {};
module.exports = sharp;
module.exports.default = sharp;
module.exports.__esModule = true;
