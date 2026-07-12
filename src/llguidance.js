import { createLLGuidanceRuntime } from './runtime.js';
import wasmUrl from './wasm/llguidance_wasm_bg.wasm?url';

export async function loadBundledLLGuidance(options = {}) {
  const wasmFactory = await loadWasmFactory(options);
  await wasmFactory.default({ module_or_path: options.wasm ?? options.wasmUrl ?? wasmUrl });
  return createLLGuidanceRuntime(wasmFactory);
}

export const loadLLGuidance = loadBundledLLGuidance;

async function loadWasmFactory(options) {
  if (options.wasmFactory) {
    return resolveWasmFactory(options.wasmFactory);
  }

  if (options.wasmFactoryUrl) {
    return import(/* @vite-ignore */ String(options.wasmFactoryUrl));
  }

  return import('./wasm/llguidance_wasm.js');
}

async function resolveWasmFactory(wasmFactory) {
  const factory = typeof wasmFactory === 'function' ? wasmFactory() : wasmFactory;
  return factory?.then ? factory : Promise.resolve(factory);
}
