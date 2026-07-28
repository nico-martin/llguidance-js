import { compileJsonSchema, type CompiledJsonSchema } from "./json-schema.ts";
import { compileRegex, type CompiledRegex, type RegexState } from "./regex.ts";

const MARKER_KEY = "$llguidance_ts_core";
const MARKER_VERSION = 1;
const LARK_UNSUPPORTED =
  "Lark grammars are not supported by the pure TypeScript core backend yet";
const UPSTREAM_UNSUPPORTED =
  "Raw llguidance/guidance serialized grammars are not supported by the pure TypeScript core backend; use a marker produced by this backend";

type TokenizerConfig = {
  tokens?: Array<Uint8Array | readonly number[]>;
  eosTokenId?: number;
  eos_token_id?: number;
  bosTokenId?: number;
  bos_token_id?: number;
  specialTokenIds?: readonly number[];
  special_token_ids?: readonly number[];
};

type Marker = {
  [MARKER_KEY]: typeof MARKER_VERSION;
  type: "regex" | "json_schema" | "lark";
  value: unknown;
};

type Engine =
  | { kind: "regex"; compiled: CompiledRegex; state: RegexState }
  | { kind: "json"; compiled: CompiledJsonSchema; bytes: Uint8Array };

type TokenTrieNode = {
  readonly children: Map<number, TokenTrieNode>;
  readonly terminalTokenIds: number[];
};

type TokenizerData = {
  readonly tokenBytes: readonly Uint8Array[];
  readonly trie: TokenTrieNode;
  readonly eos: number;
  readonly special: ReadonlySet<number>;
};

type MaskResult = { mask: Uint32Array; vocabSize: number } | { stop: true };

const tokenizerData = new WeakMap<LLGuidanceTokenizer, TokenizerData>();
const singleBytes = Array.from({ length: 256 }, (_, byte) =>
  Uint8Array.of(byte),
);

export class LLGuidanceTokenizer {
  private freed = false;

  constructor(config: TokenizerConfig = {}) {
    if (config === null || typeof config !== "object") {
      throw new TypeError("tokenizer config must be an object");
    }

    if (config.tokens === undefined) {
      const tokens = Array.from({ length: 262 }, (_, id) =>
        id < 256 ? Uint8Array.of(id) : new Uint8Array(0),
      );
      tokenizerData.set(this, {
        tokenBytes: tokens,
        trie: buildTokenTrie(tokens),
        eos: 261,
        special: new Set([256, 257, 258, 259, 260, 261]),
      });
      return;
    }

    if (!Array.isArray(config.tokens) || config.tokens.length === 0) {
      throw new TypeError(
        "tokens must be a non-empty array of raw byte arrays",
      );
    }
    const tokenBytes = config.tokens.map((token, tokenId) =>
      normalizeTokenBytes(token, tokenId),
    );
    const eos = config.eosTokenId ?? config.eos_token_id;
    if (eos === undefined) {
      throw new TypeError(
        "eosTokenId is required when tokenizer tokens are provided",
      );
    }
    assertTokenId(eos, tokenBytes.length, "eos token id");

    const configuredSpecials =
      config.specialTokenIds ?? config.special_token_ids ?? [];
    if (!Array.isArray(configuredSpecials)) {
      throw new TypeError("special token ids must be an array");
    }
    const special = new Set<number>([eos]);
    for (const id of configuredSpecials) {
      assertTokenId(id, tokenBytes.length, "special token id");
      special.add(id);
    }
    const bos = config.bosTokenId ?? config.bos_token_id;
    if (bos !== undefined) {
      assertTokenId(bos, tokenBytes.length, "bos token id");
      special.add(bos);
    }
    tokenizerData.set(this, {
      tokenBytes,
      trie: buildTokenTrie(tokenBytes),
      eos,
      special,
    });
  }

  vocabSize(): number {
    this.assertLive();
    return getTokenizerData(this).tokenBytes.length;
  }

  eosToken(): number {
    this.assertLive();
    return getTokenizerData(this).eos;
  }

  free(): void {
    this.freed = true;
  }

  dispose(): void {
    this.free();
  }

