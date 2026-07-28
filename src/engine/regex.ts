const OP_BYTE = 0;
const OP_SPLIT = 1;
const OP_JUMP = 2;
const OP_START = 3;
const OP_END = 4;
const OP_MATCH = 5;

const NO_STATE = 0xffffffff;
const DEFAULT_MAX_REPEAT = 10_000;
const DEFAULT_MAX_STATES = 100_000;
const MAX_CACHED_DFA_STATES = 4_096;

export interface RegexCompileOptions {
  maxRegexRepeat?: number;
  maxRegexStates?: number;
}

type Ast =
  | { kind: "empty" }
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "set"; set: Uint32Array }
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "concat"; parts: Ast[] }
  | { kind: "alt"; parts: Ast[] }
  | { kind: "repeat"; child: Ast; min: number; max: number | null };

type Fragment = { start: number; outs: number[] };

const stateBrand: unique symbol = Symbol("RegexState");

/** An opaque, immutable snapshot of an incremental regex match. */
export interface RegexState {
  readonly [stateBrand]: true;
}

/** A compiled full-match byte regex. */
export interface CompiledRegex {
  readonly source: string;
  readonly initialState: RegexState;
  advance(state: RegexState, bytes: Uint8Array): RegexState;
  viable(state: RegexState): boolean;
  accepting(state: RegexState): boolean;
}

type StateData =
  | { owner: CompiledRegexImpl; cached: true; id: number }
  | {
      owner: CompiledRegexImpl;
      cached: false;
      active: Uint32Array;
      atStart: boolean;
    };

type StatePayload =
  | { cached: true; id: number }
  | { cached: false; active: Uint32Array; atStart: boolean };

type DfaState = {
  active: Uint32Array;
  atStart: boolean;
  state: RegexState;
  transitions?: Uint32Array;
  viable: boolean;
  accepting: boolean | undefined;
};

const stateData = new WeakMap<object, StateData>();

function makeState(owner: CompiledRegexImpl, data: StatePayload): RegexState {
  const state = Object.freeze({}) as RegexState;
  stateData.set(state, { owner, ...data } as StateData);
  return state;
}

function emptySet(): Uint32Array {
  return new Uint32Array(8);
}

function addByte(set: Uint32Array, byte: number): void {
  set[byte >>> 5] |= 1 << (byte & 31);
}

function addRange(set: Uint32Array, first: number, last: number): void {
  for (let byte = first; byte <= last; byte++) addByte(set, byte);
}

function unionInto(target: Uint32Array, source: Uint32Array): void {
  for (let i = 0; i < 8; i++) target[i] |= source[i];
}

function invertSet(set: Uint32Array): Uint32Array {
  const result = new Uint32Array(8);
  for (let i = 0; i < 8; i++) result[i] = ~set[i];
  return result;
}

function setHas(set: Uint32Array, byte: number): boolean {
  return (set[byte >>> 5] & (1 << (byte & 31))) !== 0;
}

function setIsEmpty(set: Uint32Array): boolean {
  for (let i = 0; i < 8; i++) if (set[i] !== 0) return false;
  return true;
}

function byteRangeAst(first: number, last: number): Ast {
  const set = emptySet();
  addRange(set, first, last);
  return { kind: "set", set };
}

