import test from "node:test";

import { assertJsonSchema } from "./helpers.mjs";

const value = { a: 1, b: 2 };

function topLevelSchema(options) {
  return { "x-guidance": options };
}

function objectSchema(options) {
  return {
    type: "object",
    properties: {
      a: { type: "integer" },
      b: { type: "integer" },
    },
    required: ["a", "b"],
    additionalProperties: false,
    "x-guidance": options,
  };
}

function registerCases(suite, schema, cases, skipReason) {
  for (const [name, jsonText, expected] of cases) {
    test(`${suite}: ${name}`, { skip: skipReason }, () => {
      assertJsonSchema(schema, value, expected, jsonText);
    });
  }
}

const simpleCases = [
  ["with_spaces", '{"a": 1, "b": 2}', true],
  ["no_spaces", '{"a":1,"b":2}', false],
  ["two_spaces_around_colon", '{"a"  :  1 , "b":2}', false],
  ["spaces_before_comma", '{"a":1 ,  "b":2}', false],
  ["two_spaces_after_colon", '{"a":1,"b":  2}', false],
  ["three_spaces_after_comma", '{"a":1,   "b":2}', false],
  ["four_spaces_after_colon", '{"a":1,"b":    2}', false],
];
const simpleOptions = {
  item_separator: ", ",
  key_separator: ": ",
  whitespace_flexible: false,
};
registerCases("simple separators", topLevelSchema(simpleOptions), simpleCases);
registerCases(
  "simple separators with object schema",
  objectSchema(simpleOptions),
  simpleCases,
);

const alternateCases = [
  ["regular_json", '{"a": 1, "b": 2}', false],
  ["alternate_json", '{"a"_ 1-"b"_ 2}', true],
  ["alternate_json_missing_space", '{"a"_ 1-"b"_2}', false],
];
registerCases(
  "alternate separators",
  topLevelSchema({
    item_separator: "-",
    key_separator: "_ ",
    whitespace_flexible: false,
  }),
  alternateCases,
);
registerCases(
  "alternate separators with object schema",
  objectSchema({
    item_separator: "-",
    key_separator: "_ ",
    whitespace_flexible: true,
  }),
  alternateCases,
);

const patternCases = [
  ["with_spaces", '{"a": 1, "b": 2}', true],
  ["no_spaces", '{"a":1,"b":2}', true],
  ["two_spaces_around_colon", '{"a"  :  1 , "b":2}', true],
  ["spaces_before_comma", '{"a":1 ,  "b":2}', true],
  ["two_spaces_after_colon", '{"a":1,"b":  2}', true],
  ["three_spaces_after_comma", '{"a":1,   "b":2}', false],
  ["four_spaces_after_colon", '{"a":1,"b":    2}', false],
];
registerCases(
  "pattern separators",
  topLevelSchema({
    item_separator: String.raw`\s{0,2},\s{0,2}`,
    key_separator: String.raw`\s{0,2}:\s{0,2}`,
    whitespace_flexible: false,
  }),
  patternCases,
  "llguidance 1.2.0 does not support regex-valued item_separator/key_separator options",
);

const flexibleCases = [
  ["with_spaces", '{"a": 1, "b": 2}', true],
  ["no_spaces", '{"a":1,"b":2}', true],
  ["two_spaces_around_colon", '{"a"  :  1 , "b":2}', true],
  ["spaces_before_comma", '{"a":1 ,  "b":2}', true],
  ["two_spaces_after_colon", '{"a":1,"b":  2}', true],
  ["three_spaces_after_comma", '{"a":1,   "b":2}', true],
  ["four_spaces_after_colon", '{"a":1,"b":    2}', true],
  ["multi_line", '{\n"a"\n:\n1,\n"b"\n:\n2\n}', true],
  ["pretty_print", '{\n  "a": 1,\n  "b": 2\n}', true],
  ["pretty_print_extra_spaces", '{\n  "a" : 1 , \n  "b" : 2\n}', true],
];
const flexibleOptions = {
  item_separator: ",",
  key_separator: ":",
  whitespace_flexible: true,
};
registerCases(
  "flexible separators",
  topLevelSchema(flexibleOptions),
  flexibleCases,
);
registerCases(
  "flexible separators with object schema",
  objectSchema(flexibleOptions),
  flexibleCases,
);

