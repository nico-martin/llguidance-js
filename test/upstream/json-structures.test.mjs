import test from "node:test";

import { assertJsonSchema } from "./helpers.mjs";

function check(schema, vectors) {
  for (const [value, expected, jsonText] of vectors) {
    assertJsonSchema(schema, value, expected, jsonText);
  }
}

const integerArray = { type: "array", items: { type: "integer" } };

test("array_integer", () => {
  check(integerArray, [
    [[], true],
    [[1], true],
    [[1, 2, 3], true],
  ]);
});

test("array_integer_failures", () => {
  check(integerArray, [
    [[1, "Hello"], false],
    [[true, false], false],
    [[1, 3], true, "[1.0,3.0]"],
  ]);
});

const booleanArray = { type: "array", items: { type: "boolean" } };

test("array_boolean", () => {
  check(booleanArray, [
    [[], true],
    [[true], true],
    [[false], true],
    [[false, true], true],
  ]);
});

test("array_boolean_failures", () => {
  check(booleanArray, [
    [[true, 0], false],
    [[false, 1], false],
    [[1, 0], false, "[1.0,0.0]"],
  ]);
});

const lengthConstrainedArray = {
  type: "array",
  items: { type: "integer" },
  minItems: 2,
  maxItems: 4,
};

test("array_length_constraints", () => {
  check(lengthConstrainedArray, [
    [[1, 2], true],
    [[1, 2, 3], true],
    [[1, 2, 3, 4], true],
  ]);
});

test("array_length_failures", () => {
  check(lengthConstrainedArray, [
    [[], false],
    [[1], false],
    [[1, 2, 3, 4, 5], false],
  ]);
});

test("array_length_bad_constraints", () => {
  assertJsonSchema(
    { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 1 },
    [1],
    false,
  );
});

const nestedArray = {
  type: "array",
  items: { type: "array", items: { type: "integer" } },
};

test("nested_array", () => {
  check(nestedArray, [
    [[], true],
    [[[1]], true],
    [[[1], []], true],
    [[[], [1]], true],
    [
      [
        [1, 2],
        [3, 4],
      ],
      true,
    ],
    [[[0], [1, 2, 3]], true],
    [[[0], [1, 2, 3], [4, 5]], true],
  ]);
});

test("nested_array_failures", () => {
  check(nestedArray, [
    [[[1, "Hello"]], false],
    [[[true, false]], false],
    [[[1, 2]], true, "[[1.0,2.0]]"],
    [[[1], [2]], true, "[[1],[2.0]]"],
  ]);
});

const arrayOfObjects = {
  type: "array",
  items: {
    type: "object",
    properties: { a: { type: "integer" } },
    required: ["a"],
  },
};

test("array_of_objects", () => {
  check(arrayOfObjects, [
    [[], true],
    [[{ a: 1 }], true],
    [[{ a: 1 }, { a: 2 }], true],
  ]);
});

test("array_of_objects_failures", () => {
  check(arrayOfObjects, [
    [[{ b: 1 }], false],
    [[{ a: "Hello" }], false],
    [[{ a: 1 }, { b: 2 }], false],
  ]);
});

const simplePrefixedArray = {
  type: "array",
  prefixItems: [{ type: "string" }, { type: "number" }],
  items: { type: "boolean" },
};

test("array_with_prefix_items", () => {
  check(simplePrefixedArray, [
    [["Hello", 42], true],
    [["Cruel", 817.2, true], true],
    [["World", 41.3, false, true, false], true],
  ]);
});

test("array_with_prefix_items_failures", () => {
  check(simplePrefixedArray, [
    [[41.3], false],
    [["Hello", 42, 41.3], false],
    [["Hello", 42, true, "Not a boolean"], false],
  ]);
});

const simplePrefixedArrayFixed = {
  type: "array",
  prefixItems: [{ type: "string" }, { type: "number" }],
  items: false,
};

test("array_with_prefix_items_fixed", () => {
  check(simplePrefixedArrayFixed, [
    [["A"], true],
    [["B", 42], true],
  ]);
});

test("array_with_prefix_items_fixed_failures", () => {
  check(simplePrefixedArrayFixed, [
    [["Hello", 42, true], false],
    [[41.3], false],
  ]);
});

const simplePrefixedArrayLengthConstrained = {
  type: "array",
  prefixItems: [{ type: "string" }, { type: "number" }],
  items: { type: "boolean" },
  minItems: 2,
  maxItems: 4,
};

test("array_with_prefix_items_length_constrained", () => {
  check(simplePrefixedArrayLengthConstrained, [
    [["Hello", 3.13], true],
    [["World", 817.2, false], true],
    [["Test", 1, true, false], true, '["Test",1.0,true,false]'],
  ]);
});

test("array_with_prefix_items_length_constrained_failures", () => {
  check(simplePrefixedArrayLengthConstrained, [
    [["Hello"], false],
    [["Hello", 41.3, false, true, true], false],
    [[817.2, false], false],
  ]);
});

const singlePropertySchema = {
  type: "object",
  properties: { a: { type: "integer" } },
  required: ["a"],
};

test("single_property", () => {
  check(singlePropertySchema, [
    [{ a: 123 }, true],
    [{ a: 0 }, true],
  ]);
});

