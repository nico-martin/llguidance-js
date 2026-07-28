/** A dependency-free JSON prefix parser and pragmatic JSON Schema validator. */

export type JsonPrefixStatus = "invalid" | "incomplete" | "complete";

export interface JsonPrefixResult {
  status: JsonPrefixStatus;
  /** Syntax-prefix viability; complete documents also include schema validity. */
  viable: boolean;
  /** True only for a complete document accepted by the schema. */
  accepted: boolean;
  /** Present for syntactically complete documents, including schema failures. */
  value?: unknown;
  errors: string[];
  /** Character offset for a syntax error, when available. */
  position?: number;
}

export interface JsonPrefixState {
  readonly text: string;
  readonly result: JsonPrefixResult;
}

export interface JsonUtf8PrefixState {
  readonly bytes: Uint8Array;
  readonly result: JsonPrefixResult;
}

export interface CompiledJsonSchema {
  readonly initial: JsonPrefixState;
  readonly initialUtf8: JsonUtf8PrefixState;
  analyzeText(text: string): JsonPrefixResult;
  analyzeUtf8(bytes: Uint8Array | readonly number[]): JsonPrefixResult;
  isTextPrefixViable(text: string): boolean;
  isUtf8PrefixViable(bytes: Uint8Array | readonly number[]): boolean;
  acceptsText(text: string): boolean;
  acceptsUtf8(bytes: Uint8Array | readonly number[]): boolean;
  append(state: JsonPrefixState, text: string): JsonPrefixState;
  appendUtf8(
    state: JsonUtf8PrefixState,
    bytes: Uint8Array,
  ): JsonUtf8PrefixState;
  viable(state: JsonUtf8PrefixState): boolean;
  accepting(state: JsonUtf8PrefixState): boolean;
  finish(state: JsonPrefixState): boolean;
}

export interface JsonSchemaCompileOptions {
  maxSchemaDepth?: number;
  maxJsonDepth?: number;
}

export class JsonSchemaCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSchemaCompileError";
  }
}

type JsonNode =
  | { kind: "null"; value: null }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number; raw: string }
  | { kind: "string"; value: string }
  | { kind: "array"; value: unknown[]; items: JsonNode[] }
  | {
      kind: "object";
      value: Record<string, unknown>;
      entries: Array<{ key: string; node: JsonNode }>;
    };

type Schema = boolean | Record<string, unknown>;

interface Guidance {
  itemSeparator: string;
  keySeparator: string;
  whitespaceFlexible: boolean;
}

class ParseFailure extends Error {
  readonly incomplete: boolean;
  readonly position: number;

  constructor(incomplete: boolean, position: number, message: string) {
    super(message);
    this.incomplete = incomplete;
    this.position = position;
  }
}

class JsonParser {
  private position = 0;
  private readonly input: string;
  private readonly guidance: Guidance;
  private readonly maxDepth: number;

  constructor(input: string, guidance: Guidance, maxDepth: number) {
    this.input = input;
    this.guidance = guidance;
    this.maxDepth = maxDepth;
  }

  parse(): JsonNode {
    if (/^[\u0009\u000a\u000d\u0020]$/.test(this.input[0] ?? "")) {
      this.invalid("Initial JSON whitespace is not allowed");
    }
    const node = this.value(0);
    this.space();
    if (this.position !== this.input.length) {
      this.invalid("Unexpected content after the JSON document");
    }
    return node;
  }

  private value(depth: number): JsonNode {
    if (depth > this.maxDepth) {
      this.invalid(`JSON nesting exceeds maxJsonDepth (${this.maxDepth})`);
    }
    this.space();
    if (this.position === this.input.length)
      this.missing("Expected a JSON value");
    const character = this.input[this.position];
    if (character === '"') return this.string();
    if (character === "[") return this.array(depth);
    if (character === "{") return this.object(depth);
    if (character === "t") return this.literal("true", true);
    if (character === "f") return this.literal("false", false);
    if (character === "n") return this.literal("null", null);
    if (character === "-" || this.isDigit(character)) return this.number();
    return this.invalid(`Unexpected character ${JSON.stringify(character)}`);
  }

  private literal(
    text: "true" | "false" | "null",
    value: boolean | null,
  ): JsonNode {
    for (let index = 0; index < text.length; index += 1) {
      if (this.position + index >= this.input.length) {
        this.missing(`Incomplete ${text} literal`);
      }
      if (this.input[this.position + index] !== text[index]) {
        this.invalid(`Invalid ${text} literal`, this.position + index);
      }
    }
    this.position += text.length;
    return value === null
      ? { kind: "null", value }
      : { kind: "boolean", value };
  }

  private string(): Extract<JsonNode, { kind: "string" }> {
    this.position += 1;
    let value = "";
    while (this.position < this.input.length) {
      const character = this.input[this.position++];
      if (character === '"') return { kind: "string", value };
      if (character === "\\") {
        if (this.position === this.input.length)
          this.missing("Incomplete string escape");
        const escape = this.input[this.position++];
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (Object.prototype.hasOwnProperty.call(simple, escape)) {
          value += simple[escape];
          continue;
        }
        if (escape !== "u") this.invalid(`Invalid string escape \\${escape}`);
        let hexadecimal = "";
        for (let index = 0; index < 4; index += 1) {
          if (this.position === this.input.length)
            this.missing("Incomplete Unicode escape");
          const digit = this.input[this.position++];
          if (!/[0-9a-fA-F]/.test(digit))
            this.invalid("Invalid Unicode escape", this.position - 1);
          hexadecimal += digit;
        }
        value += String.fromCharCode(Number.parseInt(hexadecimal, 16));
        continue;
      }
      if (character.charCodeAt(0) < 0x20)
        this.invalid(
          "Unescaped control character in string",
          this.position - 1,
        );
      value += character;
    }
    return this.missing("Unterminated string");
  }

  private number(): Extract<JsonNode, { kind: "number" }> {
    const start = this.position;
    if (this.input[this.position] === "-") {
      this.position += 1;
      if (this.position === this.input.length)
        this.missing("Incomplete number");
    }
    if (this.input[this.position] === "0") {
      this.position += 1;
      if (
        this.position < this.input.length &&
        this.isDigit(this.input[this.position])
      ) {
        this.invalid("Leading zero in number");
      }
    } else {
      if (!this.isNonZeroDigit(this.input[this.position]))
        this.invalid("Invalid number");
      while (
        this.position < this.input.length &&
        this.isDigit(this.input[this.position])
      )
        this.position += 1;
    }
    if (this.input[this.position] === ".") {
      this.position += 1;
      if (this.position === this.input.length)
        this.missing("Incomplete fractional number");
      if (!this.isDigit(this.input[this.position]))
        this.invalid("Expected digit after decimal point");
      while (
        this.position < this.input.length &&
        this.isDigit(this.input[this.position])
      )
        this.position += 1;
    }
    if (
      this.input[this.position] === "e" ||
      this.input[this.position] === "E"
    ) {
      this.position += 1;
      if (this.position === this.input.length)
        this.missing("Incomplete exponent");
      if (
        this.input[this.position] === "+" ||
        this.input[this.position] === "-"
      ) {
        this.position += 1;
        if (this.position === this.input.length)
          this.missing("Incomplete exponent");
      }
      if (!this.isDigit(this.input[this.position]))
        this.invalid("Expected digit in exponent");
      while (
        this.position < this.input.length &&
        this.isDigit(this.input[this.position])
      )
        this.position += 1;
    }
    const raw = this.input.slice(start, this.position);
    return { kind: "number", value: Number(raw), raw };
  }

  private array(depth: number): Extract<JsonNode, { kind: "array" }> {
    this.position += 1;
    this.space();
    const items: JsonNode[] = [];
    if (this.take("]")) return { kind: "array", value: [], items };
    while (true) {
      items.push(this.value(depth + 1));
      this.space();
      if (this.take("]")) break;
      this.separator(this.guidance.itemSeparator, "array item separator");
      this.space();
      if (this.position === this.input.length)
        this.missing("Expected another array item");
    }
    return { kind: "array", value: items.map((item) => item.value), items };
  }

