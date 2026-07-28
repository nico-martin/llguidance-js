import {
  LLGuidanceInterpreter,
  LLGuidanceTokenizer,
} from "./engine/regex-only.ts";
import { createLeanRuntime } from "./lean-runtime.js";

let runtimePromise;

export function loadRegexGuidance() {
  runtimePromise ??= Promise.resolve(
    createLeanRuntime({ LLGuidanceInterpreter, LLGuidanceTokenizer }),
  );
  return runtimePromise;
}
