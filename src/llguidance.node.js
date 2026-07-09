import { readFile } from 'node:fs/promises';

import { createLLGuidanceRuntime } from './llguidance.js';
import * as wasmModule from './wasm/llguidance_wasm.js';

export async function loadBundledLLGuidance() {
  const wasmBytes = await readFile(new URL('./wasm/llguidance_wasm_bg.wasm', import.meta.url));
  await wasmModule.default(wasmBytes);
  return createLLGuidanceRuntime(wasmModule);
}