function unicodeScalarAst(includeAscii = true): Ast {
  const continuation = byteRangeAst(0x80, 0xbf);
  const parts: Ast[] = [];
  if (includeAscii) parts.push(byteRangeAst(0x00, 0x7f));
  parts.push(
    { kind: "concat", parts: [byteRangeAst(0xc2, 0xdf), continuation] },
    {
      kind: "concat",
      parts: [byteRangeAst(0xe0, 0xe0), byteRangeAst(0xa0, 0xbf), continuation],
    },
    {
      kind: "concat",
      parts: [byteRangeAst(0xe1, 0xec), continuation, continuation],
    },
    {
      kind: "concat",
      parts: [byteRangeAst(0xed, 0xed), byteRangeAst(0x80, 0x9f), continuation],
    },
    {
      kind: "concat",
      parts: [byteRangeAst(0xee, 0xef), continuation, continuation],
    },
    {
      kind: "concat",
      parts: [
        byteRangeAst(0xf0, 0xf0),
        byteRangeAst(0x90, 0xbf),
        continuation,
        continuation,
      ],
    },
    {
      kind: "concat",
      parts: [
        byteRangeAst(0xf1, 0xf3),
        continuation,
        continuation,
        continuation,
      ],
    },
    {
      kind: "concat",
      parts: [
        byteRangeAst(0xf4, 0xf4),
        byteRangeAst(0x80, 0x8f),
        continuation,
        continuation,
      ],
    },
  );
  return { kind: "alt", parts };
}

function shorthandSet(code: string): Uint32Array | null {
  const set = emptySet();
  switch (code) {
    case "d":
    case "D":
      addRange(set, 0x30, 0x39);
      break;
    case "w":
    case "W":
      addRange(set, 0x30, 0x39);
      addRange(set, 0x41, 0x5a);
      addByte(set, 0x5f);
      addRange(set, 0x61, 0x7a);
      break;
    case "s":
    case "S":
      addByte(set, 0x09);
      addByte(set, 0x0a);
      addByte(set, 0x0b);
      addByte(set, 0x0c);
      addByte(set, 0x0d);
      addByte(set, 0x20);
      break;
    default:
      return null;
  }
  return code === code.toUpperCase() ? invertSet(set) : set;
}

class Parser {
  private readonly source: string;
  private index = 0;
  private readonly encoder = new TextEncoder();

  private readonly maxRepeat: number;

  constructor(source: string, maxRepeat: number) {
    this.source = source;
    this.maxRepeat = maxRepeat;
  }

  parse(): Ast {
    const ast = this.parseAlternation();
    if (this.index !== this.source.length) {
      this.fail(`unexpected '${this.source[this.index]}'`);
    }
    return ast;
  }

  private fail(message: string, index = this.index): never {
    throw new SyntaxError(`invalid regex at index ${index}: ${message}`);
  }

  private peek(offset = 0): string | undefined {
    return this.source[this.index + offset];
  }

  private parseAlternation(): Ast {
    const parts = [this.parseConcatenation()];
    while (this.peek() === "|") {
      this.index++;
      parts.push(this.parseConcatenation());
    }
    return parts.length === 1 ? parts[0] : { kind: "alt", parts };
  }

  private parseConcatenation(): Ast {
    const parts: Ast[] = [];
    while (
      this.index < this.source.length &&
      this.peek() !== ")" &&
      this.peek() !== "|"
    ) {
      parts.push(this.parseQuantified());
    }
    if (parts.length === 0) return { kind: "empty" };
    return parts.length === 1 ? parts[0] : { kind: "concat", parts };
  }

  private parseQuantified(): Ast {
    const atomIndex = this.index;
    const child = this.parseAtom();
    const next = this.peek();
    if (next !== "*" && next !== "+" && next !== "?" && next !== "{") {
      return child;
    }
    if (child.kind === "start" || child.kind === "end") {
      this.fail("anchors cannot be quantified", atomIndex);
    }

    let min: number;
    let max: number | null;
    if (next === "*") {
      this.index++;
      min = 0;
      max = null;
    } else if (next === "+") {
      this.index++;
      min = 1;
      max = null;
    } else if (next === "?") {
      this.index++;
      min = 0;
      max = 1;
    } else {
      [min, max] = this.parseBounds();
    }

    if (this.peek() === "?") {
      this.fail("lazy quantifiers are not supported");
    }
    if (this.peek() === "+") {
      this.fail("possessive quantifiers are not supported");
    }
    if (this.peek() === "*" || this.peek() === "{") {
      this.fail("multiple quantifiers are not supported");
    }
    return { kind: "repeat", child, min, max };
  }