test("single_property_failures", () => {
  check(singlePropertySchema, [
    [{ a: "Hello" }, false],
    [{ b: 0 }, false],
  ]);
});

const multiplePropertySchema = {
  type: "object",
  properties: { a: { type: "integer" }, b: { type: "string" } },
  required: ["a", "b"],
};

test("multiple_properties", () => {
  check(multiplePropertySchema, [
    [{ a: 123, b: "Hello" }, true],
    [{ a: 0, b: "World" }, true],
  ]);
});

test("multiple_properties_failures", () => {
  check(multiplePropertySchema, [
    [{ a: 123 }, false],
    [{ b: "Hello" }, false],
    [{ c: 1 }, false],
  ]);
});

const nestedSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    info: {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
    },
  },
  required: ["name", "info"],
};

test("nested", () => {
  check(nestedSchema, [[{ name: "Test", info: { a: 123, b: 456 } }, true]]);
});

test("nested_failures", () => {
  check(nestedSchema, [
    [{ name: "Test", info: { a: 123 } }, false],
    [{ name: "Test", info: { a: "123", b: 20 } }, false],
    [{ name: "Test", info: { a: 123, b: "456" } }, false],
    [{ name: "Test", info: { b: 456 } }, false],
    [{ name: "Test", info: { c: 1 } }, false],
  ]);
});

const objectWithArray = {
  type: "object",
  properties: {
    name: { type: "string" },
    values: { type: "array", items: { type: "integer" } },
  },
  required: ["name", "values"],
};

test("object_with_array", () => {
  check(objectWithArray, [[{ name: "Test", values: [1, 2, 3] }, true]]);
});

test("object_with_array_failures", () => {
  check(objectWithArray, [
    [{ name: "Test", values: [1, 2, "Hello"] }, false],
    [
      { name: "Test", values: [1, 2] },
      true,
      '{"name":"Test","values":[1.0,2.0]}',
    ],
    [{ name: "Test" }, false],
    [{ values: [1, 2, 3] }, false],
  ]);
});

const falseProperty = {
  type: "object",
  properties: { a: { type: "integer" }, b: false },
  additionalProperties: false,
};

test("object_false_property", () => {
  check(falseProperty, [[{ a: 42 }, true]]);
});

test("object_false_property_failures", () => {
  check(falseProperty, [[{ a: 42, b: 43 }, false]]);
});

test("object_unsatisfiable_schema", () => {
  const schemas = [
    {
      type: "object",
      properties: { a: { type: "integer" }, b: false },
      required: ["b"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { a: { type: "integer" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
  ];

  for (const schema of schemas) {
    assertJsonSchema(schema, {}, false);
  }
});

const linkedList = {
  $defs: {
    A: {
      properties: {
        my_str: { default: "me", title: "My Str", type: "string" },
        next: { anyOf: [{ $ref: "#/$defs/A" }, { type: "null" }] },
      },
      required: ["my_str", "next"],
      type: "object",
    },
  },
  type: "object",
  properties: {
    my_list: { anyOf: [{ $ref: "#/$defs/A" }, { type: "null" }] },
  },
  required: ["my_list"],
};

test("linked_list", () => {
  check(linkedList, [
    [{ my_list: null }, true],
    [{ my_list: { my_str: "first", next: null } }, true],
    [
      { my_list: { my_str: "first", next: { my_str: "second", next: null } } },
      true,
    ],
    [
      {
        my_list: {
          my_str: "first",
          next: {
            my_str: "second",
            next: { my_str: "third", next: null },
          },
        },
      },
      true,
    ],
  ]);
});

test("linked_list_failures", () => {
  check(linkedList, [
    [{ my_list: { my_str: 1 } }, false],
    [{ my_list: { my_str: "first", next: "second" } }, false],
  ]);
});

test("const_null", () => {
  check({ type: "null", const: null }, [[null, true]]);
});

test("const_boolean", () => {
  check({ type: "boolean", const: false }, [
    [true, false],
    [false, true],
  ]);
});

test("const_object", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    const: { name: "John", age: 42 },
  };
  check(schema, [
    [{ name: "John", age: 42 }, true],
    [{ name: "Jane", age: 42 }, false],
    [{ name: "John", age: 52 }, false],
    [{ name: "John", age: 42, location: "USA" }, false],
  ]);
});

test("const_property", () => {
  const schema = { properties: { country: { const: "US" } } };
  check(schema, [
    [{ country: "US" }, true],
    [{ country: "CA" }, false],
  ]);
});

test("const_array", () => {
  const schema = { type: "array", const: [10, 20] };
  check(schema, [
    [[10], false],
    [[10, 20], true],
    [[10, 20, 30], false],
    [[10, "a"], false],
  ]);
});

test("array_with_const_prefix", () => {
  const schema = {
    type: "array",
    prefixItems: [{ const: 2 }, { const: 3 }],
    items: { type: "boolean" },
  };
  check(schema, [
    [[2, 1], false],
    [[2, 3], true],
    [[2, 3, true, false], true],
    [[2, 3, 1], false],
  ]);
});

test("enum_check", () => {
  const schema = { enum: [6, 9, 13] };
  check(schema, [
    [6, true],
    [9, true],
    [13, true],
    [42, false],
  ]);
});
