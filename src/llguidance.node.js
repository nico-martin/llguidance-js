import { readFile } from 'node:fs/promises';

import { createLLGuidanceRuntime } from './runtime.js';
import * as wasmModule from './wasm/llguidance_wasm.js';

export async function loadBundledLLGuidance(options = {}) {
  const module_or_path = options.wasmUrl
    ?? await readFile(new URL('./wasm/llguidance_wasm_bg.wasm', import.meta.url));
  await wasmModule.default({ module_or_path });
  return createLLGuidanceRuntime(wasmModule);
}
