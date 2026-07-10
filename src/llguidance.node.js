import { readFile } from 'node:fs/promises';

import { createLLGuidanceRuntime } from './runtime.js';
import * as wasmModule from './wasm/llguidance_wasm.js';

export async function loadBundledLLGuidance(options = {}) {
  const wasmFactory = await loadWasmFactory(options);
  const module_or_path = options.wasm
    ?? options.wasmUrl
    ?? await readFile(new URL('./wasm/llguidance_wasm_bg.wasm', import.meta.url));
  await wasmFactory.default({ module_or_path });
  return createLLGuidanceRuntime(wasmFactory);
}

async function loadWasmFactory(options) {
  if (options.wasmFactory) {
    return resolveWasmFactory(options.wasmFactory);
  }

  if (options.wasmFactoryUrl) {
    return import(String(options.wasmFactoryUrl));
  }

  return wasmModule;
}

async function resolveWasmFactory(wasmFactory) {
  const factory = typeof wasmFactory === 'function' ? wasmFactory() : wasmFactory;
  return factory?.then ? factory : Promise.resolve(factory);
}