  private parseBounds(): [number, number | null] {
    const open = this.index++;
    const min = this.parseDecimal("expected a repetition count", open);
    let max: number | null;
    if (this.peek() === "}") {
      this.index++;
      max = min;
    } else if (this.peek() === ",") {
      this.index++;
      max =
        this.peek() === "}"
          ? null
          : this.parseDecimal("expected an upper bound");
      if (this.peek() !== "}") this.fail("unterminated repetition");
      this.index++;
    } else {
      this.fail("expected ',' or '}' in repetition");
    }
    if (max !== null && max < min)
      this.fail("repetition upper bound is less than lower bound", open);
    if (min > this.maxRepeat || (max !== null && max > this.maxRepeat)) {
      this.fail(`repetition count exceeds ${this.maxRepeat}`, open);
    }
    return [min, max];
  }

  private parseDecimal(message: string, errorIndex = this.index): number {
    const start = this.index;
    let value = 0;
    while (
      this.peek() !== undefined &&
      this.peek()! >= "0" &&
      this.peek()! <= "9"
    ) {
      value = value * 10 + (this.source.charCodeAt(this.index++) - 0x30);
      if (value > this.maxRepeat)
        this.fail(`repetition count exceeds ${this.maxRepeat}`, start);
    }
    if (this.index === start) this.fail(message, errorIndex);
    return value;
  }

  private parseAtom(): Ast {
    const char = this.peek();
    if (char === undefined) this.fail("expected an expression");
    if (char === "(") return this.parseGroup();
    if (char === "[") return this.parseClass();
    if (char === ".") {
      this.index++;
      return unicodeScalarAst();
    }
    if (char === "^") {
      this.index++;
      return { kind: "start" };
    }
    if (char === "$") {
      this.index++;
      return { kind: "end" };
    }
    if (char === "\\") return this.parseEscape(false).ast;
    if (char === ")") this.fail("unmatched ')'");
    if (char === "*" || char === "+" || char === "?" || char === "{") {
      this.fail(`quantifier '${char}' has no target`);
    }
    return this.literalAst(this.readCodePoint());
  }

  private parseGroup(): Ast {
    const open = this.index++;
    if (this.peek() === "?") {
      if (this.peek(1) !== ":") {
        this.fail(
          "only noncapturing '(?:...)' special groups are supported",
          open,
        );
      }
      this.index += 2;
    }
    const child = this.parseAlternation();
    if (this.peek() !== ")") this.fail("unterminated group", open);
    this.index++;
    return child;
  }

  private parseClass(): Ast {
    const open = this.index++;
    const negated = this.peek() === "^";
    if (negated) this.index++;
    const result = emptySet();
    const unicode: Ast[] = [];

    while (this.peek() !== "]") {
      if (this.peek() === undefined)
        this.fail("unterminated character class", open);
      const first = this.parseClassAtom();
      if (
        this.peek() === "-" &&
        this.peek(1) !== "]" &&
        this.peek(1) !== undefined
      ) {
        const dash = this.index++;
        const last = this.parseClassAtom();
        if (
          first.single === null ||
          last.single === null ||
          first.single > 0x7f ||
          last.single > 0x7f
        ) {
          this.fail("character class ranges require ASCII endpoints", dash);
        }
        if (last.single < first.single)
          this.fail("character class range is out of order", dash);
        addRange(result, first.single, last.single);
      } else {
        if (first.set !== null) unionInto(result, first.set);
        else unicode.push(first.ast);
      }
    }
    this.index++;
    if (negated) {
      if (unicode.length !== 0) {
        this.fail(
          "negated classes with non-ASCII members are not supported",
          open,
        );
      }
      const ascii = emptySet();
      for (let byte = 0; byte <= 0x7f; byte += 1) {
        if (!setHas(result, byte)) addByte(ascii, byte);
      }
      return {
        kind: "alt",
        parts: [{ kind: "set", set: ascii }, unicodeScalarAst(false)],
      };
    }
    const parts = unicode;
    if (!setIsEmpty(result)) parts.unshift({ kind: "set", set: result });
    return parts.length === 1 ? parts[0] : { kind: "alt", parts };
  }

