import { createLLGuidanceRuntime } from './runtime.js';
import wasmUrl from './wasm/llguidance_wasm_bg.wasm?url';

export async function loadBundledLLGuidance(options = {}) {
  const wasmModule = await import('./wasm/llguidance_wasm.js');
  await wasmModule.default({ module_or_path: options.wasmUrl ?? wasmUrl });
  return createLLGuidanceRuntime(wasmModule);
}
