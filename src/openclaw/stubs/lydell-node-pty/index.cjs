'use strict';
function spawn() { throw new Error('node-pty unavailable in WebContainer'); }
module.exports.spawn = spawn;
module.exports.default = { spawn };
module.exports.__esModule = true;
