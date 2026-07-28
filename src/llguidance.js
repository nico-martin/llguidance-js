import * as engine from "./engine/index.ts";
import { createLLGuidanceRuntime } from "./runtime.js";

let runtimePromise;

export function loadBundledLLGuidance() {
  runtimePromise ??= Promise.resolve(createLLGuidanceRuntime(engine));
  return runtimePromise;
}

export const loadLLGuidance = loadBundledLLGuidance;