  private parseClassAtom(): {
    ast: Ast;
    set: Uint32Array | null;
    single: number | null;
  } {
    if (this.peek() === "\\") {
      const escaped = this.parseEscape(true);
      if (escaped.set !== null) return escaped;
      this.fail("invalid escape in character class");
    }
    const codePoint = this.readCodePoint();
    const set = emptySet();
    if (codePoint <= 0x7f) addByte(set, codePoint);
    return {
      ast: this.literalAst(codePoint),
      set: codePoint <= 0x7f ? set : null,
      single: codePoint,
    };
  }

  private parseEscape(inClass: boolean): {
    ast: Ast;
    set: Uint32Array | null;
    single: number | null;
  } {
    const slash = this.index++;
    const code = this.peek();
    if (code === undefined) this.fail("trailing backslash", slash);
    this.index++;

    const shorthand = shorthandSet(code);
    if (shorthand !== null) {
      return {
        ast: { kind: "set", set: shorthand },
        set: shorthand,
        single: null,
      };
    }
    if (code >= "1" && code <= "9")
      this.fail("backreferences are not supported", slash);
    if (code === "b" && !inClass)
      this.fail("word-boundary assertions are not supported", slash);
    if (code === "p" || code === "P" || code === "k") {
      this.fail(`\\${code} escapes are not supported`, slash);
    }

    let value: number;
    switch (code) {
      case "n":
        value = 0x0a;
        break;
      case "r":
        value = 0x0d;
        break;
      case "t":
        value = 0x09;
        break;
      case "f":
        value = 0x0c;
        break;
      case "v":
        value = 0x0b;
        break;
      case "b":
        value = 0x08;
        break;
      case "0":
        if ((this.peek() ?? "") >= "0" && (this.peek() ?? "") <= "9") {
          this.fail("octal escapes are not supported", slash);
        }
        value = 0;
        break;
      case "x":
        value = this.readHex(2, slash);
        break;
      case "u":
        value = this.readUnicodeEscape(slash);
        break;
      default:
        if (!"\\.^$|?*+()[]{}-".includes(code)) {
          this.fail(`unsupported escape \\${code}`, slash);
        }
        value = code.codePointAt(0)!;
    }

    const set = emptySet();
    if (value <= 0x7f) addByte(set, value);
    return {
      ast: this.literalAst(value),
      set: value <= 0x7f ? set : null,
      single: value,
    };
  }

  private readHex(length: number, errorIndex: number): number {
    if (this.index + length > this.source.length)
      this.fail("incomplete hexadecimal escape", errorIndex);
    let value = 0;
    for (let i = 0; i < length; i++) {
      const digit = this.source.charCodeAt(this.index++);
      if (digit >= 0x30 && digit <= 0x39) value = value * 16 + digit - 0x30;
      else if (digit >= 0x41 && digit <= 0x46)
        value = value * 16 + digit - 0x41 + 10;
      else if (digit >= 0x61 && digit <= 0x66)
        value = value * 16 + digit - 0x61 + 10;
      else this.fail("invalid hexadecimal escape", this.index - 1);
    }
    return value;
  }

