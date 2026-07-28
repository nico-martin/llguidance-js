import test from "node:test";

import { assertJsonSchema } from "./helpers.mjs";

const draft = "https://json-schema.org/draft/2020-12/schema";

function checkCases(schema, cases) {
  for (const [value, expected, jsonText] of cases) {
    assertJsonSchema(schema, value, expected, jsonText);
  }
}

test("simple anyOf", () => {
  const schema = { anyOf: [{ type: "integer" }, { type: "boolean" }] };
  checkCases(schema, [
    [42, true],
    [true, true],
  ]);
});

test("simple anyOf failures", () => {
  const schema = { anyOf: [{ type: "integer" }, { type: "boolean" }] };
  checkCases(schema, [
    ["string", false],
    [1.2, false],
    [[1, 2], false],
  ]);
});

test("type as list", () => {
  const schema = { type: ["boolean", "integer"] };
  checkCases(schema, [
    [true, true],
    [42, true],
    ["string", false],
    [[1, 2], false],
  ]);
});

test("simple allOf", () => {
  const schema = {
    $schema: draft,
    allOf: [
      { properties: { foo: { type: "string" } }, required: ["foo"] },
      { properties: { bar: { type: "integer" } }, required: ["bar"] },
    ],
  };
  assertJsonSchema(schema, { foo: "hello", bar: 42 }, true);
});

test("simple allOf failures", () => {
  const schema = {
    $schema: draft,
    allOf: [
      { properties: { foo: { type: "string" } }, required: ["foo"] },
      { properties: { bar: { type: "integer" } }, required: ["bar"] },
    ],
  };
  checkCases(schema, [
    [{ foo: "hello" }, false],
    [{ bar: 42 }, false],
    [{ foo: "hello", bar: "not a number" }, false],
  ]);
});

test("allOf with base schema", () => {
  const schema = {
    $schema: draft,
    properties: { bar: { type: "integer" } },
    required: ["bar"],
    allOf: [
      { properties: { foo: { type: "string" } }, required: ["foo"] },
      { properties: { baz: { type: "null" } }, required: ["baz"] },
    ],
  };
  checkCases(schema, [
    [{ bar: 2, foo: "quux", baz: null }, true],
    [{ foo: "quux", baz: null }, false],
    [{ bar: 2, baz: null }, false],
    [{ bar: 2, foo: "quux" }, false],
    [{ bar: 2 }, false],
  ]);
});

test("allOf simple minimum", () => {
  const cases = [
    [-35, false],
    [0, false],
    [29, false],
    [35, true],
    [381925, true],
  ];
  for (const firstBound of ["minimum", "exclusiveMinimum"]) {
    for (const secondBound of ["minimum", "exclusiveMinimum"]) {
      const schema = {
        $schema: draft,
        allOf: [{ [firstBound]: 30 }, { [secondBound]: 20 }],
      };
      checkCases(schema, cases);
    }
  }
});

test("allOf additionalProperties", () => {
  for (const additionalProperties of [false, true]) {
    const schema = {
      $schema: draft,
      properties: { bar: { type: "integer" } },
      additionalProperties,
    };
    assertJsonSchema(schema, { bar: 2 }, true);
    assertJsonSchema(schema, { bar: 2, foo: "quux" }, additionalProperties);
  }
});

test("allOf multipleOf", () => {
  const schema = {
    $schema: draft,
    allOf: [{ multipleOf: 3 }, { multipleOf: 5 }],
  };
  checkCases(schema, [
    [3, false],
    [5, false],
    [9, false],
    [15, true],
    [20, false],
    [45, true],
  ]);
});

test("allOf string patterns", () => {
  const schema = {
    $schema: draft,
    allOf: [
      { type: "string", pattern: "\\w+" },
      { type: "string", pattern: "\\w?" },
    ],
  };
  checkCases(schema, [
    ["a", true],
    ["b", true],
    ["", false],
    [" ", false],
  ]);
});

test("allOf unsatisfiable false schema", () => {
  for (const otherSchema of [true, false]) {
    assertJsonSchema(
      { $schema: draft, allOf: [otherSchema, false] },
      null,
      false,
    );
  }
});

