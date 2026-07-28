import { createHandleRuntime } from "./runtime-core.js";

export function createLeanRuntime(mod) {
  const { createTokenizer, createInterpreter } = createHandleRuntime(mod);
  return {
    createTokenizer,
    createInterpreter,
    get_version() {
      return "llguidance-ts-core";
    },
  };
}