  private readUnicodeEscape(errorIndex: number): number {
    let value: number;
    if (this.peek() === "{") {
      this.index++;
      const start = this.index;
      value = 0;
      while (this.peek() !== "}") {
        if (this.peek() === undefined || this.index - start >= 6) {
          this.fail("invalid Unicode escape", errorIndex);
        }
        const before = this.index;
        value = value * 16 + this.readHex(1, errorIndex);
        if (this.index === before)
          this.fail("invalid Unicode escape", errorIndex);
      }
      if (this.index === start) this.fail("empty Unicode escape", errorIndex);
      this.index++;
    } else {
      value = this.readHex(4, errorIndex);
    }
    if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      this.fail("Unicode escape is not a scalar value", errorIndex);
    }
    return value;
  }

  private readCodePoint(): number {
    const value = this.source.codePointAt(this.index)!;
    if (value >= 0xd800 && value <= 0xdfff)
      this.fail("lone UTF-16 surrogate is not supported");
    this.index += value > 0xffff ? 2 : 1;
    return value;
  }

  private literalAst(codePoint: number): Ast {
    return {
      kind: "bytes",
      bytes: this.encoder.encode(String.fromCodePoint(codePoint)),
    };
  }
}

class Builder {
  readonly ops: number[] = [];
  readonly out1: number[] = [];
  readonly out2: number[] = [];
  readonly setIndex: number[] = [];
  readonly sets: Uint32Array[] = [];
  private readonly setIds = new Map<string, number>();
  private readonly maxStates: number;

  constructor(maxStates: number) {
    this.maxStates = maxStates;
  }

  emit(op: number, out1 = NO_STATE, out2 = NO_STATE, set = NO_STATE): number {
    if (this.ops.length >= this.maxStates) {
      throw new SyntaxError(
        `Regex compiles to more than ${this.maxStates} NFA states`,
      );
    }
    const index = this.ops.length;
    this.ops.push(op);
    this.out1.push(out1);
    this.out2.push(out2);
    this.setIndex.push(set);
    return index;
  }

  patch(outs: number[], target: number): void {
    for (const patch of outs) {
      const state = patch >>> 1;
      if ((patch & 1) === 0) this.out1[state] = target;
      else this.out2[state] = target;
    }
  }

  byteSet(set: Uint32Array): number {
    let key = "";
    for (let i = 0; i < 8; i++) key += `${set[i].toString(16)},`;
    const previous = this.setIds.get(key);
    if (previous !== undefined) return previous;
    const index = this.sets.length;
    this.sets.push(set);
    this.setIds.set(key, index);
    return index;
  }

  compile(ast: Ast): Fragment {
    switch (ast.kind) {
      case "empty": {
        const state = this.emit(OP_JUMP);
        return { start: state, outs: [state << 1] };
      }
      case "bytes": {
        if (ast.bytes.length === 0) return this.compile({ kind: "empty" });
        let fragment: Fragment | null = null;
        for (const byte of ast.bytes) {
          const set = emptySet();
          addByte(set, byte);
          fragment = this.concatenate(fragment, this.setFragment(set));
        }
        return fragment!;
      }
      case "set":
        return this.setFragment(ast.set);
      case "start": {
        const state = this.emit(OP_START);
        return { start: state, outs: [state << 1] };
      }
      case "end": {
        const state = this.emit(OP_END);
        return { start: state, outs: [state << 1] };
      }
      case "concat": {
        let result: Fragment | null = null;
        for (const part of ast.parts)
          result = this.concatenate(result, this.compile(part));
        return result ?? this.compile({ kind: "empty" });
      }
      case "alt": {
        let result = this.compile(ast.parts[0]);
        for (let i = 1; i < ast.parts.length; i++) {
          const right = this.compile(ast.parts[i]);
          const split = this.emit(OP_SPLIT, result.start, right.start);
          result = { start: split, outs: result.outs.concat(right.outs) };
        }
        return result;
      }
      case "repeat":
        return this.compileRepeat(ast);
    }
  }

  private concatenate(left: Fragment | null, right: Fragment): Fragment {
    if (left === null) return right;
    this.patch(left.outs, right.start);
    return { start: left.start, outs: right.outs };
  }

  private setFragment(set: Uint32Array): Fragment {
    const state = this.emit(OP_BYTE, NO_STATE, NO_STATE, this.byteSet(set));
    return { start: state, outs: [state << 1] };
  }