const flexibleWithSpacesCases = [
  ["with_spaces", '{"a": 1, "b": 2}', true],
  ["no_spaces", '{"a":1,"b":2}', false],
  ["two_spaces_around_colon", '{"a"  :  1 , "b":2}', false],
  ["two_spaces_around_both_colons", '{"a"  :  1 , "b"  :  2}', true],
  ["spaces_before_comma", '{"a":1 ,  "b":2}', false],
  ["spaces_before_comma_2", '{"a": 1 , "b": 2}', true],
  ["two_spaces_after_colon", '{"a":1,"b":  2}', false],
  ["three_spaces_after_comma", '{"a":1,   "b":2}', false],
  ["four_spaces_after_colon", '{"a":1,"b":    2}', false],
  ["multi_line", '{\n"a"\n:\n1,\n"b"\n:\n2\n}', false],
  ["multi_line_2", '{\n"a"\n: \n1, \n"b"\n: \n2\n}', true],
  ["pretty_print", '{\n  "a":\n 1,\n  "b":\n 2\n}', false],
  ["pretty_print_2", '{\n  "a": 1,\n  "b": 2\n}', false],
  ["pretty_print_3", '{\n  "a": 1, \n  "b": 2\n}', true],
  ["pretty_print_extra_spaces", '{\n  "a" : 1 , \n  "b" : 2\n}', true],
];
const flexibleWithSpacesOptions = {
  item_separator: ", ",
  key_separator: ": ",
  whitespace_flexible: true,
};
registerCases(
  "flexible separators with spaces",
  topLevelSchema(flexibleWithSpacesOptions),
  flexibleWithSpacesCases,
);
registerCases(
  "flexible separators with spaces and object schema",
  objectSchema(flexibleWithSpacesOptions),
  flexibleWithSpacesCases.slice(0, 9),
);

const unspecifiedCases = [
  ["with_spaces", '{"a": 1, "b": 2}', true],
  ["no_spaces", '{"a":1,"b":2}', true],
  ["two_spaces_around_colon", '{"a"  :  1 , "b":2}', true],
  ["two_spaces_around_both_colons", '{"a"  :  1 , "b"  :  2}', true],
  ["spaces_before_comma", '{"a":1 ,  "b":2}', true],
  ["spaces_before_comma_2", '{"a": 1 , "b": 2}', true],
  ["two_spaces_after_colon", '{"a":1,"b":  2}', true],
  ["three_spaces_after_comma", '{"a":1,   "b":2}', true],
  ["four_spaces_after_colon", '{"a":1,"b":    2}', true],
  ["multi_line", '{\n"a"\n:\n1,\n"b"\n:\n2\n}', true],
  ["multi_line_2", '{\n"a"\n: \n1, \n"b"\n: \n2\n}', true],
  ["pretty_print", '{\n  "a":\n 1,\n  "b":\n 2\n}', true],
  ["pretty_print_2", '{\n  "a": 1,\n  "b": 2\n}', true],
  ["pretty_print_3", '{\n  "a": 1, \n  "b": 2\n}', true],
  ["pretty_print_extra_spaces", '{\n  "a" : 1 , \n  "b" : 2\n}', true],
  ["pretty_print_extra_spaces_2", '{\n    "a" :  1 ,  \n    "b" :  2\n}', true],
];
const whitespaceFlexibleObjectSchema = objectSchema({
  whitespace_flexible: true,
});
registerCases(
  "flexible whitespace with unspecified separators",
  whitespaceFlexibleObjectSchema,
  unspecifiedCases,
);

function formatObject(indentWidth, comma, colon) {
  const indentation = indentWidth === null ? null : " ".repeat(indentWidth);
  const itemSeparator = comma ?? ",";
  const keySeparator = colon ?? ":";

  if (indentation === null) {
    return `{"a"${keySeparator}1${itemSeparator}"b"${keySeparator}2}`;
  }

  return `{\n${indentation}"a"${keySeparator}1${itemSeparator}\n${indentation}"b"${keySeparator}2\n}`;
}

const indentWidths = [null, 2, 4];
const commas = [null, ",", ", ", " ,", " , ", " ,\n", "\n,\n"];
const colons = [null, ":", ": ", " :", " : ", " :\n", "\n:\n"];

for (const indentWidth of indentWidths) {
  for (const comma of commas) {
    for (const colon of colons) {
      const label = `indent=${indentWidth ?? "none"}, comma=${JSON.stringify(comma)}, colon=${JSON.stringify(colon)}`;
      test(`flexible whitespace many formats: ${label}`, () => {
        assertJsonSchema(
          whitespaceFlexibleObjectSchema,
          value,
          true,
          formatObject(indentWidth, comma, colon),
        );
      });
    }
  }
}
