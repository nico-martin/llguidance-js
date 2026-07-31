import {
  LLGuidanceInterpreter,
  LLGuidanceTokenizer,
} from "./engine/json-only.ts";
import { createLeanRuntime } from "./lean-runtime.ts";
import type { InterpreterConfig } from "./runtime-core.ts";

export type JsonResponseFormat =
  { type: "json_object" } | { type: "json_schema"; json_schema: unknown };
export type JsonInterpreterConfig = InterpreterConfig &
  (
    | {
        response_format: JsonResponseFormat;
        responseFormat?: never;
      }
    | {
        response_format?: never;
        responseFormat: JsonResponseFormat;
      }
  );

const engine = { LLGuidanceInterpreter, LLGuidanceTokenizer };
const createRuntime = () =>
  createLeanRuntime<
    InstanceType<typeof LLGuidanceTokenizer>,
    InstanceType<typeof LLGuidanceInterpreter>,
    JsonInterpreterConfig
  >(engine);

export type JsonGuidanceRuntime = ReturnType<typeof createRuntime>;

let runtimePromise: Promise<JsonGuidanceRuntime> | undefined;

export function loadJsonGuidance(): Promise<JsonGuidanceRuntime> {
  runtimePromise ??= Promise.resolve(createRuntime());
  return runtimePromise;
}