  private compileRepeat(ast: Extract<Ast, { kind: "repeat" }>): Fragment {
    let result: Fragment | null = null;
    for (let i = 0; i < ast.min; i++)
      result = this.concatenate(result, this.compile(ast.child));

    if (ast.max === null) {
      const child = this.compile(ast.child);
      const split = this.emit(OP_SPLIT, child.start);
      this.patch(child.outs, split);
      result = this.concatenate(result, {
        start: split,
        outs: [(split << 1) | 1],
      });
    } else {
      for (let i = ast.min; i < ast.max; i++) {
        const child = this.compile(ast.child);
        const split = this.emit(OP_SPLIT, child.start);
        result = this.concatenate(result, {
          start: split,
          outs: child.outs.concat((split << 1) | 1),
        });
      }
    }
    return result ?? this.compile({ kind: "empty" });
  }
}

class CompiledRegexImpl implements CompiledRegex {
  readonly source: string;
  readonly initialState: RegexState;
  private readonly ops: Uint8Array;
  private readonly out1: Uint32Array;
  private readonly out2: Uint32Array;
  private readonly setIndex: Uint32Array;
  private readonly sets: readonly Uint32Array[];
  private readonly canReachMatch: Uint8Array;
  private readonly closureMarks: Uint32Array;
  private readonly closureStack: Uint32Array;
  private readonly closureResult: Uint32Array;
  private readonly closureGeneration = new Uint32Array(1);
  private readonly transitionSeeds: Uint32Array;
  private readonly dfaStates: DfaState[] = [];
  private readonly dfaBuckets = new Map<number, number[]>();

  constructor(source: string, builder: Builder, start: number) {
    this.source = source;
    this.ops = Uint8Array.from(builder.ops);
    this.out1 = Uint32Array.from(builder.out1);
    this.out2 = Uint32Array.from(builder.out2);
    this.setIndex = Uint32Array.from(builder.setIndex);
    this.sets = Object.freeze(builder.sets.slice());
    this.canReachMatch = this.computeReachability();
    this.closureMarks = new Uint32Array(this.ops.length);
    this.closureStack = new Uint32Array(this.ops.length);
    this.closureResult = new Uint32Array(this.ops.length);
    this.transitionSeeds = new Uint32Array(this.ops.length);
    const initialActive = this.closure(Uint32Array.of(start), true, false);
    const initialId = this.intern(initialActive, true);
    this.initialState = this.dfaStates[initialId].state;
    Object.freeze(this);
  }

  advance(state: RegexState, bytes: Uint8Array): RegexState {
    const data = this.getState(state);
    if (!(bytes instanceof Uint8Array))
      throw new TypeError("bytes must be a Uint8Array");
    if (bytes.length === 0) return state;

    let id = data.cached ? data.id : NO_STATE;
    let active = data.cached ? this.dfaStates[data.id].active : data.active;
    let atStart = data.cached ? this.dfaStates[data.id].atStart : data.atStart;
    for (const byte of bytes) {
      if (id !== NO_STATE) {
        const cached = this.dfaStates[id];
        let transitions = cached.transitions;
        if (transitions === undefined) {
          transitions = new Uint32Array(256);
          transitions.fill(NO_STATE);
          cached.transitions = transitions;
        }
        const target = transitions[byte];
        if (target !== NO_STATE) {
          id = target;
          active = this.dfaStates[target].active;
          atStart = false;
          if (active.length === 0) break;
          continue;
        }
      }

      let count = 0;
      for (let i = 0; i < active.length; i++) {
        const pc = active[i];
        if (
          this.ops[pc] === OP_BYTE &&
          setHas(this.sets[this.setIndex[pc]], byte)
        ) {
          this.transitionSeeds[count++] = this.out1[pc];
        }
      }
      atStart = false;
      active =
        count === 0
          ? new Uint32Array(0)
          : this.closure(this.transitionSeeds.subarray(0, count), false, false);
      const sourceId = id;
      id = this.intern(active, false);
      if (sourceId !== NO_STATE && id !== NO_STATE) {
        this.dfaStates[sourceId].transitions![byte] = id;
      }
      if (active.length === 0) break;
    }
    return id === NO_STATE
      ? makeState(this, { cached: false, active, atStart })
      : this.dfaStates[id].state;
  }

