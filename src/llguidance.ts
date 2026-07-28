import * as engine from "./engine/index.ts";
import { createLLGuidanceRuntime, type LLGuidanceRuntime } from "./runtime.ts";

export type { LLGuidanceRuntime } from "./runtime.ts";
export type {
  CommitResult as LLGuidanceCommitResult,
  GuidanceLimits as LLGuidanceLimits,
  InterpreterHandle as LLGuidanceInterpreterHandle,
  MaskResult as LLGuidanceMaskResult,
  TokenizerConfig as LLGuidanceTokenizerConfig,
  TokenizerHandle as LLGuidanceTokenizerHandle,
} from "./engine/core.ts";
export type { TokenizerSource as LLGuidanceTokenizerSource } from "./runtime-core.ts";

export type JSONValue =
  null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type JSONSchema = boolean | { [key: string]: JSONValue };

let runtimePromise: Promise<LLGuidanceRuntime> | undefined;

export function loadBundledLLGuidance(): Promise<LLGuidanceRuntime> {
  runtimePromise ??= Promise.resolve(createLLGuidanceRuntime(engine));
  return runtimePromise;
}

export const loadLLGuidance = loadBundledLLGuidance;
