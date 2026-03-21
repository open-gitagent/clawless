'use strict';
const ERR = 'node-llama-cpp unavailable in WebContainer';
async function getLlama() { throw new Error(ERR); }
class LlamaModel { constructor() { throw new Error(ERR); } }
class LlamaContext { constructor() { throw new Error(ERR); } }
class LlamaChatSession { constructor() { throw new Error(ERR); } }
module.exports.getLlama = getLlama;
module.exports.LlamaModel = LlamaModel;
module.exports.LlamaContext = LlamaContext;
module.exports.LlamaChatSession = LlamaChatSession;
module.exports.default = { getLlama, LlamaModel, LlamaContext, LlamaChatSession };
module.exports.__esModule = true;