  viable(state: RegexState): boolean {
    const data = this.getState(state);
    if (data.cached) return this.dfaStates[data.id].viable;
    const context = data.atStart ? 1 : 0;
    for (const pc of data.active) {
      if (this.canReachMatch[(pc << 2) | context] !== 0) return true;
    }
    return false;
  }

  accepting(state: RegexState): boolean {
    const data = this.getState(state);
    if (!data.cached) {
      return this.isAccepting(data.active, data.atStart);
    }
    const cached = this.dfaStates[data.id];
    if (cached.accepting === undefined) {
      cached.accepting = this.isAccepting(cached.active, cached.atStart);
    }
    return cached.accepting;
  }

  private getState(state: RegexState): StateData {
    const data = stateData.get(state as object);
    if (data === undefined || data.owner !== this) {
      throw new TypeError("state was not created by this compiled regex");
    }
    return data;
  }

  private intern(active: Uint32Array, atStart: boolean): number {
    active.sort();
    let hash = atStart ? 0x9e3779b9 : 0x811c9dc5;
    for (let i = 0; i < active.length; i++) {
      hash = Math.imul(hash ^ active[i], 0x01000193) >>> 0;
    }
    const bucket = this.dfaBuckets.get(hash);
    if (bucket !== undefined) {
      candidate: for (const id of bucket) {
        const candidate = this.dfaStates[id];
        if (
          candidate.atStart !== atStart ||
          candidate.active.length !== active.length
        ) {
          continue;
        }
        for (let i = 0; i < active.length; i++) {
          if (candidate.active[i] !== active[i]) continue candidate;
        }
        return id;
      }
    }
    if (this.dfaStates.length >= MAX_CACHED_DFA_STATES) return NO_STATE;

    const id = this.dfaStates.length;
    const state = makeState(this, { cached: true, id });
    const context = atStart ? 1 : 0;
    let viable = false;
    for (let i = 0; i < active.length; i++) {
      if (this.canReachMatch[(active[i] << 2) | context] !== 0) {
        viable = true;
        break;
      }
    }
    this.dfaStates.push({
      active,
      atStart,
      state,
      viable,
      accepting: undefined,
    });
    if (bucket === undefined) this.dfaBuckets.set(hash, [id]);
    else bucket.push(id);
    return id;
  }

  private isAccepting(active: Uint32Array, atStart: boolean): boolean {
    const ended = this.closure(active, atStart, true);
    for (const pc of ended) if (this.ops[pc] === OP_MATCH) return true;
    return false;
  }

  private closure(
    seeds: Uint32Array,
    atStart: boolean,
    atEnd: boolean,
  ): Uint32Array {
    let generation = (this.closureGeneration[0] + 1) >>> 0;
    if (generation === 0) {
      this.closureMarks.fill(0);
      generation = 1;
    }
    this.closureGeneration[0] = generation;
    const seen = this.closureMarks;
    const stack = this.closureStack;
    const result = this.closureResult;
    let stackLength = 0;
    let resultLength = 0;
    for (const seed of seeds) {
      if (seed !== NO_STATE && seen[seed] !== generation) {
        seen[seed] = generation;
        stack[stackLength++] = seed;
      }
    }

    while (stackLength !== 0) {
      const pc = stack[--stackLength];
      const op = this.ops[pc];
      if (
        op === OP_JUMP ||
        (op === OP_START && atStart) ||
        (op === OP_END && atEnd)
      ) {
        const next = this.out1[pc];
        if (next !== NO_STATE && seen[next] !== generation) {
          seen[next] = generation;
          stack[stackLength++] = next;
        }
      } else if (op === OP_SPLIT) {
        const first = this.out1[pc];
        const second = this.out2[pc];
        if (first !== NO_STATE && seen[first] !== generation) {
          seen[first] = generation;
          stack[stackLength++] = first;
        }
        if (second !== NO_STATE && seen[second] !== generation) {
          seen[second] = generation;
          stack[stackLength++] = second;
        }
      } else if (op === OP_START) {
        // A failed start assertion contributes no active state.
      } else {
        result[resultLength++] = pc;
      }
    }
    return result.slice(0, resultLength);
  }