  private object(depth: number): Extract<JsonNode, { kind: "object" }> {
    this.position += 1;
    this.space();
    const entries: Array<{ key: string; node: JsonNode }> = [];
    const value: Record<string, unknown> = {};
    if (this.take("}")) return { kind: "object", value, entries };
    while (true) {
      if (this.position === this.input.length)
        this.missing("Expected an object property name");
      if (this.input[this.position] !== '"')
        this.invalid("Object property names must be strings");
      const key = this.string().value;
      this.space();
      this.separator(this.guidance.keySeparator, "object key separator");
      const node = this.value(depth + 1);
      entries.push({ key, node });
      Object.defineProperty(value, key, {
        value: node.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.space();
      if (this.take("}")) break;
      this.separator(this.guidance.itemSeparator, "object item separator");
      this.space();
      if (this.position === this.input.length)
        this.missing("Expected another object property");
    }
    return { kind: "object", value, entries };
  }

  private separator(separator: string, name: string): void {
    for (let index = 0; index < separator.length; index += 1) {
      if (this.position + index >= this.input.length)
        this.missing(`Incomplete ${name}`);
      if (this.input[this.position + index] !== separator[index]) {
        this.invalid(
          `Expected ${name} ${JSON.stringify(separator)}`,
          this.position + index,
        );
      }
    }
    this.position += separator.length;
  }

  private take(text: string): boolean {
    if (this.input.startsWith(text, this.position)) {
      this.position += text.length;
      return true;
    }
    return false;
  }

  private space(): void {
    if (!this.guidance.whitespaceFlexible) return;
    while (/^[\u0009\u000a\u000d\u0020]$/.test(this.input[this.position] ?? ""))
      this.position += 1;
  }

  private isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= "0" && value <= "9";
  }

  private isNonZeroDigit(value: string | undefined): boolean {
    return value !== undefined && value >= "1" && value <= "9";
  }

  private invalid(message: string, position = this.position): never {
    throw new ParseFailure(false, position, message);
  }

  private missing(message: string): never {
    throw new ParseFailure(true, this.position, message);
  }
}

const annotationKeywords = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
]);

const validationKeywords = new Set([
  "$ref",
  "$defs",
  "definitions",
  "type",
  "const",
  "enum",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "prefixItems",
  "items",
  "additionalItems",
  "contains",
  "minContains",
  "maxContains",
  "uniqueItems",
  "properties",
  "patternProperties",
  "propertyNames",
  "required",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "anyOf",
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "x-guidance",
]);

const jsonTypes = new Set([
  "null",
  "boolean",
  "integer",
  "number",
  "string",
  "array",
  "object",
]);
function unicodeRegExp(pattern: string): RegExp {
  return new RegExp(pattern, "u");
}

function schemaObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonSchemaCompileError(
      `${path} must be a boolean or object schema`,
    );
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new JsonSchemaCompileError(`${path} must be a finite number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new JsonSchemaCompileError(`${path} must be a non-negative integer`);
  }
  return value;
}

interface Decimal {
  coefficient: bigint;
  exponent: bigint;
}

function decimalFromRaw(raw: string): Decimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) throw new Error(`Invalid JSON number ${JSON.stringify(raw)}`);
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (digits === "") return { coefficient: 0n, exponent: 0n };
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailing) digits = digits.slice(0, -trailing);
  const coefficient = BigInt(`${match[1]}${digits}`);
  const exponent =
    BigInt(match[4] ?? "0") - BigInt(fraction.length) + BigInt(trailing);
  return { coefficient, exponent };
}

function decimalFromSchemaNumber(value: number): Decimal {
  return decimalFromRaw(String(value));
}

function compareDecimals(left: Decimal, right: Decimal): number {
  if (
    left.coefficient === right.coefficient &&
    left.exponent === right.exponent
  )
    return 0;
  if (left.coefficient < 0n && right.coefficient >= 0n) return -1;
  if (left.coefficient >= 0n && right.coefficient < 0n) return 1;
  const negative = left.coefficient < 0n;
  const leftCoefficient =
    left.coefficient < 0n ? -left.coefficient : left.coefficient;
  const rightCoefficient =
    right.coefficient < 0n ? -right.coefficient : right.coefficient;
  if (leftCoefficient === 0n || rightCoefficient === 0n) {
    const result =
      leftCoefficient === rightCoefficient
        ? 0
        : leftCoefficient === 0n
          ? -1
          : 1;
    return negative ? -result : result;
  }
  const leftMagnitude =
    BigInt(leftCoefficient.toString().length) + left.exponent;
  const rightMagnitude =
    BigInt(rightCoefficient.toString().length) + right.exponent;
  if (leftMagnitude !== rightMagnitude) {
    const result = leftMagnitude < rightMagnitude ? -1 : 1;
    return negative ? -result : result;
  }
  const exponent =
    left.exponent < right.exponent ? left.exponent : right.exponent;
  const scaledLeft = leftCoefficient * 10n ** (left.exponent - exponent);
  const scaledRight = rightCoefficient * 10n ** (right.exponent - exponent);
  const result =
    scaledLeft < scaledRight ? -1 : scaledLeft > scaledRight ? 1 : 0;
  return negative ? -result : result;
}

function decimalIsInteger(value: Decimal): boolean {
  return value.coefficient === 0n || value.exponent >= 0n;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

function factorCount(value: bigint, factor: bigint): bigint {
  let count = 0n;
  while (value % factor === 0n) {
    value /= factor;
    count += 1n;
  }
  return count;
}

function decimalIsMultiple(value: Decimal, divisor: Decimal): boolean {
  if (value.coefficient === 0n) return true;
  let numerator =
    value.coefficient < 0n ? -value.coefficient : value.coefficient;
  let denominator =
    divisor.coefficient < 0n ? -divisor.coefficient : divisor.coefficient;
  const common = greatestCommonDivisor(numerator, denominator);
  numerator /= common;
  denominator /= common;
  const exponent = value.exponent - divisor.exponent;
  if (exponent >= 0n) {
    const twos = factorCount(denominator, 2n);
    const fives = factorCount(denominator, 5n);
    denominator /= 2n ** twos * 5n ** fives;
    return denominator === 1n && twos <= exponent && fives <= exponent;
  }
  if (denominator !== 1n) return false;
  const places = -exponent;
  return (
    factorCount(numerator, 2n) >= places && factorCount(numerator, 5n) >= places
  );
}

function compileChecks(root: Schema): Map<string, Schema> {
  const references = new Map<string, Schema>();
  references.set("#", root);
  const seen = new Set<object>();

  const resolveReference = (reference: string, path: string): Schema => {
    if (!reference.startsWith("#")) {
      throw new JsonSchemaCompileError(
        `${path}: external references are not supported: ${JSON.stringify(reference)}`,
      );
    }
    let fragment: string;
    try {
      fragment = decodeURIComponent(reference.slice(1));
    } catch {
      throw new JsonSchemaCompileError(`${path}: invalid URI fragment in $ref`);
    }
    if (fragment === "") return root;
    if (!fragment.startsWith("/")) {
      throw new JsonSchemaCompileError(
        `${path}: local $ref must contain a JSON Pointer`,
      );
    }
    let current: unknown = root;
    for (const encoded of fragment.slice(1).split("/")) {
      if (/~(?:[^01]|$)/.test(encoded)) {
        throw new JsonSchemaCompileError(
          `${path}: invalid JSON Pointer escape`,
        );
      }
      const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
      if (
        current === null ||
        typeof current !== "object" ||
        !Object.prototype.hasOwnProperty.call(current, segment)
      ) {
        throw new JsonSchemaCompileError(
          `${path} does not resolve: ${JSON.stringify(reference)}`,
        );
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (
      typeof current !== "boolean" &&
      (current === null ||
        typeof current !== "object" ||
        Array.isArray(current))
    ) {
      throw new JsonSchemaCompileError(
        `${path} does not resolve to a schema: ${JSON.stringify(reference)}`,
      );
    }
    return current as Schema;
  };

  const visit = (candidate: unknown, path: string): void => {
    if (typeof candidate === "boolean") return;
    const schema = schemaObject(candidate, path);
    if (seen.has(schema)) return;
    seen.add(schema);
    for (const keyword of Object.keys(schema)) {
      if (
        !validationKeywords.has(keyword) &&
        !annotationKeywords.has(keyword)
      ) {
        throw new JsonSchemaCompileError(
          `${path}: unsupported schema keyword ${JSON.stringify(keyword)}`,
        );
      }
    }

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (
        types.length === 0 ||
        types.some((type) => typeof type !== "string" || !jsonTypes.has(type))
      ) {
        throw new JsonSchemaCompileError(
          `${path}.type must contain supported JSON Schema types`,
        );
      }
      if (new Set(types).size !== types.length)
        throw new JsonSchemaCompileError(`${path}.type contains duplicates`);
    }
    if (
      schema.enum !== undefined &&
      (!Array.isArray(schema.enum) || schema.enum.length === 0)
    ) {
      throw new JsonSchemaCompileError(
        `${path}.enum must be a non-empty array`,
      );
    }
    for (const keyword of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
    ] as const) {
      if (schema[keyword] !== undefined)
        finiteNumber(schema[keyword], `${path}.${keyword}`);
    }
    if (
      schema.multipleOf !== undefined &&
      finiteNumber(schema.multipleOf, `${path}.multipleOf`) <= 0
    ) {
      throw new JsonSchemaCompileError(
        `${path}.multipleOf must be greater than zero`,
      );
    }
    for (const keyword of [
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "minContains",
      "maxContains",
      "minProperties",
      "maxProperties",
    ] as const) {
      if (schema[keyword] !== undefined)
        nonNegativeInteger(schema[keyword], `${path}.${keyword}`);
    }
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string")
        throw new JsonSchemaCompileError(`${path}.pattern must be a string`);
      try {
        unicodeRegExp(schema.pattern);
      } catch (error) {
        throw new JsonSchemaCompileError(
          `${path}.pattern is not a valid JavaScript RegExp: ${String(error)}`,
        );
      }
    }
    if (schema.format !== undefined && typeof schema.format !== "string")
      throw new JsonSchemaCompileError(`${path}.format must be a string`);
    if (schema.required !== undefined) {
      if (
        !Array.isArray(schema.required) ||
        schema.required.some((key) => typeof key !== "string")
      ) {
        throw new JsonSchemaCompileError(
          `${path}.required must be an array of strings`,
        );
      }
      if (new Set(schema.required).size !== schema.required.length) {
        throw new JsonSchemaCompileError(
          `${path}.required contains duplicates`,
        );
      }
    }
    if (
      schema.uniqueItems !== undefined &&
      typeof schema.uniqueItems !== "boolean"
    ) {
      throw new JsonSchemaCompileError(`${path}.uniqueItems must be a boolean`);
    }

    if (schema.properties !== undefined) {
      const properties = schemaObject(schema.properties, `${path}.properties`);
      for (const [key, child] of Object.entries(properties))
        visit(child, `${path}.properties[${JSON.stringify(key)}]`);
    }
    if (schema.patternProperties !== undefined) {
      const patterns = schemaObject(
        schema.patternProperties,
        `${path}.patternProperties`,
      );
      for (const [pattern, child] of Object.entries(patterns)) {
        try {
          unicodeRegExp(pattern);
        } catch (error) {
          throw new JsonSchemaCompileError(
            `${path}.patternProperties contains invalid JavaScript RegExp ${JSON.stringify(pattern)}: ${String(error)}`,
          );
        }
        visit(child, `${path}.patternProperties[${JSON.stringify(pattern)}]`);
      }
    }
    if (schema.propertyNames !== undefined)
      visit(schema.propertyNames, `${path}.propertyNames`);
    if (schema.additionalProperties !== undefined)
      visit(schema.additionalProperties, `${path}.additionalProperties`);
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        schema.items.forEach((child, index) =>
          visit(child, `${path}.items[${index}]`),
        );
      } else {
        visit(schema.items, `${path}.items`);
      }
    }
    if (schema.additionalItems !== undefined)
      visit(schema.additionalItems, `${path}.additionalItems`);
    if (schema.contains !== undefined)
      visit(schema.contains, `${path}.contains`);
    if (schema.prefixItems !== undefined) {
      if (!Array.isArray(schema.prefixItems))
        throw new JsonSchemaCompileError(
          `${path}.prefixItems must be an array`,
        );
      schema.prefixItems.forEach((child, index) =>
        visit(child, `${path}.prefixItems[${index}]`),
      );
    }
    for (const keyword of ["anyOf", "allOf", "oneOf"] as const) {
      if (schema[keyword] !== undefined) {
        if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) {
          throw new JsonSchemaCompileError(
            `${path}.${keyword} must be a non-empty array`,
          );
        }
        schema[keyword].forEach((child, index) =>
          visit(child, `${path}.${keyword}[${index}]`),
        );
      }
    }
    for (const keyword of ["not", "if", "then", "else"] as const)
      if (schema[keyword] !== undefined)
        visit(schema[keyword], `${path}.${keyword}`);
    if (schema.dependentRequired !== undefined) {
      const dependencies = schemaObject(
        schema.dependentRequired,
        `${path}.dependentRequired`,
      );
      for (const [key, dependency] of Object.entries(dependencies)) {
        if (
          !Array.isArray(dependency) ||
          dependency.some((name) => typeof name !== "string")
        ) {
          throw new JsonSchemaCompileError(
            `${path}.dependentRequired[${JSON.stringify(key)}] must be an array of strings`,
          );
        }
        if (new Set(dependency).size !== dependency.length) {
          throw new JsonSchemaCompileError(
            `${path}.dependentRequired[${JSON.stringify(key)}] contains duplicates`,
          );
        }
      }
    }
    if (schema.dependentSchemas !== undefined) {
      const dependencies = schemaObject(
        schema.dependentSchemas,
        `${path}.dependentSchemas`,
      );
      for (const [key, child] of Object.entries(dependencies))
        visit(child, `${path}.dependentSchemas[${JSON.stringify(key)}]`);
    }
    if (schema.dependencies !== undefined) {
      const dependencies = schemaObject(
        schema.dependencies,
        `${path}.dependencies`,
      );
      for (const [key, dependency] of Object.entries(dependencies)) {
        if (Array.isArray(dependency)) {
          if (dependency.some((name) => typeof name !== "string")) {
            throw new JsonSchemaCompileError(
              `${path}.dependencies[${JSON.stringify(key)}] must be a schema or array of strings`,
            );
          }
          if (new Set(dependency).size !== dependency.length) {
            throw new JsonSchemaCompileError(
              `${path}.dependencies[${JSON.stringify(key)}] contains duplicates`,
            );
          }
        } else {
          visit(dependency, `${path}.dependencies[${JSON.stringify(key)}]`);
        }
      }
    }
    if (schema.$defs !== undefined) {
      const definitions = schemaObject(schema.$defs, `${path}.$defs`);
      for (const [name, child] of Object.entries(definitions)) {
        visit(child, `${path}.$defs[${JSON.stringify(name)}]`);
      }
    }
    if (schema.definitions !== undefined) {
      const definitions = schemaObject(
        schema.definitions,
        `${path}.definitions`,
      );
      for (const [name, child] of Object.entries(definitions)) {
        visit(child, `${path}.definitions[${JSON.stringify(name)}]`);
      }
    }
    if (schema.$ref !== undefined && typeof schema.$ref !== "string") {
      throw new JsonSchemaCompileError(`${path}.$ref must be a string`);
    }
    if (typeof schema.$ref === "string")
      references.set(
        schema.$ref,
        resolveReference(schema.$ref, `${path}.$ref`),
      );
    if (schema["x-guidance"] !== undefined && path !== "schema") {
      throw new JsonSchemaCompileError(
        `${path}.x-guidance is unsupported: parsing guidance must be declared on the root schema`,
      );
    }
    if (schema["x-guidance"] !== undefined)
      checkGuidance(schema["x-guidance"], `${path}.x-guidance`);
  };

  visit(root, "schema");
  return references;
}

function checkGuidance(value: unknown, path: string): void {
  const guidance = schemaObject(value, path);
  const supported = new Set([
    "item_separator",
    "key_separator",
    "whitespace_flexible",
  ]);
  for (const key of Object.keys(guidance))
    if (!supported.has(key))
      throw new JsonSchemaCompileError(
        `${path}: unsupported option ${JSON.stringify(key)}`,
      );
  for (const key of ["item_separator", "key_separator"] as const) {
    if (
      guidance[key] !== undefined &&
      (typeof guidance[key] !== "string" || guidance[key].length === 0)
    ) {
      throw new JsonSchemaCompileError(
        `${path}.${key} must be a non-empty string`,
      );
    }
  }
  if (
    guidance.whitespace_flexible !== undefined &&
    typeof guidance.whitespace_flexible !== "boolean"
  ) {
    throw new JsonSchemaCompileError(
      `${path}.whitespace_flexible must be a boolean`,
    );
  }
}

function guidanceFor(root: Schema): Guidance {
  const extension =
    typeof root === "object" && root !== null
      ? (root["x-guidance"] as Record<string, unknown> | undefined)
      : undefined;
  return {
    itemSeparator: (extension?.item_separator as string | undefined) ?? ",",
    keySeparator: (extension?.key_separator as string | undefined) ?? ":",
    whitespaceFlexible:
      (extension?.whitespace_flexible as boolean | undefined) ?? true,
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number")
    return Object.is(left, right) || left === right;
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        deepEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

function nodeEquals(node: JsonNode, value: unknown): boolean {
  if (node.kind === "number")
    return (
      typeof value === "number" &&
      compareDecimals(
        decimalFromRaw(node.raw),
        decimalFromSchemaNumber(value),
      ) === 0
    );
  if (node.kind === "array")
    return (
      Array.isArray(value) &&
      node.items.length === value.length &&
      node.items.every((item, index) => nodeEquals(item, value[index]))
    );
  if (node.kind === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return false;
    const entries = new Map(
      node.entries.map((entry) => [entry.key, entry.node]),
    );
    const keys = Object.keys(value);
    return (
      entries.size === keys.length &&
      keys.every((key) => {
        const child = entries.get(key);
        return (
          child !== undefined &&
          nodeEquals(child, (value as Record<string, unknown>)[key])
        );
      })
    );
  }
  return deepEqual(node.value, value);
}

function nodesEqual(left: JsonNode, right: JsonNode): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "number" && right.kind === "number")
    return (
      compareDecimals(decimalFromRaw(left.raw), decimalFromRaw(right.raw)) === 0
    );
  if (left.kind === "array" && right.kind === "array")
    return (
      left.items.length === right.items.length &&
      left.items.every((item, index) => nodesEqual(item, right.items[index]))
    );
  if (left.kind === "object" && right.kind === "object") {
    const leftEntries = new Map(
      left.entries.map(({ key, node }) => [key, node]),
    );
    const rightEntries = new Map(
      right.entries.map(({ key, node }) => [key, node]),
    );
    return (
      leftEntries.size === rightEntries.size &&
      [...leftEntries].every(([key, node]) => {
        const other = rightEntries.get(key);
        return other !== undefined && nodesEqual(node, other);
      })
    );
  }
  return deepEqual(left.value, right.value);
}

function typeMatches(type: string, node: JsonNode): boolean {
  if (type === "integer")
    return node.kind === "number" && decimalIsInteger(decimalFromRaw(node.raw));
  if (type === "number") return node.kind === "number";
  return node.kind === type;
}

function validateDocument(
  root: Schema,
  node: JsonNode,
  references: Map<string, Schema>,
): string[] {
  const active = new Map<object, Set<JsonNode>>();
  const validate = (
    candidate: Schema,
    current: JsonNode,
    path: string,
  ): string[] => {
    if (candidate === true) return [];
    if (candidate === false) return [`${path}: rejected by false schema`];
    let nodes = active.get(candidate);
    if (nodes?.has(current)) return [];
    if (!nodes) {
      nodes = new Set();
      active.set(candidate, nodes);
    }
    nodes.add(current);
    const errors: string[] = [];
    try {
      if (typeof candidate.$ref === "string")
        errors.push(
          ...validate(references.get(candidate.$ref)!, current, path),
        );
      if (candidate.type !== undefined) {
        const types = (
          Array.isArray(candidate.type) ? candidate.type : [candidate.type]
        ) as string[];
        if (!types.some((type) => typeMatches(type, current)))
          errors.push(`${path}: expected type ${types.join(" or ")}`);
      }
      if (
        candidate.const !== undefined &&
        !nodeEquals(current, candidate.const)
      )
        errors.push(`${path}: does not equal const`);
      if (
        Array.isArray(candidate.enum) &&
        !candidate.enum.some((value) => nodeEquals(current, value))
      )
        errors.push(`${path}: is not in enum`);

      if (current.kind === "number")
        validateNumber(candidate, current.raw, path, errors);
      if (current.kind === "string")
        validateString(candidate, current.value, path, errors);
      if (current.kind === "array")
        validateArray(candidate, current, path, errors, validate);
      if (current.kind === "object")
        validateObject(candidate, current, path, errors, validate);

      if (candidate.not !== undefined) {
        if (validate(candidate.not as Schema, current, path).length === 0)
          errors.push(`${path}: matches disallowed not schema`);
      }
      if (candidate.if !== undefined) {
        const conditionMatches =
          validate(candidate.if as Schema, current, path).length === 0;
        const branch = conditionMatches ? candidate.then : candidate.else;
        if (branch !== undefined)
          errors.push(...validate(branch as Schema, current, path));
      }

      for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
        const branches = candidate[keyword] as Schema[] | undefined;
        if (!branches) continue;
        const branchErrors = branches.map((branch) =>
          validate(branch, current, path),
        );
        const matches = branchErrors.filter(
          (branch) => branch.length === 0,
        ).length;
        if (keyword === "allOf")
          branchErrors.forEach((branch) => errors.push(...branch));
        if (keyword === "anyOf" && matches === 0)
          errors.push(`${path}: does not match anyOf`);
        if (keyword === "oneOf" && matches !== 1)
          errors.push(
            `${path}: matches ${matches} oneOf branches, expected exactly one`,
          );
      }
      return errors;
    } finally {
      nodes.delete(current);
    }
  };
  return validate(root, node, "$");
}

function validateNumber(
  schema: Record<string, unknown>,
  raw: string,
  path: string,
  errors: string[],
): void {
  const value = decimalFromRaw(raw);
  if (
    schema.minimum !== undefined &&
    compareDecimals(value, decimalFromSchemaNumber(schema.minimum as number)) <
      0
  )
    errors.push(`${path}: must be >= ${schema.minimum}`);
  if (
    schema.maximum !== undefined &&
    compareDecimals(value, decimalFromSchemaNumber(schema.maximum as number)) >
      0
  )
    errors.push(`${path}: must be <= ${schema.maximum}`);
  if (
    schema.exclusiveMinimum !== undefined &&
    compareDecimals(
      value,
      decimalFromSchemaNumber(schema.exclusiveMinimum as number),
    ) <= 0
  )
    errors.push(`${path}: must be > ${schema.exclusiveMinimum}`);
  if (
    schema.exclusiveMaximum !== undefined &&
    compareDecimals(
      value,
      decimalFromSchemaNumber(schema.exclusiveMaximum as number),
    ) >= 0
  )
    errors.push(`${path}: must be < ${schema.exclusiveMaximum}`);
  if (schema.multipleOf !== undefined) {
    const divisor = schema.multipleOf as number;
    if (!decimalIsMultiple(value, decimalFromSchemaNumber(divisor)))
      errors.push(`${path}: must be a multiple of ${divisor}`);
  }
}

function validateString(
  schema: Record<string, unknown>,
  value: string,
  path: string,
  errors: string[],
): void {
  const length = Array.from(value).length;
  if (schema.minLength !== undefined && length < (schema.minLength as number))
    errors.push(
      `${path}: string is shorter than minLength ${schema.minLength}`,
    );
  if (schema.maxLength !== undefined && length > (schema.maxLength as number))
    errors.push(`${path}: string is longer than maxLength ${schema.maxLength}`);
  if (
    typeof schema.pattern === "string" &&
    !unicodeRegExp(schema.pattern).test(value)
  )
    errors.push(
      `${path}: string does not match pattern ${JSON.stringify(schema.pattern)}`,
    );
  if (typeof schema.format === "string" && !formatMatches(schema.format, value))
    errors.push(`${path}: string does not match format ${schema.format}`);
}

function validateArray(
  schema: Record<string, unknown>,
  node: Extract<JsonNode, { kind: "array" }>,
  path: string,
  errors: string[],
  validate: (schema: Schema, node: JsonNode, path: string) => string[],
): void {
  if (
    schema.minItems !== undefined &&
    node.items.length < (schema.minItems as number)
  )
    errors.push(`${path}: array has fewer than ${schema.minItems} items`);
  if (
    schema.maxItems !== undefined &&
    node.items.length > (schema.maxItems as number)
  )
    errors.push(`${path}: array has more than ${schema.maxItems} items`);
  if (schema.uniqueItems === true) {
    for (let index = 0; index < node.items.length; index += 1)
      for (let other = 0; other < index; other += 1)
        if (nodesEqual(node.items[index], node.items[other])) {
          errors.push(
            `${path}: array items ${other} and ${index} are not unique`,
          );
          index = node.items.length;
          break;
        }
  }
  const legacyTuple = Array.isArray(schema.items)
    ? (schema.items as Schema[])
    : undefined;
  const prefix =
    (schema.prefixItems as Schema[] | undefined) ?? legacyTuple ?? [];
  for (
    let index = 0;
    index < Math.min(prefix.length, node.items.length);
    index += 1
  )
    errors.push(
      ...validate(prefix[index], node.items[index], `${path}[${index}]`),
    );
  const remainingItems = legacyTuple
    ? (schema.additionalItems as Schema | undefined)
    : (schema.items as Schema | undefined);
  if (remainingItems !== undefined)
    for (let index = prefix.length; index < node.items.length; index += 1)
      errors.push(
        ...validate(remainingItems, node.items[index], `${path}[${index}]`),
      );
  if (schema.contains !== undefined) {
    const matches = node.items.filter(
      (item, index) =>
        validate(schema.contains as Schema, item, `${path}[${index}]`)
          .length === 0,
    ).length;
    const minimum = (schema.minContains as number | undefined) ?? 1;
    if (matches < minimum)
      errors.push(
        `${path}: contains matches ${matches} items, fewer than ${minimum}`,
      );
    if (
      schema.maxContains !== undefined &&
      matches > (schema.maxContains as number)
    )
      errors.push(
        `${path}: contains matches ${matches} items, more than ${schema.maxContains}`,
      );
  }
}

function validateObject(
  schema: Record<string, unknown>,
  node: Extract<JsonNode, { kind: "object" }>,
  path: string,
  errors: string[],
  validate: (schema: Schema, node: JsonNode, path: string) => string[],
): void {
  const byKey = new Map<string, JsonNode>();
  for (const entry of node.entries) {
    if (byKey.has(entry.key))
      errors.push(`${path}: duplicate property ${JSON.stringify(entry.key)}`);
    byKey.set(entry.key, entry.node);
  }
  if (
    schema.minProperties !== undefined &&
    byKey.size < (schema.minProperties as number)
  )
    errors.push(
      `${path}: object has fewer than ${schema.minProperties} properties`,
    );
  if (
    schema.maxProperties !== undefined &&
    byKey.size > (schema.maxProperties as number)
  )
    errors.push(
      `${path}: object has more than ${schema.maxProperties} properties`,
    );
  for (const key of (schema.required as string[] | undefined) ?? [])
    if (!byKey.has(key))
      errors.push(`${path}: missing required property ${JSON.stringify(key)}`);

  const propertyNames = schema.propertyNames as Schema | undefined;
  if (propertyNames !== undefined)
    for (const key of byKey.keys()) {
      const nameNode: JsonNode = { kind: "string", value: key };
      errors.push(
        ...validate(
          propertyNames,
          nameNode,
          `${propertyPath(path, key)} (name)`,
        ),
      );
    }

  const properties =
    (schema.properties as Record<string, Schema> | undefined) ?? {};
  const patterns = Object.entries(
    (schema.patternProperties as Record<string, Schema> | undefined) ?? {},
  ).map(([pattern, child]) => [unicodeRegExp(pattern), child] as const);
  for (const [key, child] of byKey) {
    let matched = false;
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      matched = true;
      errors.push(...validate(properties[key], child, propertyPath(path, key)));
    }
    for (const [pattern, patternSchema] of patterns)
      if (pattern.test(key)) {
        matched = true;
        errors.push(...validate(patternSchema, child, propertyPath(path, key)));
      }
    if (matched) continue;
    if (schema.additionalProperties === false)
      errors.push(
        `${path}: additional property ${JSON.stringify(key)} is not allowed`,
      );
    else if (
      schema.additionalProperties !== undefined &&
      schema.additionalProperties !== true
    )
      errors.push(
        ...validate(
          schema.additionalProperties as Schema,
          child,
          propertyPath(path, key),
        ),
      );
  }
  const dependentRequired =
    (schema.dependentRequired as Record<string, string[]> | undefined) ?? {};
  for (const [key, dependencies] of Object.entries(dependentRequired))
    if (byKey.has(key))
      for (const dependency of dependencies)
        if (!byKey.has(dependency))
          errors.push(
            `${path}: property ${JSON.stringify(key)} requires ${JSON.stringify(dependency)}`,
          );
  const dependentSchemas =
    (schema.dependentSchemas as Record<string, Schema> | undefined) ?? {};
  for (const [key, dependency] of Object.entries(dependentSchemas))
    if (byKey.has(key)) errors.push(...validate(dependency, node, path));
  const legacyDependencies =
    (schema.dependencies as Record<string, Schema | string[]> | undefined) ??
    {};
  for (const [key, dependency] of Object.entries(legacyDependencies)) {
    if (!byKey.has(key)) continue;
    if (Array.isArray(dependency)) {
      for (const required of dependency)
        if (!byKey.has(required))
          errors.push(
            `${path}: property ${JSON.stringify(key)} requires ${JSON.stringify(required)}`,
          );
    } else {
      errors.push(...validate(dependency, node, path));
    }
  }
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function formatMatches(format: string, value: string): boolean {
  switch (format) {
    case "date":
      return validDate(value);
    case "time":
      return validTime(value);
    case "date-time": {
      const match = /^(\d{4}-\d{2}-\d{2})[Tt](.+)$/.exec(value);
      return match !== null && validDate(match[1]) && validTime(match[2]);
    }
    case "duration":
      return /^(?:P\d+W|P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/.test(
        value,
      );
    case "email": {
      const separator = value.lastIndexOf("@");
      if (separator <= 0 || separator === value.length - 1) return false;
      const local = value.slice(0, separator);
      const domain = value.slice(separator + 1);
      if (
        local.startsWith(".") ||
        local.endsWith(".") ||
        local.includes("..") ||
        !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(local)
      )
        return false;
      if (/^\[(.+)\]$/.test(domain)) return validIpv4(domain.slice(1, -1));
      return validHostname(domain);
    }
    case "hostname":
      return validHostname(value);
    case "ipv4":
      return validIpv4(value);
    case "ipv6":
      return validIpv6(value);
    case "uuid":
      return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value,
      );
    case "uri":
      return validUriReference(value, true);
    case "uri-reference":
      return validUriReference(value, false);
    case "regex":
      try {
        unicodeRegExp(value);
        return true;
      } catch {
        return false;
      }
    case "json-pointer":
      return /^(?:\/(?:[^~/]|~[01])*)*$/u.test(value);
    case "relative-json-pointer":
      return /^(?:0|[1-9]\d*)(?:#|(?:\/(?:[^~/]|~[01])*)*)$/u.test(value);
    case "unknown":
      return true;
    default:
      return true;
  }
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month === 2 &&
    !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))
  )
    days[1] = 28;
  return day <= days[month - 1];
}

function validTime(value: string): boolean {
  const match =
    /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    (second === 60 && (hour !== 23 || minute !== 59))
  )
    return false;
  return (
    match[4] === undefined || (Number(match[5]) <= 23 && Number(match[6]) <= 59)
  );
}

function validHostname(value: string): boolean {
  if (value.length < 1 || value.length > 253 || value.endsWith("."))
    return false;
  return value
    .split(".")
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
}

function validIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255,
    )
  );
}

function validIpv6(value: string): boolean {
  if (value.includes(":::")) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const parseHalf = (half: string): number | null => {
    if (half === "") return 0;
    const groups = half.split(":");
    let count = 0;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (group.includes(".")) {
        if (index !== groups.length - 1 || !validIpv4(group)) return null;
        count += 2;
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
        count += 1;
      }
    }
    return count;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (left === null || right === null) return false;
  return halves.length === 2 ? left + right < 8 : left === 8;
}

const uriUnreserved = "A-Za-z0-9._~\\-";
const uriSubDelimiters = "!$&'()*+,;=";
const uriPercentEncoded = "%[0-9A-Fa-f]{2}";
const uriPchar = `(?:[${uriUnreserved}${uriSubDelimiters}:@]|${uriPercentEncoded})`;
const uriPathPattern = new RegExp(`^(?:${uriPchar}|/)*$`, "u");
const uriQueryPattern = new RegExp(`^(?:${uriPchar}|[/?])*$`, "u");
const uriRegNamePattern = new RegExp(
  `^(?:[${uriUnreserved}${uriSubDelimiters}]|${uriPercentEncoded})*$`,
  "u",
);
const uriUserInfoPattern = new RegExp(
  `^(?:[${uriUnreserved}${uriSubDelimiters}:]|${uriPercentEncoded})*$`,
  "u",
);

function validUriReference(value: string, absolute: boolean): boolean {
  let rest = value;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(rest);
  if (absolute && !scheme) return false;
  if (scheme) rest = rest.slice(scheme[0].length);

  const fragmentAt = rest.indexOf("#");
  if (fragmentAt !== -1) {
    if (!uriQueryPattern.test(rest.slice(fragmentAt + 1))) return false;
    rest = rest.slice(0, fragmentAt);
  }
  const queryAt = rest.indexOf("?");
  if (queryAt !== -1) {
    if (!uriQueryPattern.test(rest.slice(queryAt + 1))) return false;
    rest = rest.slice(0, queryAt);
  }

  if (rest.startsWith("//")) {
    const pathAt = rest.indexOf("/", 2);
    const authority = rest.slice(2, pathAt === -1 ? undefined : pathAt);
    const path = pathAt === -1 ? "" : rest.slice(pathAt);
    return validUriAuthority(authority) && uriPathPattern.test(path);
  }
  if (!uriPathPattern.test(rest)) return false;
  if (scheme || rest === "" || rest.startsWith("/")) return true;
  const slash = rest.indexOf("/");
  return !rest.slice(0, slash === -1 ? undefined : slash).includes(":");
}

function validUriAuthority(value: string): boolean {
  const at = value.lastIndexOf("@");
  if (at !== -1) {
    if (!uriUserInfoPattern.test(value.slice(0, at))) return false;
    value = value.slice(at + 1);
  }

  let host: string;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return false;
    host = value.slice(1, close);
    const suffix = value.slice(close + 1);
    if (suffix !== "" && !/^:\d*$/.test(suffix)) return false;
    const ipvFuture = /^v[0-9A-Fa-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/.test(
      host,
    );
    return validIpv6(host) || ipvFuture;
  }

  const colon = value.lastIndexOf(":");
  if (colon !== -1) {
    if (value.indexOf(":") !== colon || !/^\d*$/.test(value.slice(colon + 1)))
      return false;
    host = value.slice(0, colon);
  } else {
    host = value;
  }
  return uriRegNamePattern.test(host);
}

type SchemaSet = Schema[];

class PrefixStop extends Error {
  readonly viable: boolean;

  constructor(viable: boolean) {
    super();
    this.viable = viable;
  }
}

function expandSchemaSet(
  schemas: SchemaSet,
  references: Map<string, Schema>,
): SchemaSet[] {
  const expand = (schema: Schema, active: Set<Schema>): SchemaSet[] => {
    if (schema === false) return [];
    if (schema === true || active.has(schema)) return [[schema]];
    const next = new Set(active).add(schema);
    let result: SchemaSet[] = [[schema]];
    const add = (choices: SchemaSet[]): void => {
      result = result.flatMap((left) =>
        choices.map((right) => [...left, ...right]),
      );
    };
    if (typeof schema.$ref === "string")
      add(expand(references.get(schema.$ref)!, next));
    for (const child of (schema.allOf as Schema[] | undefined) ?? [])
      add(expand(child, next));
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const branches = schema[keyword] as Schema[] | undefined;
      if (branches) add(branches.flatMap((branch) => expand(branch, next)));
    }
    return result;
  };
  let result: SchemaSet[] = [[]];
  for (const schema of schemas)
    result = result.flatMap((left) =>
      expand(schema, new Set()).map((right) => [...left, ...right]),
    );
  return result;
}

function schemaTypes(schema: Schema): string[] | undefined {
  if (typeof schema === "boolean" || schema.type === undefined)
    return undefined;
  return (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
}

function setAllowsKind(schemas: SchemaSet, kind: JsonNode["kind"]): boolean {
  return schemas.every((schema) => {
    if (schema === false) return false;
    const types = schemaTypes(schema);
    return (
      !types ||
      types.some((type) =>
        kind === "number"
          ? type === "number" || type === "integer"
          : type === kind,
      )
    );
  });
}

function finiteSchemaValues(schemas: SchemaSet): unknown[] | undefined {
  let values: unknown[] | undefined;
  for (const schema of schemas) {
    if (typeof schema === "boolean") continue;
    const constrained =
      schema.const !== undefined
        ? [schema.const]
        : Array.isArray(schema.enum)
          ? schema.enum
          : undefined;
    if (!constrained) continue;
    values = values
      ? values.filter((value) =>
          constrained.some((candidate) => deepEqual(value, candidate)),
        )
      : [...constrained];
  }
  return values;
}

function valueKind(value: unknown): JsonNode["kind"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object"
    ? "object"
    : (typeof value as JsonNode["kind"]);
}

function setCanStart(schemas: SchemaSet, kind: JsonNode["kind"]): boolean {
  if (!setAllowsKind(schemas, kind)) return false;
  const values = finiteSchemaValues(schemas);
  return (
    values === undefined || values.some((value) => valueKind(value) === kind)
  );
}

function validForSet(
  schemas: SchemaSet,
  node: JsonNode,
  references: Map<string, Schema>,
): boolean {
  return schemas.every(
    (schema) => validateDocument(schema, node, references).length === 0,
  );
}

class SchemaPrefixParser {
  private position = 0;
  private readonly input: string;
  private readonly guidance: Guidance;
  private readonly references: Map<string, Schema>;

  constructor(
    input: string,
    guidance: Guidance,
    references: Map<string, Schema>,
  ) {
    this.input = input;
    this.guidance = guidance;
    this.references = references;
  }

  viable(schemas: SchemaSet): boolean {
    if (/^[\u0009\u000a\u000d\u0020]$/.test(this.input[0] ?? "")) return false;
    try {
      const node = this.value(schemas);
      return (
        this.position === this.input.length &&
        validForSet(schemas, node, this.references)
      );
    } catch (error) {
      if (error instanceof PrefixStop) return error.viable;
      throw error;
    }
  }

  private value(schemas: SchemaSet): JsonNode {
    this.space();
    if (this.position === this.input.length) throw new PrefixStop(true);
    const start = this.position;
    let viable = false;
    for (const alternative of expandSchemaSet(schemas, this.references)) {
      this.position = start;
      try {
        return this.valueForSet(alternative);
      } catch (error) {
        if (!(error instanceof PrefixStop)) throw error;
        viable ||= error.viable;
      }
    }
    this.position = start;
    throw new PrefixStop(viable);
  }

  private valueForSet(schemas: SchemaSet): JsonNode {
    const character = this.input[this.position];
    let node: JsonNode;
    if (character === '"' && setCanStart(schemas, "string"))
      node = this.string(schemas);
    else if (character === "[" && setCanStart(schemas, "array"))
      node = this.array(schemas);
    else if (character === "{" && setCanStart(schemas, "object"))
      node = this.object(schemas);
    else if (character === "t" && setCanStart(schemas, "boolean"))
      node = this.literal("true", true, schemas);
    else if (character === "f" && setCanStart(schemas, "boolean"))
      node = this.literal("false", false, schemas);
    else if (character === "n" && setCanStart(schemas, "null"))
      node = this.literal("null", null, schemas);
    else if (
      (character === "-" || this.isDigit(character)) &&
      setCanStart(schemas, "number")
    )
      node = this.number(schemas);
    else throw new PrefixStop(false);

    if (!validForSet(schemas, node, this.references)) {
      if (node.kind === "number" && this.position === this.input.length)
        throw new PrefixStop(this.numberMayExtend(node.raw, schemas));
      throw new PrefixStop(false);
    }
    return node;
  }

  private literal(
    text: "true" | "false" | "null",
    value: boolean | null,
    schemas: SchemaSet,
  ): JsonNode {
    for (let index = 0; index < text.length; index += 1) {
      if (this.position + index === this.input.length) {
        const values = finiteSchemaValues(schemas);
        throw new PrefixStop(
          values === undefined ||
            values.some((candidate) => candidate === value),
        );
      }
      if (this.input[this.position + index] !== text[index])
        throw new PrefixStop(false);
    }
    this.position += text.length;
    return value === null
      ? { kind: "null", value }
      : { kind: "boolean", value };
  }

  private string(schemas: SchemaSet): Extract<JsonNode, { kind: "string" }> {
    this.position += 1;
    let value = "";
    while (this.position < this.input.length) {
      const character = this.input[this.position++];
      if (character === '"') return { kind: "string", value };
      value += this.stringCharacter(character);
      if (!this.openStringViable(value, schemas)) throw new PrefixStop(false);
    }
    throw new PrefixStop(this.openStringViable(value, schemas));
  }

  private stringCharacter(character: string): string {
    if (character !== "\\") {
      if (character.charCodeAt(0) < 0x20) throw new PrefixStop(false);
      return character;
    }
    if (this.position === this.input.length) throw new PrefixStop(true);
    const escape = this.input[this.position++];
    const simple: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (Object.prototype.hasOwnProperty.call(simple, escape))
      return simple[escape];
    if (escape !== "u") throw new PrefixStop(false);
    let hexadecimal = "";
    for (let index = 0; index < 4; index += 1) {
      if (this.position === this.input.length) throw new PrefixStop(true);
      const digit = this.input[this.position++];
      if (!/[0-9a-fA-F]/.test(digit)) throw new PrefixStop(false);
      hexadecimal += digit;
    }
    return String.fromCharCode(Number.parseInt(hexadecimal, 16));
  }

  private openStringViable(value: string, schemas: SchemaSet): boolean {
    const length = Array.from(value).length;
    if (
      schemas.some(
        (schema) =>
          typeof schema !== "boolean" &&
          schema.maxLength !== undefined &&
          length > (schema.maxLength as number),
      )
    )
      return false;
    const values = finiteSchemaValues(schemas);
    return (
      values === undefined ||
      values.some(
        (candidate) =>
          typeof candidate === "string" && candidate.startsWith(value),
      )
    );
  }

  private number(schemas: SchemaSet): Extract<JsonNode, { kind: "number" }> {
    const start = this.position;
    if (this.input[this.position] === "-") {
      this.position += 1;
      if (this.position === this.input.length)
        throw new PrefixStop(this.numberPrefixPossible("-", schemas));
    }
    if (this.input[this.position] === "0") {
      this.position += 1;
      if (this.isDigit(this.input[this.position])) throw new PrefixStop(false);
    } else {
      if (!this.isNonZeroDigit(this.input[this.position]))
        throw new PrefixStop(false);
      while (this.isDigit(this.input[this.position])) this.position += 1;
    }
    if (this.input[this.position] === ".") {
      this.position += 1;
      if (this.position === this.input.length)
        throw new PrefixStop(
          this.numberPrefixPossible(this.input.slice(start), schemas),
        );
      if (!this.isDigit(this.input[this.position])) throw new PrefixStop(false);
      while (this.isDigit(this.input[this.position])) this.position += 1;
    }
    if (
      this.input[this.position] === "e" ||
      this.input[this.position] === "E"
    ) {
      this.position += 1;
      if (
        this.input[this.position] === "+" ||
        this.input[this.position] === "-"
      )
        this.position += 1;
      if (this.position === this.input.length)
        throw new PrefixStop(
          this.numberPrefixPossible(this.input.slice(start), schemas),
        );
      if (!this.isDigit(this.input[this.position])) throw new PrefixStop(false);
      while (this.isDigit(this.input[this.position])) this.position += 1;
    }
    const raw = this.input.slice(start, this.position);
    return { kind: "number", value: Number(raw), raw };
  }

  private numberPrefixPossible(raw: string, schemas: SchemaSet): boolean {
    const values = finiteSchemaValues(schemas);
    if (values === undefined) return true;
    return values.some((value) => typeof value === "number");
  }

  private numberMayExtend(_raw: string, schemas: SchemaSet): boolean {
    const values = finiteSchemaValues(schemas);
    if (values !== undefined)
      return values.some((value) => typeof value === "number");
    return true;
  }

  private array(schemas: SchemaSet): Extract<JsonNode, { kind: "array" }> {
    this.position += 1;
    this.space();
    const items: JsonNode[] = [];
    if (this.take("]")) return { kind: "array", value: [], items };
    if (this.position === this.input.length)
      throw new PrefixStop(
        this.arrayCanClose(schemas, items) || this.arrayCanAdd(schemas, 0),
      );
    while (true) {
      const childSchemas = this.arrayItemSchemas(schemas, items.length);
      if (!childSchemas) throw new PrefixStop(false);
      items.push(this.value(childSchemas));
      this.space();
      if (this.position === this.input.length)
        throw new PrefixStop(
          this.arrayCanClose(schemas, items) ||
            this.arrayCanAdd(schemas, items.length),
        );
      if (this.take("]"))
        return { kind: "array", value: items.map((item) => item.value), items };
      this.separator(this.guidance.itemSeparator);
      this.space();
      if (this.position === this.input.length)
        throw new PrefixStop(this.arrayCanAdd(schemas, items.length));
    }
  }

  private arrayCanClose(schemas: SchemaSet, items: JsonNode[]): boolean {
    const node: Extract<JsonNode, { kind: "array" }> = {
      kind: "array",
      value: items.map((item) => item.value),
      items,
    };
    return validForSet(schemas, node, this.references);
  }

  private arrayCanAdd(schemas: SchemaSet, count: number): boolean {
    return (
      schemas.every(
        (schema) =>
          typeof schema === "boolean" ||
          schema.maxItems === undefined ||
          count < (schema.maxItems as number),
      ) && this.arrayItemSchemas(schemas, count) !== null
    );
  }

  private arrayItemSchemas(
    schemas: SchemaSet,
    index: number,
  ): SchemaSet | null {
    const result: SchemaSet = [];
    for (const schema of schemas) {
      if (typeof schema === "boolean") continue;
      const legacyTuple = Array.isArray(schema.items)
        ? (schema.items as Schema[])
        : undefined;
      const prefix =
        (schema.prefixItems as Schema[] | undefined) ?? legacyTuple ?? [];
      const child =
        index < prefix.length
          ? prefix[index]
          : legacyTuple
            ? schema.additionalItems
            : schema.items;
      if (child === false) return null;
      if (child !== undefined && child !== true) result.push(child as Schema);
    }
    return result.length ? result : [true];
  }

  private object(schemas: SchemaSet): Extract<JsonNode, { kind: "object" }> {
    this.position += 1;
    this.space();
    const entries: Array<{ key: string; node: JsonNode }> = [];
    const value: Record<string, unknown> = {};
    if (this.take("}")) return { kind: "object", value, entries };
    if (this.position === this.input.length)
      throw new PrefixStop(
        this.objectCanClose(schemas, entries) ||
          this.objectCanAdd(schemas, entries),
      );
    while (true) {
      if (this.input[this.position] !== '"') throw new PrefixStop(false);
      const key = this.propertyName(schemas, entries);
      if (entries.some((entry) => entry.key === key))
        throw new PrefixStop(false);
      const childSchemas = this.propertySchemas(schemas, key, entries);
      if (!childSchemas) throw new PrefixStop(false);
      this.space();
      this.separator(this.guidance.keySeparator);
      const node = this.value(childSchemas);
      entries.push({ key, node });
      Object.defineProperty(value, key, {
        value: node.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.space();
      if (this.position === this.input.length)
        throw new PrefixStop(
          this.objectCanClose(schemas, entries) ||
            this.objectCanAdd(schemas, entries),
        );
      if (this.take("}")) return { kind: "object", value, entries };
      this.separator(this.guidance.itemSeparator);
      this.space();
      if (this.position === this.input.length)
        throw new PrefixStop(this.objectCanAdd(schemas, entries));
    }
  }

  private propertyName(
    schemas: SchemaSet,
    entries: Array<{ key: string; node: JsonNode }>,
  ): string {
    this.position += 1;
    let value = "";
    while (this.position < this.input.length) {
      const character = this.input[this.position++];
      if (character === '"') {
        if (!this.propertyNameValid(schemas, value))
          throw new PrefixStop(false);
        return value;
      }
      value += this.stringCharacter(character);
      if (!this.propertyPrefixPossible(schemas, entries, value))
        throw new PrefixStop(false);
    }
    throw new PrefixStop(this.propertyPrefixPossible(schemas, entries, value));
  }

  private propertyPrefixPossible(
    schemas: SchemaSet,
    entries: Array<{ key: string; node: JsonNode }>,
    prefix: string,
  ): boolean {
    const nameSchemas = this.propertyNameSchemas(schemas);
    if (!this.openStringViable(prefix, nameSchemas)) return false;
    if (this.additionalAllowed(schemas) || this.hasPatternProperties(schemas))
      return true;
    const used = new Set(entries.map((entry) => entry.key));
    return this.availablePropertyNames(schemas, entries).some(
      (name) => !used.has(name) && name.startsWith(prefix),
    );
  }

  private propertyNameSchemas(schemas: SchemaSet): SchemaSet {
    const result: SchemaSet = [];
    for (const schema of schemas)
      if (typeof schema !== "boolean" && schema.propertyNames !== undefined)
        result.push(schema.propertyNames as Schema);
    return result.length ? result : [true];
  }

  private propertyNameValid(schemas: SchemaSet, name: string): boolean {
    return validForSet(
      this.propertyNameSchemas(schemas),
      { kind: "string", value: name },
      this.references,
    );
  }

  private hasPatternProperties(schemas: SchemaSet): boolean {
    return schemas.some(
      (schema) =>
        typeof schema !== "boolean" &&
        Object.keys(
          (schema.patternProperties as Record<string, Schema> | undefined) ??
            {},
        ).length > 0,
    );
  }

  private availablePropertyNames(
    schemas: SchemaSet,
    entries: Array<{ key: string; node: JsonNode }>,
  ): string[] {
    const names: string[] = [];
    for (const schema of schemas) {
      if (typeof schema === "boolean") continue;
      for (const key of Object.keys(
        (schema.properties as Record<string, Schema> | undefined) ?? {},
      ))
        if (!names.includes(key)) names.push(key);
    }
    const used = new Set(entries.map((entry) => entry.key));
    return names.filter((name) => !used.has(name));
  }

  private additionalAllowed(schemas: SchemaSet): boolean {
    return schemas.every(
      (schema) =>
        typeof schema === "boolean" || schema.additionalProperties !== false,
    );
  }

  private propertySchemas(
    schemas: SchemaSet,
    key: string,
    entries: Array<{ key: string; node: JsonNode }>,
  ): SchemaSet | null {
    const result: SchemaSet = [];
    for (const schema of schemas) {
      if (typeof schema === "boolean") continue;
      const properties =
        (schema.properties as Record<string, Schema> | undefined) ?? {};
      let matched = false;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        matched = true;
        const child = properties[key];
        if (child === false) return null;
        if (child !== true) result.push(child);
      }
      const patterns =
        (schema.patternProperties as Record<string, Schema> | undefined) ?? {};
      for (const [pattern, child] of Object.entries(patterns))
        if (unicodeRegExp(pattern).test(key)) {
          matched = true;
          if (child === false) return null;
          if (child !== true) result.push(child);
        }
      if (!matched) {
        const child = schema.additionalProperties as Schema | undefined;
        if (child === false) return null;
        if (child !== undefined && child !== true) result.push(child);
      }
    }
    return result.length ? result : [true];
  }

  private objectCanClose(
    schemas: SchemaSet,
    entries: Array<{ key: string; node: JsonNode }>,
  ): boolean {
    const value: Record<string, unknown> = {};
    for (const entry of entries)
      Object.defineProperty(value, entry.key, {
        value: entry.node.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    return validForSet(
      schemas,
      { kind: "object", value, entries },
      this.references,
    );
  }

  private objectCanAdd(
    schemas: SchemaSet,
    entries: Array<{ key: string; node: JsonNode }>,
  ): boolean {
    if (
      schemas.some(
        (schema) =>
          typeof schema !== "boolean" &&
          schema.maxProperties !== undefined &&
          entries.length >= (schema.maxProperties as number),
      )
    )
      return false;
    return (
      this.additionalAllowed(schemas) ||
      this.availablePropertyNames(schemas, entries).length > 0
    );
  }

  private separator(separator: string): void {
    for (let index = 0; index < separator.length; index += 1) {
      if (this.position + index === this.input.length)
        throw new PrefixStop(true);
      if (this.input[this.position + index] !== separator[index])
        throw new PrefixStop(false);
    }
    this.position += separator.length;
  }

  private take(text: string): boolean {
    if (!this.input.startsWith(text, this.position)) return false;
    this.position += text.length;
    return true;
  }

  private space(): void {
    if (!this.guidance.whitespaceFlexible) return;
    while (/^[\u0009\u000a\u000d\u0020]$/.test(this.input[this.position] ?? ""))
      this.position += 1;
  }

  private isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= "0" && value <= "9";
  }

  private isNonZeroDigit(value: string | undefined): boolean {
    return value !== undefined && value >= "1" && value <= "9";
  }
}

function schemaPrefixViable(
  text: string,
  root: Schema,
  references: Map<string, Schema>,
  guidance: Guidance,
): boolean {
  return expandSchemaSet([root], references).some((schemas) =>
    new SchemaPrefixParser(text, guidance, references).viable(schemas),
  );
}

interface Utf8DecodeResult {
  text: string;
  incomplete: boolean;
  completion?: string;
  error?: string;
  position?: number;
}

function decodeUtf8Prefix(
  input: Uint8Array | readonly number[],
): Utf8DecodeResult {
  const bytes = Array.from(input);
  let text = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    if (!Number.isInteger(first) || first < 0 || first > 255)
      return {
        text,
        incomplete: false,
        error: "UTF-8 input contains a value outside 0..255",
        position: index,
      };
    if (first <= 0x7f) {
      text += String.fromCodePoint(first);
      index += 1;
      continue;
    }
    let length: number;
    let codePoint: number;
    let minimum: number;
    if (first >= 0xc2 && first <= 0xdf)
      [length, codePoint, minimum] = [2, first & 0x1f, 0x80];
    else if (first >= 0xe0 && first <= 0xef)
      [length, codePoint, minimum] = [3, first & 0x0f, 0x800];
    else if (first >= 0xf0 && first <= 0xf4)
      [length, codePoint, minimum] = [4, first & 0x07, 0x10000];
    else
      return {
        text,
        incomplete: false,
        error: "Invalid UTF-8 leading byte",
        position: index,
      };

    const available = bytes.length - index;
    const consumed = Math.min(available, length);
    for (let offset = 1; offset < consumed; offset += 1) {
      const byte = bytes[index + offset];
      if (!Number.isInteger(byte) || byte < 0x80 || byte > 0xbf)
        return {
          text,
          incomplete: false,
          error: "Invalid UTF-8 continuation byte",
          position: index + offset,
        };
      if (
        offset === 1 &&
        ((first === 0xe0 && byte < 0xa0) ||
          (first === 0xed && byte > 0x9f) ||
          (first === 0xf0 && byte < 0x90) ||
          (first === 0xf4 && byte > 0x8f))
      ) {
        return {
          text,
          incomplete: false,
          error: "Invalid UTF-8 code point",
          position: index,
        };
      }
      codePoint = (codePoint << 6) | (byte & 0x3f);
    }
    if (available < length) {
      let completed = codePoint;
      for (let offset = available; offset < length; offset += 1)
        completed <<= 6;
      if (completed < minimum) completed = minimum;
      if (completed >= 0xd800 && completed <= 0xdfff) completed = 0xe000;
      if (completed > 0x10ffff)
        return {
          text,
          incomplete: false,
          error: "Invalid UTF-8 code point",
          position: index,
        };
      return {
        text,
        incomplete: true,
        completion: String.fromCodePoint(completed),
      };
    }
    if (
      codePoint < minimum ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return {
        text,
        incomplete: false,
        error: "Invalid UTF-8 code point",
        position: index,
      };
    }
    text += String.fromCodePoint(codePoint);
    index += length;
  }
  return { text, incomplete: false };
}

function rawCodePointCanContinue(text: string): boolean {
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (!inString) {
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") escaped = true;
    else if (character === '"') inString = false;
  }
  return inString && !escaped;
}

/** Compile a supported JSON Schema into prefix and final-document checks. */
export function compileJsonSchema(
  schema: unknown,
  options: JsonSchemaCompileOptions = {},
): CompiledJsonSchema {
  const maxSchemaDepth = options.maxSchemaDepth ?? 128;
  const maxJsonDepth = options.maxJsonDepth ?? 128;
  assertSchemaDepth(schema, maxSchemaDepth);
  const root: Schema =
    typeof schema === "boolean" ? schema : schemaObject(schema, "schema");
  const references = compileChecks(root);
  const guidance = guidanceFor(root);

  const analyzeText = (text: string): JsonPrefixResult => {
    try {
      const node = new JsonParser(text, guidance, maxJsonDepth).parse();
      const errors = validateDocument(root, node, references);
      const hasTrailingWhitespace =
        guidance.whitespaceFlexible && /[\u0009\u000a\u000d\u0020]$/.test(text);
      const accepted = errors.length === 0 && !hasTrailingWhitespace;
      const viable =
        accepted || schemaPrefixViable(text, root, references, guidance);
      return {
        status: "complete",
        viable,
        accepted,
        value: node.value,
        errors,
      };
    } catch (error) {
      if (!(error instanceof ParseFailure)) throw error;
      const viable =
        error.incomplete &&
        schemaPrefixViable(text, root, references, guidance);
      return {
        status: error.incomplete ? "incomplete" : "invalid",
        viable,
        accepted: false,
        errors: error.incomplete ? [] : [error.message],
        position: error.position,
      };
    }
  };

  const analyzeUtf8 = (
    bytes: Uint8Array | readonly number[],
  ): JsonPrefixResult => {
    const decoded = decodeUtf8Prefix(bytes);
    if (decoded.error)
      return {
        status: "invalid",
        viable: false,
        accepted: false,
        errors: [decoded.error],
        position: decoded.position,
      };
    if (!decoded.incomplete) return analyzeText(decoded.text);
    const withCompletion = analyzeText(decoded.text + decoded.completion!);
    if (
      !withCompletion.viable &&
      !(
        rawCodePointCanContinue(decoded.text) &&
        analyzeText(decoded.text).viable
      )
    )
      return {
        status: "invalid",
        viable: false,
        accepted: false,
        errors: ["Partial UTF-8 code point cannot occur at this JSON position"],
      };
    return { status: "incomplete", viable: true, accepted: false, errors: [] };
  };

  const initialResult = analyzeText("");
  const initialUtf8 = Object.freeze({
    bytes: new Uint8Array(0),
    result: initialResult,
  });
  return {
    initial: Object.freeze({ text: "", result: initialResult }),
    initialUtf8,
    analyzeText,
    analyzeUtf8,
    isTextPrefixViable: (text) => analyzeText(text).viable,
    isUtf8PrefixViable: (bytes) => analyzeUtf8(bytes).viable,
    acceptsText: (text) => analyzeText(text).accepted,
    acceptsUtf8: (bytes) => analyzeUtf8(bytes).accepted,
    append: (state, text) => {
      const combined = state.text + text;
      return { text: combined, result: analyzeText(combined) };
    },
    appendUtf8: (state, bytes) => {
      const combined = appendBytes(state.bytes, bytes);
      return { bytes: combined, result: analyzeUtf8(combined) };
    },
    viable: (state) => state.result.viable,
    accepting: (state) => state.result.accepted,
    finish: (state) => state.result.accepted,
  };
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function assertSchemaDepth(schema: unknown, maxDepth: number): void {
  const active = new WeakSet<object>();
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object") return;
    if (depth > maxDepth) {
      throw new JsonSchemaCompileError(
        `schema nesting exceeds maxSchemaDepth (${maxDepth})`,
      );
    }
    if (active.has(value)) {
      throw new JsonSchemaCompileError("schema must not contain object cycles");
    }
    active.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      visit(child, depth + 1);
    }
    active.delete(value);
  };
  visit(schema, 0);
}
