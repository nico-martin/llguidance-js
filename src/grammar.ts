import {
  LLGuidanceInterpreter,
  LLGuidanceTokenizer,
} from "./engine/grammar-only.ts";
import { grammarFromLark, type GrammarCapture } from "./engine/core.ts";
import { createHandleRuntime } from "./runtime-core.ts";
import type { InterpreterConfig } from "./runtime-core.ts";

export interface GrammarInterpreterConfig extends InterpreterConfig {
  grammar: string;
}

export type { GrammarCapture };

const engine = { LLGuidanceInterpreter, LLGuidanceTokenizer };
const handles = createHandleRuntime<
  InstanceType<typeof LLGuidanceTokenizer>,
  InstanceType<typeof LLGuidanceInterpreter>,
  GrammarInterpreterConfig
>(engine);

const createRuntime = () => ({
  createTokenizer: handles.createTokenizer,
  createInterpreter(config: GrammarInterpreterConfig) {
    if (typeof config?.grammar !== "string") {
      throw new TypeError("createInterpreter requires a Lark grammar string");
    }
    return handles.createInterpreter({
      ...config,
      grammar: grammarFromLark(config.grammar),
    });
  },
  get_version(): string {
    return "llguidance-ts-core";
  },
});

export type GrammarGuidanceRuntime = ReturnType<typeof createRuntime>;

let runtimePromise: Promise<GrammarGuidanceRuntime> | undefined;

export function loadGrammarGuidance(): Promise<GrammarGuidanceRuntime> {
  runtimePromise ??= Promise.resolve(createRuntime());
  return runtimePromise;
}
