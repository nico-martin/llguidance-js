import { describe, test } from "node:test";

import { assertJsonSchema, llguidance } from "./helpers.mjs";

function checkValues(schema, values, expected) {
  for (const entry of values) {
    const [value, jsonText] = Array.isArray(entry) ? entry : [entry];
    assertJsonSchema(schema, value, expected, jsonText);
  }
}

const bounds = [
  ["inclusive", "minimum", "maximum"],
  ["exclusive", "exclusiveMinimum", "exclusiveMaximum"],
];
const negativeMultipleOfReason =
  llguidance.get_version() === "llguidance-ts-core"
    ? false
    : "llguidance 1.2.0 rejects negative values that are valid multiples";

describe("null", () => {
  test("null_schema", () => {
    assertJsonSchema({ type: "null" }, null, true);
  });

  test("null_schema_failures", () => {
    checkValues({ type: "null" }, [true, 1, "Hello"], false);
  });
});

describe("boolean", () => {
  test("boolean", () => {
    checkValues({ type: "boolean" }, [false, true], true);
  });

  test("boolean_failures", () => {
    checkValues({ type: "boolean" }, [0, 1, "false", "true"], false);
  });
});

describe("integer", () => {
  test("integer", () => {
    checkValues(
      { type: "integer" },
      [1, -1, 0, 10001, -20002, [1, "1.0"], [-1, "-1e0"]],
      true,
    );
  });

  test("integer_failures", () => {
    checkValues({ type: "integer" }, ["1", "0", [1.2, "1.2"]], false);
  });

  test("integer_lower_bound", () => {
    for (const [kind, minimumKeyword] of bounds) {
      for (const lowerBound of [-11, -2, -1, 0, 1, 2, 11]) {
        const schema = { type: "integer", [minimumKeyword]: lowerBound };
        for (let value = -200; value <= 200; value += 1) {
          const expected =
            kind === "inclusive" ? value >= lowerBound : value > lowerBound;
          assertJsonSchema(schema, value, expected);
        }
      }
    }
  });

  test("integer_upper_bound", () => {
    for (const [kind, , maximumKeyword] of bounds) {
      for (const upperBound of [-11, -2, -1, 0, 1, 2, 11]) {
        const schema = { type: "integer", [maximumKeyword]: upperBound };
        for (let value = -101; value <= 101; value += 1) {
          const expected =
            kind === "inclusive" ? value <= upperBound : value < upperBound;
          assertJsonSchema(schema, value, expected);
        }
      }
    }
  });

  test("integer_both_bounds", () => {
    const boundPairs = [
      [-10, -2],
      [-10, -1],
      [-10, 0],
      [-10, 2],
      [-3, -1],
      [-3, 0],
      [-3, 2],
      [0, 2],
      [0, 10],
      [1, 3],
      [1, 10],
      [2, 10],
    ];

    for (const [lowerKind, minimumKeyword] of bounds) {
      for (const [upperKind, , maximumKeyword] of bounds) {
        for (const [lowerBound, upperBound] of boundPairs) {
          const schema = {
            type: "integer",
            [minimumKeyword]: lowerBound,
            [maximumKeyword]: upperBound,
          };
          for (let value = -101; value <= 101; value += 1) {
            const aboveMinimum =
              lowerKind === "inclusive"
                ? value >= lowerBound
                : value > lowerBound;
            const belowMaximum =
              upperKind === "inclusive"
                ? value <= upperBound
                : value < upperBound;
            assertJsonSchema(schema, value, aboveMinimum && belowMaximum);
          }
        }
      }
    }
  });

  test("integer_limits_incompatible", () => {
    for (const minimumKeyword of ["minimum", "exclusiveMinimum"]) {
      for (const maximumKeyword of ["maximum", "exclusiveMaximum"]) {
        assertJsonSchema(
          { type: "integer", [minimumKeyword]: 1, [maximumKeyword]: -1 },
          0,
          false,
        );
      }
    }
  });

  test("integer_limits_empty", () => {
    assertJsonSchema(
      { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      0,
      false,
    );
  });

  test("integer_multipleof", () => {
    const schema = { type: "integer", multipleOf: 3 };
    for (const value of [-1819, -2, -1, 0, 1, 3, 12, 1818, 1819]) {
      assertJsonSchema(schema, value, value % 3 === 0);
    }
  });

  for (const value of [-1818, -12, -3]) {
    test(
      `integer_multipleof(${value})`,
      { skip: negativeMultipleOfReason },
      () => {
        assertJsonSchema({ type: "integer", multipleOf: 3 }, value, true);
      },
    );
  }

  test("integer_both_minima", () => {
    checkValues(
      { type: "integer", minimum: 2, exclusiveMinimum: 1 },
      [2, 3, 4],
      true,
    );
  });

  test("integer_both_maxima", () => {
    checkValues(
      { type: "integer", maximum: 4, exclusiveMaximum: 2 },
      [-1, 0, 1],
      true,
    );
  });
});

describe("number", () => {
  test("number", () => {
    checkValues(
      { type: "number" },
      [
        0,
        [0, "0.0"],
        1,
        [1, "1.0"],
        -1,
        [-1, "-1.0"],
        [10001.1, "10001.1"],
        [-20002.231, "-20002.231"],
        [823.1, "823.1"],
        [0.08231, "0.08231"],
        [-1.61e28, "-1.61e28"],
        [-8.4e-8, "-8.4e-8"],
      ],
      true,
    );
  });

  test("number_failures", () => {
    checkValues({ type: "number" }, ["1.0", "1", false, "Hello"], false);
  });

  test("number_lower_bound", () => {
    const lowerBounds = [
      -4.2e9, -11, -2, -1, -3.4e-8, 0, 2.3e-7, 1, 2, 11, 3.4e8,
    ];
    const testValues = [
      [-2e23, "-2e23"],
      [-100, "-100.0"],
      [-11, "-11.0"],
      [-5, "-5.0"],
      [-1.000001, "-1.000001"],
      [-1, "-1.0"],
      [-0.9999999, "-0.9999999"],
      [-0.092, "-0.092"],
      [-0.002, "-0.002"],
      [0, "0.0"],
      [0.0001, "0.0001"],
      [0.092, "0.092"],
      [0.99999, "0.99999"],
      [1, "1.0"],
      [1.000001, "1.000001"],
      [10, "10.0"],
      [12, "12.0"],
      [4.5e14, "450000000000000.0"],
    ];

    for (const [kind, minimumKeyword] of bounds) {
      for (const lowerBound of lowerBounds) {
        const schema = { type: "number", [minimumKeyword]: lowerBound };
        for (const [value, jsonText] of testValues) {
          const expected =
            kind === "inclusive" ? value >= lowerBound : value > lowerBound;
          assertJsonSchema(schema, value, expected, jsonText);
        }
      }
    }
  });

  test("number_upper_bound", () => {
    const upperBounds = [-100, 0, 1, 100];
    const testValues = [
      [-100.0001, "-100.0001"],
      [-100, "-100.0"],
      [-99.999, "-99.999"],
      [0.9999, "0.9999"],
      [1, "1.0"],
      [1.00001, "1.00001"],
      [99.999, "99.999"],
      [100, "100.0"],
      [100.00001, "100.00001"],
    ];

    for (const [kind, , maximumKeyword] of bounds) {
      for (const upperBound of upperBounds) {
        const schema = { type: "number", [maximumKeyword]: upperBound };
        for (const [value, jsonText] of testValues) {
          const expected =
            kind === "inclusive" ? value <= upperBound : value < upperBound;
          assertJsonSchema(schema, value, expected, jsonText);
        }
      }
    }
  });

  test("number_limits_inc_inc", () => {
    checkValues(
      { type: "number", minimum: -100, maximum: 100 },
      [0, -100, 100],
      true,
    );
  });

  test("number_limits_inc_inc_failures", () => {
    checkValues(
      { type: "number", minimum: -100, maximum: 100 },
      [
        [-100.0000001, "-100.0000001"],
        [100.000001, "100.000001"],
        [200, "200.0"],
      ],
      false,
    );
  });

  test("number_limits_excl_inc", () => {
    checkValues(
      { type: "number", exclusiveMinimum: -1, maximum: 100 },
      [0, [-0.999999, "-0.999999"], [-0.01, "-0.01"], 100],
      true,
    );
  });

  test("number_limits_exclu_inc_failures", () => {
    checkValues(
      { type: "number", exclusiveMinimum: -1, maximum: 100 },
      [-1, [-1, "-1.0"], [100.000001, "100.000001"], [200, "200.0"]],
      false,
    );
  });

  test("number_limits_inc_excl", () => {
    checkValues(
      { type: "number", minimum: -100, exclusiveMaximum: -1 },
      [-2, -100, [-1.00001, "-1.00001"], [-1.00001, "-1.00001"]],
      true,
    );
  });

  test("number_limits_inc_excl_failures", () => {
    checkValues(
      { type: "number", minimum: -100, exclusiveMaximum: -1 },
      [
        [-100.0000001, "-100.0000001"],
        -1,
        [-1, "-1.0"],
        [-2.12e6, "-2120000.0"],
        [-4.6e-6, "-0.0000046"],
      ],
      false,
    );
  });

  test("number_limits_incompatible", () => {
    for (const minimumKeyword of ["minimum", "exclusiveMinimum"]) {
      for (const maximumKeyword of ["maximum", "exclusiveMaximum"]) {
        assertJsonSchema(
          { type: "number", [minimumKeyword]: -0.1, [maximumKeyword]: -1 },
          -0.5,
          false,
        );
      }
    }
  });

  test("number_multipleof", () => {
    assertJsonSchema({ type: "number", multipleOf: 3 }, 3.5, false, "3.5");
  });

  test("number_multipleof_noninteger", () => {
    const cases = [
      [-30, false, "-30.0"],
      [0, true, "0.0"],
      [3.5, true, "3.5"],
      [4, false, "4.0"],
      [325.5, true, "325.5"],
      [326.5, false, "326.5"],
    ];
    for (const [value, expected, jsonText] of cases) {
      assertJsonSchema(
        { type: "number", multipleOf: 3.5 },
        value,
        expected,
        jsonText,
      );
    }
  });

  for (const [value, jsonText] of [
    [-35, "-35.0"],
    [-7, "-7.0"],
  ]) {
    test(
      `number_multipleof_noninteger(${jsonText})`,
      { skip: negativeMultipleOfReason },
      () => {
        assertJsonSchema(
          { type: "number", multipleOf: 3.5 },
          value,
          true,
          jsonText,
        );
      },
    );
  }
});

describe("string", () => {
  test("string", () => {
    checkValues(
      { type: "string" },
      [
        "",
        "Hello",
        "123",
        "!@#$%^&*{}()_+",
        "'",
        '"',
        "}",
        "Hello\\nWorld\n            \n            With some extra line breaks etc.\n            ",
      ],
      true,
    );
  });

  test("string_failures", () => {
    checkValues({ type: "string" }, [1, true, null], false);
  });

  test("string_regex", () => {
    checkValues(
      { type: "string", pattern: "a[A-Z]" },
      ["aB", "aC", "aZ"],
      true,
    );
  });

  test("string_regex_failures", () => {
    checkValues(
      { type: "string", pattern: "a[A-Z]" },
      ["aa", "a1", "Hello World!"],
      false,
    );
  });

  test("string_length_many", () => {
    checkValues(
      { type: "string", minLength: 3, maxLength: 5 },
      ["abc", "abcd", "abcde"],
      true,
    );
  });

  test("string_length_many_failures", () => {
    checkValues(
      { type: "string", minLength: 3, maxLength: 5 },
      ["", "ab", "abcdef"],
      false,
    );
  });

  test("string_length_single", () => {
    checkValues(
      { type: "string", minLength: 3, maxLength: 3 },
      ["abc", "def"],
      true,
    );
  });

  test("string_length_single_failures", () => {
    checkValues(
      { type: "string", minLength: 3, maxLength: 3 },
      ["", "ab", "abcd"],
      false,
    );
  });

  test("string_length_empty", () => {
    checkValues({ type: "string", minLength: 0, maxLength: 0 }, [""], true);
  });

  test("string_length_empy_failures", () => {
    checkValues(
      { type: "string", minLength: 0, maxLength: 0 },
      ["a", "abc"],
      false,
    );
  });

  test("string_length_unsatisfiable", () => {
    assertJsonSchema(
      { type: "string", minLength: 2, maxLength: 1 },
      "a",
      false,
    );
  });
});
