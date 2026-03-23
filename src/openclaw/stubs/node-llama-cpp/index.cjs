'use strict';
const ERR = 'node-llama-cpp unavailable in WebContainer';
async function getLlama() { throw new Error(ERR); }
class LlamaModel { constructor() { throw new Error(ERR); } }
class LlamaContext { constructor() { throw new Error(ERR); } }
class LlamaChatSession { constructor() { throw new Error(ERR); } }
async function resolveModelFile() { throw new Error(ERR); }
const LlamaLogLevel = { error: 0, warn: 1, info: 2, debug: 3 };
module.exports.getLlama = getLlama;
module.exports.LlamaModel = LlamaModel;
module.exports.LlamaContext = LlamaContext;
module.exports.LlamaChatSession = LlamaChatSession;
module.exports.resolveModelFile = resolveModelFile;
module.exports.LlamaLogLevel = LlamaLogLevel;
module.exports.default = { getLlama, LlamaModel, LlamaContext, LlamaChatSession, resolveModelFile, LlamaLogLevel };
module.exports.__esModule = true;