  token(id: number): Uint8Array {
    this.assertLive();
    return getTokenizerData(this).tokenBytes[id].slice();
  }

  isSpecial(id: number): boolean {
    this.assertLive();
    const data = getTokenizerData(this);
    return data.special.has(id) || data.tokenBytes[id].length === 0;
  }

  private assertLive(): void {
    if (this.freed) throw new Error("LLGuidanceTokenizer has been freed");
  }
}

export class LLGuidanceInterpreter {
  private readonly tokenizer: LLGuidanceTokenizer;
  private engine: Engine;
  private stopped = false;
  private freed = false;
  private maskCache: MaskResult | null = null;

  constructor(tokenizer: LLGuidanceTokenizer, config: unknown) {
    if (!(tokenizer instanceof LLGuidanceTokenizer)) {
      throw new TypeError("tokenizer must be an LLGuidanceTokenizer");
    }
    this.tokenizer = tokenizer;
    const marker = markerFromInterpreterConfig(config);
    if (marker.type === "lark") throw new Error(LARK_UNSUPPORTED);
    if (marker.type === "regex") {
      if (typeof marker.value !== "string") {
        throw new TypeError("regex grammar must be a string");
      }
      const compiled = compileRegex(marker.value);
      this.engine = { kind: "regex", compiled, state: compiled.initialState };
    } else {
      const compiled = compileJsonSchema(marker.value);
      this.engine = { kind: "json", compiled, bytes: new Uint8Array(0) };
    }
  }

  computeMask(): MaskResult {
    this.assertLive();
    if (this.stopped) return { stop: true };
    const vocabSize = this.tokenizer.vocabSize();
    if (this.maskCache !== null) return cloneMaskResult(this.maskCache);

    const mask = new Uint32Array(Math.ceil(vocabSize / 32));
    const eligible =
      this.engine.kind === "regex"
        ? this.computeRegexMask(mask)
        : this.computeJsonMask(mask);
    this.maskCache = eligible === 0 ? { stop: true } : { mask, vocabSize };
    return cloneMaskResult(this.maskCache);
  }

  commitToken(token: number): { stop: boolean; backtrack: 0; ffTokens: [] } {
    this.assertLive();
    const vocabSize = this.tokenizer.vocabSize();
    if (!Number.isInteger(token) || token < 0 || token >= vocabSize) {
      throw new RangeError(
        `token ${String(token)} is out of range for vocabulary size ${vocabSize}`,
      );
    }
    if (this.stopped || !this.tokenAllowed(token)) {
      throw new Error(`token ${token} doesn't satisfy the grammar`);
    }

    if (token === this.tokenizer.eosToken()) {
      this.stopped = true;
      this.maskCache = null;
      return { stop: true, backtrack: 0, ffTokens: [] };
    }

    const bytes = getTokenizerData(this.tokenizer).tokenBytes[token];
    if (this.engine.kind === "regex") {
      this.engine.state = this.engine.compiled.advance(
        this.engine.state,
        bytes,
      );
    } else {
      this.engine.bytes = appendBytes(this.engine.bytes, bytes);
    }
    this.maskCache = null;
    return { stop: false, backtrack: 0, ffTokens: [] };
  }

  free(): void {
    this.maskCache = null;
    this.freed = true;
  }

  dispose(): void {
    this.free();
  }

  private computeRegexMask(mask: Uint32Array): number {
    if (this.engine.kind !== "regex") throw new Error("invalid regex engine");
    const data = getTokenizerData(this.tokenizer);
    const { compiled, state } = this.engine;
    let eligible = 0;
    if (compiled.accepting(state)) {
      setMaskBit(mask, data.eos);
      eligible += 1;
    }

    const stack: Array<{ node: TokenTrieNode; state: RegexState }> = [
      { node: data.trie, state },
    ];
    while (stack.length !== 0) {
      const current = stack.pop()!;
      for (const token of current.node.terminalTokenIds) {
        if (token === data.eos || isSpecialToken(data, token)) continue;
        setMaskBit(mask, token);
        eligible += 1;
      }
      for (const [byte, child] of current.node.children) {
        const candidate = compiled.advance(current.state, singleBytes[byte]);
        if (compiled.viable(candidate))
          stack.push({ node: child, state: candidate });
      }
    }
    return eligible;
  }

