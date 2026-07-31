import { createHandleRuntime } from "./runtime-core.ts";
import type {
  HandleEngineModule,
  InterpreterHandle,
  TokenizerHandle,
} from "./engine/core.ts";
import type { InterpreterConfig } from "./runtime-core.ts";

export function createLeanRuntime<
  TTokenizer extends TokenizerHandle,
  TInterpreter extends InterpreterHandle,
  TConfig extends InterpreterConfig = InterpreterConfig,
>(mod: HandleEngineModule<TTokenizer, TInterpreter>) {
  const { createTokenizer, createInterpreter } = createHandleRuntime<
    TTokenizer,
    TInterpreter,
    TConfig
  >(mod);
  return {
    createTokenizer,
    createInterpreter,
    get_version(): string {
      return "llguidance-ts-core";
    },
  };
}
