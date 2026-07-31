import {
  LLGuidanceInterpreter,
  LLGuidanceTokenizer,
} from "./engine/regex-only.ts";
import { createLeanRuntime } from "./lean-runtime.ts";
import type { InterpreterConfig } from "./runtime-core.ts";

export type RegexResponseFormat = { type: "regex"; regex: string };
export type RegexInterpreterConfig = InterpreterConfig &
  (
    | {
        response_format: RegexResponseFormat;
        responseFormat?: never;
      }
    | {
        response_format?: never;
        responseFormat: RegexResponseFormat;
      }
  );

const engine = { LLGuidanceInterpreter, LLGuidanceTokenizer };
const createRuntime = () =>
  createLeanRuntime<
    InstanceType<typeof LLGuidanceTokenizer>,
    InstanceType<typeof LLGuidanceInterpreter>,
    RegexInterpreterConfig
  >(engine);

export type RegexGuidanceRuntime = ReturnType<typeof createRuntime>;

let runtimePromise: Promise<RegexGuidanceRuntime> | undefined;

export function loadRegexGuidance(): Promise<RegexGuidanceRuntime> {
  runtimePromise ??= Promise.resolve(createRuntime());
  return runtimePromise;
}