  private computeJsonMask(mask: Uint32Array): number {
    if (this.engine.kind !== "json") throw new Error("invalid JSON engine");
    const data = getTokenizerData(this.tokenizer);
    let eligible = 0;
    if (this.engine.compiled.acceptsUtf8(this.engine.bytes)) {
      setMaskBit(mask, data.eos);
      eligible += 1;
    }

    const stack = [data.trie];
    while (stack.length !== 0) {
      const node = stack.pop()!;
      const firstNormal = node.terminalTokenIds.find(
        (token) => token !== data.eos && !isSpecialToken(data, token),
      );
      if (firstNormal !== undefined) {
        const bytes = data.tokenBytes[firstNormal];
        if (
          this.engine.compiled.isUtf8PrefixViable(
            appendBytes(this.engine.bytes, bytes),
          )
        ) {
          for (const token of node.terminalTokenIds) {
            if (token === data.eos || isSpecialToken(data, token)) continue;
            setMaskBit(mask, token);
            eligible += 1;
          }
        }
      }
      for (const child of node.children.values()) stack.push(child);
    }
    return eligible;
  }

  private tokenAllowed(token: number): boolean {
    if (token === this.tokenizer.eosToken()) return this.accepting();
    if (this.tokenizer.isSpecial(token)) return false;

    const bytes = getTokenizerData(this.tokenizer).tokenBytes[token];
    if (this.engine.kind === "regex") {
      const candidate = this.engine.compiled.advance(this.engine.state, bytes);
      return this.engine.compiled.viable(candidate);
    }
    return this.engine.compiled.isUtf8PrefixViable(
      appendBytes(this.engine.bytes, bytes),
    );
  }

  private accepting(): boolean {
    return this.engine.kind === "regex"
      ? this.engine.compiled.accepting(this.engine.state)
      : this.engine.compiled.acceptsUtf8(this.engine.bytes);
  }

  private assertLive(): void {
    if (this.freed) throw new Error("LLGuidanceInterpreter has been freed");
  }
}

export function grammarFrom(format: string, text: string): string {
  if (typeof format !== "string")
    throw new TypeError("grammar format must be a string");
  if (typeof text !== "string")
    throw new TypeError("grammar text must be a string");
  switch (format) {
    case "regex":
      return serializeMarker("regex", text);
    case "json":
    case "json_schema":
      return serializeMarker("json_schema", parseJson(text, "JSON schema"));
    case "json_object":
      return serializeMarker("json_schema", { type: "object" });
    case "choice": {
      const choices = parseJson(text, "choice list");
      if (
        !Array.isArray(choices) ||
        choices.some((choice) => typeof choice !== "string")
      ) {
        throw new TypeError("choice list must be a JSON array of strings");
      }
      const alternatives = choices.map(regexByteLiteral).join("|");
      return serializeMarker("regex", `(?:${alternatives})`);
    }
    case "lark":
      return grammarFromLark(text);
    case "llguidance":
    case "guidance":
      parseMarker(text, UPSTREAM_UNSUPPORTED);
      return text;
    default:
      throw new Error(`unknown grammar format: ${format}`);
  }
}

export function grammarFromJsonSchema(schema: unknown): string {
  return serializeMarker("json_schema", schema);
}

export function grammarFromLark(lark: string): string {
  if (typeof lark !== "string")
    throw new TypeError("Lark grammar must be a string");
  return serializeMarker("lark", lark);
}

export function grammarFromRegex(regex: string): string {
  if (typeof regex !== "string") throw new TypeError("regex must be a string");
  return serializeMarker("regex", regex);
}

function markerFromInterpreterConfig(config: unknown): Marker {
  if (config === null || typeof config !== "object") {
    throw new TypeError("interpreter config must be an object");
  }
  const value = config as Record<string, unknown>;
  if (value.grammar !== undefined) {
    if (typeof value.grammar !== "string") {
      throw new TypeError("interpreter grammar must be a string");
    }
    const format = value.grammarFormat ?? value.grammar_format;
    if (format !== undefined) {
      if (typeof format !== "string")
        throw new TypeError("grammar format must be a string");
      return parseMarker(grammarFrom(format, value.grammar));
    }
    return parseMarker(value.grammar);
  }

  const response = value.response_format ?? value.responseFormat;
  if (response !== undefined) return markerFromResponseFormat(response);
  throw new Error("interpreter config requires grammar or response_format");
}

