import { createEngine } from "./core.ts";
import { compileLark } from "./grammar.ts";

const engine = createEngine({ compileLark });

export const { LLGuidanceTokenizer, LLGuidanceInterpreter } = engine;
