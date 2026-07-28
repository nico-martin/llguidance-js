import * as engine from "./engine/index.ts";
import { createLLGuidanceRuntime, type LLGuidanceRuntime } from "./runtime.ts";

let runtimePromise: Promise<LLGuidanceRuntime> | undefined;

export function loadBundledLLGuidance(): Promise<LLGuidanceRuntime> {
  runtimePromise ??= Promise.resolve(createLLGuidanceRuntime(engine));
  return runtimePromise;
}

export const loadLLGuidance = loadBundledLLGuidance;
