import {
  LLGuidanceInterpreter,
  LLGuidanceTokenizer,
} from "./engine/json-only.ts";
import { createLeanRuntime } from "./lean-runtime.js";

let runtimePromise;

export function loadJsonGuidance() {
  runtimePromise ??= Promise.resolve(
    createLeanRuntime({ LLGuidanceInterpreter, LLGuidanceTokenizer }),
  );
  return runtimePromise;
}