test("allOf unsatisfiable bounds", () => {
  assertJsonSchema(
    {
      $schema: draft,
      allOf: [
        { type: "integer", minimum: 10 },
        { type: "integer", maximum: 5 },
      ],
    },
    7,
    false,
  );
});

test("anyOf with nested allOf", () => {
  const schema = {
    $schema: draft,
    anyOf: [
      { allOf: [{ type: "string" }, { minLength: 2 }] },
      { allOf: [{ type: "integer" }, { minimum: 2 }] },
    ],
  };
  checkCases(schema, [
    ["a", false],
    ["ab", true],
    [1, false],
    [2, true],
  ]);
});

test("allOf with nested anyOf", () => {
  const schema = {
    $schema: draft,
    allOf: [
      { anyOf: [{ type: "string" }, { minimum: 2 }] },
      { anyOf: [{ type: "integer" }, { minLength: 2 }] },
    ],
  };
  checkCases(schema, [
    ["a", false],
    ["ab", true],
    [1, false],
    [2, true],
  ]);
});

test("anyOf with one unsatisfiable branch", () => {
  const schema = {
    $schema: draft,
    anyOf: [
      {
        allOf: [
          { type: "integer", minimum: 10 },
          { type: "integer", maximum: 5 },
        ],
      },
      { type: "string" },
    ],
  };
  checkCases(schema, [
    ["a", true],
    ["b", true],
    [1, false],
  ]);
});

test("oneOf smoke", () => {
  const schema = {
    $schema: draft,
    oneOf: [{ type: "string" }, { type: "integer" }],
  };
  checkCases(schema, [
    ["a", true],
    ["b", true],
    [1, true],
    [2, true, "2.0"],
  ]);
});

for (const [name, oneOf] of [
  [
    "oneOf containing anyOf",
    [{ type: "string" }, { anyOf: [{ enum: [3, 6, 15, 30] }] }],
  ],
  [
    "oneOf containing anyOf in reverse order",
    [{ anyOf: [{ enum: [3, 6, 15, 30] }] }, { type: "string" }],
  ],
]) {
  test(name, () => {
    checkCases({ $schema: draft, oneOf }, [
      ["a", true],
      ["b", true],
      [1, false],
      [3, true],
    ]);
  });
}

test("anyOf object schema", () => {
  const schema = {
    $schema: draft,
    anyOf: [
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "integer" } },
        required: ["a"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { a: { type: "string" }, c: { type: "number" } },
        required: ["a"],
        additionalProperties: false,
      },
    ],
  };
  checkCases(schema, [
    [{ a: "hello" }, true],
    [{ a: "hello", b: 42 }, true],
    [{ a: "hello", c: 817.2 }, true],
    [{ a: "hello", b: 42, c: 41.3 }, false],
  ]);
});

test("anyOf object schema with additional properties", () => {
  const schema = {
    $schema: draft,
    anyOf: [
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "integer" } },
        required: ["a"],
        additionalProperties: { type: "object" },
      },
      {
        type: "object",
        properties: { a: { type: "string" }, c: { type: "number" } },
        required: ["a"],
        additionalProperties: { type: "array" },
      },
    ],
  };
  checkCases(schema, [
    [{ a: "hello" }, true],
    [{ a: "hello", b: 42 }, true],
    [{ a: "hello", b: 42, another: {} }, true],
    [{ a: "hello", c: 817.2 }, true],
    [{ a: "hello", b: 42, c: 41.3 }, false],
    [{ a: "hello", b: 42, c: 41.3, another: [] }, false],
  ]);
});

test("allOf, anyOf, and oneOf combined", () => {
  const schema = {
    $schema: draft,
    allOf: [{ enum: [2, 6, 10, 30] }],
    anyOf: [{ enum: [3, 6, 15, 30] }],
    oneOf: [{ enum: [5, 10, 15, 30] }],
  };
  for (let value = -35; value <= 35; value += 1) {
    assertJsonSchema(schema, value, value === 30);
  }
});
