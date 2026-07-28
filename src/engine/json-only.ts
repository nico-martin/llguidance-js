import { createEngine } from "./core.ts";
import { compileJsonSchema } from "./json-schema.ts";

const engine = createEngine({ compileJsonSchema });

export const {
  LLGuidanceTokenizer,
  LLGuidanceInterpreter,
  grammarFrom,
  grammarFromJsonSchema,
  grammarFromLark,
  grammarFromRegex,
} = engine;
