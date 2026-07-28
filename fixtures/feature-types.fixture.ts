import { loadJsonGuidance } from "../dist/json-schema.js";
import { loadRegexGuidance } from "../dist/regex.js";

async function checkFeatureTypes() {
  const regex = await loadRegexGuidance();
  const regexTokenizer = regex.createTokenizer();
  regex.createInterpreter({
    tokenizer: regexTokenizer,
    response_format: { type: "regex", regex: "a" },
  });
  regex.createInterpreter({
    tokenizer: regexTokenizer,
    // @ts-expect-error The regex bundle does not expose JSON response formats.
    response_format: { type: "json_object" },
  });

  const json = await loadJsonGuidance();
  const jsonTokenizer = json.createTokenizer();
  json.createInterpreter({
    tokenizer: jsonTokenizer,
    response_format: { type: "json_object" },
  });
  json.createInterpreter({
    tokenizer: jsonTokenizer,
    responseFormat: {
      type: "json_schema",
      json_schema: { type: "string" },
    },
  });
  json.createInterpreter({
    tokenizer: jsonTokenizer,
    // @ts-expect-error The JSON bundle does not expose regex response formats.
    response_format: { type: "regex", regex: "a" },
  });
}

void checkFeatureTypes;