  private computeReachability(): Uint8Array {
    const configurations = this.ops.length * 4;
    const incoming = new Uint32Array(configurations);
    const edges: Array<[number, number]> = [];

    const addEdge = (from: number, toPc: number, toContext: number): void => {
      if (toPc === NO_STATE) return;
      const to = (toPc << 2) | toContext;
      edges.push([from, to]);
      incoming[to]++;
    };

    for (let pc = 0; pc < this.ops.length; pc++) {
      for (let context = 0; context < 4; context++) {
        const from = (pc << 2) | context;
        const atStart = (context & 1) !== 0;
        const ended = (context & 2) !== 0;
        switch (this.ops[pc]) {
          case OP_BYTE:
            if (!ended && !setIsEmpty(this.sets[this.setIndex[pc]]))
              addEdge(from, this.out1[pc], 0);
            break;
          case OP_SPLIT:
            addEdge(from, this.out1[pc], context);
            addEdge(from, this.out2[pc], context);
            break;
          case OP_JUMP:
            addEdge(from, this.out1[pc], context);
            break;
          case OP_START:
            if (atStart) addEdge(from, this.out1[pc], context);
            break;
          case OP_END:
            addEdge(from, this.out1[pc], context | 2);
            break;
        }
      }
    }

    const offsets = new Uint32Array(configurations + 1);
    for (let i = 0; i < configurations; i++)
      offsets[i + 1] = offsets[i] + incoming[i];
    const cursor = offsets.slice(0, configurations);
    const reverse = new Uint32Array(edges.length);
    for (const [from, to] of edges) reverse[cursor[to]++] = from;

    const reachable = new Uint8Array(configurations);
    const queue = new Uint32Array(configurations);
    let read = 0;
    let write = 0;
    for (let pc = 0; pc < this.ops.length; pc++) {
      if (this.ops[pc] !== OP_MATCH) continue;
      for (let context = 0; context < 4; context++) {
        const configuration = (pc << 2) | context;
        reachable[configuration] = 1;
        queue[write++] = configuration;
      }
    }
    while (read < write) {
      const configuration = queue[read++];
      for (
        let i = offsets[configuration];
        i < offsets[configuration + 1];
        i++
      ) {
        const predecessor = reverse[i];
        if (reachable[predecessor] === 0) {
          reachable[predecessor] = 1;
          queue[write++] = predecessor;
        }
      }
    }
    return reachable;
  }
}

/** Compile a regex whose language is matched against the complete byte string. */
export function compileRegex(
  source: string,
  options: RegexCompileOptions = {},
): CompiledRegex {
  if (typeof source !== "string")
    throw new TypeError("regex source must be a string");
  const maxRepeat = options.maxRegexRepeat ?? DEFAULT_MAX_REPEAT;
  const maxStates = options.maxRegexStates ?? DEFAULT_MAX_STATES;
  const ast = new Parser(source, maxRepeat).parse();
  const builder = new Builder(maxStates);
  const fragment = builder.compile(ast);
  const match = builder.emit(OP_MATCH);
  builder.patch(fragment.outs, match);
  return new CompiledRegexImpl(source, builder, fragment.start);
}