function markerFromResponseFormat(response: unknown): Marker {
  if (response === null || typeof response !== "object") {
    throw new TypeError("response_format must be an object");
  }
  const value = response as Record<string, unknown>;
  switch (value.type) {
    case "regex":
      if (typeof value.regex !== "string")
        throw new TypeError("response_format.regex must be a string");
      return makeMarker("regex", value.regex);
    case "json_schema":
      if (!("json_schema" in value))
        throw new TypeError("response_format.json_schema is required");
      return makeMarker("json_schema", value.json_schema);
    case "json_object":
      return makeMarker("json_schema", { type: "object" });
    default:
      throw new Error(
        `unsupported response_format type: ${String(value.type)}`,
      );
  }
}

function serializeMarker(type: Marker["type"], value: unknown): string {
  const serialized = JSON.stringify(makeMarker(type, value));
  if (serialized === undefined)
    throw new TypeError("grammar value is not JSON serializable");
  return serialized;
}

function makeMarker(type: Marker["type"], value: unknown): Marker {
  return { [MARKER_KEY]: MARKER_VERSION, type, value } as Marker;
}

function parseMarker(
  serialized: string,
  invalidMessage = LARK_UNSUPPORTED,
): Marker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(invalidMessage);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as Record<string, unknown>)[MARKER_KEY] !== MARKER_VERSION ||
    !["regex", "json_schema", "lark"].includes(
      String((parsed as Record<string, unknown>).type),
    ) ||
    !("value" in parsed)
  ) {
    throw new Error(UPSTREAM_UNSUPPORTED);
  }
  return parsed as Marker;
}

function normalizeTokenBytes(
  token: Uint8Array | readonly number[],
  tokenId: number,
): Uint8Array {
  if (!(token instanceof Uint8Array) && !Array.isArray(token)) {
    throw new TypeError(`token ${tokenId} must be a raw byte array`);
  }
  const values = Array.from(token);
  if (
    values.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new RangeError(`token ${tokenId} contains a byte out of range`);
  }
  return Uint8Array.from(values);
}

function buildTokenTrie(tokens: readonly Uint8Array[]): TokenTrieNode {
  const root: TokenTrieNode = { children: new Map(), terminalTokenIds: [] };
  tokens.forEach((bytes, tokenId) => {
    let node = root;
    for (const byte of bytes) {
      let child = node.children.get(byte);
      if (child === undefined) {
        child = { children: new Map(), terminalTokenIds: [] };
        node.children.set(byte, child);
      }
      node = child;
    }
    node.terminalTokenIds.push(tokenId);
  });
  return root;
}

function getTokenizerData(tokenizer: LLGuidanceTokenizer): TokenizerData {
  const data = tokenizerData.get(tokenizer);
  if (data === undefined) throw new Error("invalid tokenizer state");
  return data;
}

function isSpecialToken(data: TokenizerData, token: number): boolean {
  return data.special.has(token) || data.tokenBytes[token].length === 0;
}

function setMaskBit(mask: Uint32Array, token: number): void {
  mask[token >>> 5] |= 1 << (token & 31);
}

function cloneMaskResult(result: MaskResult): MaskResult {
  return "mask" in result
    ? { mask: result.mask.slice(), vocabSize: result.vocabSize }
    : { stop: true };
}

function assertTokenId(id: number, vocabSize: number, name: string): void {
  if (!Number.isInteger(id) || id < 0 || id >= vocabSize) {
    throw new RangeError(
      `${name} is out of range for vocabulary size ${vocabSize}`,
    );
  }
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(
      `invalid ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function regexByteLiteral(value: string): string {
  return Array.from(
    new TextEncoder().encode(value),
    (byte) => `\\x${byte.toString(16).padStart(2, "0")}`,
  ).join("");
}
