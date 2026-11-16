import type { GrammarCapture, GuidanceLimits } from "./core.ts";
import { compileJsonSchema } from "./json-schema.ts";
import { compileRegex, type CompiledRegex, type RegexState } from "./regex.ts";

type SymbolRef =
  { kind: "rule"; name: string } | { kind: "terminal"; id: number };

type Rule = {
  id: number;
  name: string;
  symbols: SymbolRef[];
  capture: boolean;
};
type CaptureSpan = Omit<GrammarCapture, "value">;
type TerminalState = object;
/** A byte-level matcher: a literal or regex NFA, or a `%json` schema matcher. */
interface Terminal {
  readonly initialState: TerminalState;
  advance(state: TerminalState, bytes: Uint8Array): TerminalState;
  viable(state: TerminalState): boolean;
  accepting(state: TerminalState): boolean;
}
type Item = {
  rule: Rule;
  dot: number;
  origin: number;
  captures: CaptureSpan[];
};
type Scanner = {
  terminal: number;
  state: TerminalState;
  item: Item;
  ignored: boolean;
  start: number;
};
type Column = { items: Map<string, Item>; scanners: Scanner[] };
type StateData = { columns: Column[]; bytes: number[] };

const stateData = new WeakMap<
  object,
  { owner: CompiledLark; data: StateData }
>();

export interface LarkState extends RegexState {}

export interface CompiledLark {
  readonly initialState: LarkState;
  advance(state: LarkState, bytes: Uint8Array): LarkState;
  viable(state: LarkState): boolean;
  accepting(state: LarkState): boolean;
  captures(state: LarkState): GrammarCapture[];
}

export function compileLark(
  source: string,
  limits: GuidanceLimits = {},
): CompiledLark {
  if (typeof source !== "string")
    throw new TypeError("Lark grammar must be a string");
  return new LarkCompiler(source, limits);
}

class LarkCompiler implements CompiledLark {
  readonly initialState: LarkState;
  private readonly rules: Rule[];
  private readonly rulesByName = new Map<string, Rule[]>();
  private readonly terminals: Terminal[];
  private readonly ignored: number[];
  private readonly decoder = new TextDecoder();

  constructor(source: string, limits: GuidanceLimits) {
    const parsed = new GrammarParser(source, limits).parse();
    this.rules = parsed.rules;
    this.terminals = parsed.terminals;
    this.ignored = parsed.ignored;
    for (const rule of this.rules) {
      const alternatives = this.rulesByName.get(rule.name) ?? [];
      alternatives.push(rule);
      this.rulesByName.set(rule.name, alternatives);
    }
    const start = this.rulesByName.get("$start")!;
    const first: Column = { items: new Map(), scanners: [] };
    this.advanceWithColumns([first], () =>
      this.close(
        first,
        0,
        [{ rule: start[0], dot: 0, origin: 0, captures: [] }],
        [],
      ),
    );
    this.initialState = this.makeState({ columns: [first], bytes: [] });
  }

  advance(state: LarkState, bytes: Uint8Array): LarkState {
    let data = this.getState(state);
    for (const byte of bytes) data = this.advanceByte(data, byte);
    return this.makeState(data);
  }

  viable(state: LarkState): boolean {
    const data = this.getState(state);
    const current = data.columns.at(-1)!;
    return current.items.size !== 0 || current.scanners.length !== 0;
  }

  accepting(state: LarkState): boolean {
    return this.acceptedItem(this.getState(state)) !== undefined;
  }

  captures(state: LarkState): GrammarCapture[] {
    const data = this.getState(state);
    const item = this.acceptedItem(data);
    if (!item) return [];
    const bytes = Uint8Array.from(data.bytes);
    return item.captures.map((capture) => ({
      ...capture,
      value: this.decoder.decode(bytes.subarray(capture.start, capture.end)),
    }));
  }

  private advanceByte(data: StateData, byte: number): StateData {
    const position = data.bytes.length + 1;
    const previous = data.columns.at(-1)!;
    const seeds: Item[] = [];
    const continuing: Scanner[] = [];
    for (const scanner of previous.scanners) {
      const terminal = this.terminals[scanner.terminal];
      const next = terminal.advance(scanner.state, Uint8Array.of(byte));
      if (!terminal.viable(next)) continue;
      continuing.push({ ...scanner, state: next });
      if (terminal.accepting(next)) {
        if (scanner.ignored) {
          seeds.push(
            scanner.item.dot === 0 && scanner.item.origin === scanner.start
              ? { ...scanner.item, origin: position }
              : scanner.item,
          );
        } else seeds.push({ ...scanner.item, dot: scanner.item.dot + 1 });
      }
    }
    const column: Column = { items: new Map(), scanners: [] };
    this.advanceWithColumns([...data.columns, column], () =>
      this.close(column, position, seeds, continuing),
    );
    return {
      columns: [...data.columns, column],
      bytes: [...data.bytes, byte],
    };
  }

  private close(
    column: Column,
    position: number,
    seeds: Item[],
    scanners: Scanner[],
  ): Column {
    const queue = [...seeds];
    const scannerKeys = new Set<string>();
    const addScanner = (scanner: Scanner) => {
      const key = `${scanner.ignored ? "i" : "t"}:${scanner.terminal}:${scanner.start}:${itemKey(scanner.item)}`;
      if (scannerKeys.has(key)) return;
      scannerKeys.add(key);
      column.scanners.push(scanner);
    };
    for (const scanner of scanners) addScanner(scanner);

    while (queue.length !== 0) {
      const item = queue.shift()!;
      const key = itemKey(item);
      if (column.items.has(key)) continue;
      column.items.set(key, item);
      const symbol = item.rule.symbols[item.dot];
      if (!symbol) {
        const completed: CaptureSpan[] = item.rule.capture
          ? [
              ...item.captures,
              { name: item.rule.name, start: item.origin, end: position },
            ]
          : item.captures;
        const origin = this.currentColumns[item.origin];
        if (!origin) continue;
        for (const parent of origin.items.values()) {
          const expected = parent.rule.symbols[parent.dot];
          if (expected?.kind === "rule" && expected.name === item.rule.name) {
            queue.push({
              ...parent,
              dot: parent.dot + 1,
              captures: [...parent.captures, ...completed],
            });
          }
        }
      } else if (symbol.kind === "rule") {
        const alternatives = this.rulesByName.get(symbol.name);
        if (!alternatives) {
          throw new SyntaxError(
            `unsupported Lark grammar: unknown rule ${JSON.stringify(symbol.name)}`,
          );
        }
        for (const rule of alternatives) {
          queue.push({ rule, dot: 0, origin: position, captures: [] });
        }
      } else {
        addScanner({
          terminal: symbol.id,
          state: this.terminals[symbol.id].initialState,
          item,
          ignored: false,
          start: position,
        });
      }
      for (const terminal of this.ignored) {
        addScanner({
          terminal,
          state: this.terminals[terminal].initialState,
          item,
          ignored: true,
          start: position,
        });
      }
    }
    return column;
  }

  private _currentColumns: Column[] = [];

  private get currentColumns(): Column[] {
    return this._currentColumns;
  }

  private advanceWithColumns<T>(columns: Column[], fn: () => T): T {
    const previous = this._currentColumns;
    this._currentColumns = columns;
    try {
      return fn();
    } finally {
      this._currentColumns = previous;
    }
  }

  private acceptedItem(data: StateData): Item | undefined {
    return data.columns.at(-1)!.items.get(`${this.rules[0].id}:1:0`);
  }

  private makeState(data: StateData): LarkState {
    const state = Object.freeze({}) as LarkState;
    stateData.set(state, { owner: this, data });
    return state;
  }

  private getState(state: LarkState): StateData {
    const stored = stateData.get(state);
    if (stored?.owner !== this) {
      throw new TypeError(
        "state was not created by this compiled Lark grammar",
      );
    }
    return stored.data;
  }
}

function itemKey(item: Item): string {
  return `${item.rule.id}:${item.dot}:${item.origin}`;
}

class GrammarParser {
  private readonly terminals: Terminal[] = [];
  private readonly jsonTerminals = new Map<string, number>();
  private readonly jsonTerminalIds = new Set<number>();
  private readonly definitions = new Map<string, SymbolRef[][]>();
  private readonly ignoredNames: string[] = [];
  private readonly ignoredDirect: number[] = [];
  private synthetic = 0;
  private readonly limits: GuidanceLimits;
  private readonly source: string;

  constructor(source: string, limits: GuidanceLimits) {
    this.source = source;
    this.limits = limits;
  }

  parse(): { rules: Rule[]; terminals: Terminal[]; ignored: number[] } {
    const lines = logicalLines(this.source);
    for (const line of lines) this.parseLine(line);
    if (!this.definitions.has("start")) {
      throw new SyntaxError(
        'unsupported Lark grammar: required rule "start" is missing',
      );
    }

    for (const alternatives of this.definitions.values()) {
      for (const symbols of alternatives) {
        for (const symbol of symbols) {
          if (symbol.kind === "rule" && !this.definitions.has(symbol.name)) {
            throw new SyntaxError(
              `unsupported Lark grammar: unknown rule ${JSON.stringify(symbol.name)}`,
            );
          }
        }
      }
    }

    const ignored = [...this.ignoredDirect];
    for (const name of this.ignoredNames) {
      const alternatives = this.definitions.get(name);
      if (
        alternatives?.length !== 1 ||
        alternatives[0].length !== 1 ||
        alternatives[0][0].kind !== "terminal" ||
        this.jsonTerminalIds.has(alternatives[0][0].id)
      ) {
        throw new SyntaxError(
          `unsupported Lark grammar: %ignore ${name} must name one literal or regex terminal`,
        );
      }
      ignored.push(alternatives[0][0].id);
    }

    let id = 0;
    const rules: Rule[] = [
      {
        id: id++,
        name: "$start",
        symbols: [{ kind: "rule", name: "start" }],
        capture: false,
      },
    ];
    for (const [name, alternatives] of this.definitions) {
      for (const symbols of alternatives) {
        rules.push({ id: id++, name, symbols, capture: !name.startsWith("$") });
      }
    }
    return { rules, terminals: this.terminals, ignored };
  }

  private parseLine(line: string): void {
    if (line.startsWith("%import ")) {
      const imported = line.slice(8).trim();
      if (imported === "common.WS") this.defineImported("WS", String.raw`\s+`);
      else if (imported === "common.WS_INLINE") {
        this.defineImported("WS_INLINE", String.raw`[ \t]+`);
      } else {
        throw new SyntaxError(
          `unsupported Lark construct: %import ${imported}`,
        );
      }
      return;
    }
    if (line.startsWith("%ignore ")) {
      const target = line.slice(8).trim();
      if (/^[A-Za-z_]\w*$/.test(target)) this.ignoredNames.push(target);
      else if (target.startsWith("/")) {
        const parser = new ExpressionParser(target, this);
        const alternatives = parser.parse();
        if (
          alternatives.length !== 1 ||
          alternatives[0].length !== 1 ||
          alternatives[0][0].kind !== "terminal"
        ) {
          throw new SyntaxError(
            "unsupported Lark grammar: %ignore requires one regex or terminal name",
          );
        }
        this.ignoredDirect.push(alternatives[0][0].id);
      } else {
        throw new SyntaxError(
          "unsupported Lark grammar: %ignore requires one regex or terminal name",
        );
      }
      return;
    }
    if (line.startsWith("%")) {
      throw new SyntaxError(
        `unsupported Lark construct: ${line.split(/\s/, 1)[0]}`,
      );
    }
    const match = /^([A-Za-z_]\w*)\s*:\s*(.*)$/s.exec(line);
    if (!match) throw new SyntaxError(`unsupported Lark syntax: ${line}`);
    const [, name, body] = match;
    if (this.definitions.has(name)) {
      throw new SyntaxError(
        `unsupported Lark grammar: duplicate rule ${JSON.stringify(name)}`,
      );
    }
    this.definitions.set(
      name,
      new ExpressionParser(body, this, TERMINAL_NAME.test(name)).parse(),
    );
  }

  json(schema: unknown): SymbolRef {
    const key = JSON.stringify(schema);
    const existing = this.jsonTerminals.get(key);
    if (existing !== undefined) return { kind: "terminal", id: existing };
    let compiled: ReturnType<typeof compileJsonSchema>;
    try {
      compiled = compileJsonSchema(schema, {
        maxSchemaDepth: this.limits.maxSchemaDepth,
        maxJsonDepth: this.limits.maxJsonDepth,
      });
    } catch (error) {
      throw new SyntaxError(
        `unsupported Lark %json: failed to compile JSON schema: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const id =
      this.terminals.push({
        initialState: compiled.initialUtf8,
        advance: (state, bytes) =>
          compiled.appendUtf8(state as typeof compiled.initialUtf8, bytes),
        viable: (state) =>
          compiled.viable(state as typeof compiled.initialUtf8),
        accepting: (state) =>
          compiled.accepting(state as typeof compiled.initialUtf8),
      }) - 1;
    this.jsonTerminals.set(key, id);
    this.jsonTerminalIds.add(id);
    return { kind: "terminal", id };
  }

  terminal(source: string): SymbolRef | null {
    if (source === "") return null;
    let compiled: CompiledRegex;
    try {
      compiled = compileRegex(source, this.limits);
    } catch (error) {
      throw new SyntaxError(
        `unsupported Lark regex terminal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (compiled.accepting(compiled.initialState)) {
      throw new SyntaxError(
        "unsupported Lark grammar: regex terminals must consume at least one byte",
      );
    }
    const id = this.terminals.push(compiled) - 1;
    return { kind: "terminal", id };
  }

  group(alternatives: SymbolRef[][], quantifier?: string): SymbolRef {
    const base = `$group${this.synthetic++}`;
    this.definitions.set(base, alternatives);
    if (!quantifier) return { kind: "rule", name: base };
    const repeated = `$repeat${this.synthetic++}`;
    const ref: SymbolRef = { kind: "rule", name: base };
    const self: SymbolRef = { kind: "rule", name: repeated };
    if (quantifier === "?") this.definitions.set(repeated, [[], [ref]]);
    else if (quantifier === "*")
      this.definitions.set(repeated, [[], [ref, self]]);
    else this.definitions.set(repeated, [[ref], [ref, self]]);
    return { kind: "rule", name: repeated };
  }

  private defineImported(name: string, regex: string): void {
    if (this.definitions.has(name)) {
      throw new SyntaxError(
        `unsupported Lark grammar: duplicate rule ${JSON.stringify(name)}`,
      );
    }
    this.definitions.set(name, [[this.terminal(regex)!]]);
  }
}

class ExpressionParser {
  private index = 0;
  private readonly source: string;
  private readonly grammar: GrammarParser;
  private readonly inTerminal: boolean;

  constructor(source: string, grammar: GrammarParser, inTerminal = false) {
    this.source = source;
    this.grammar = grammar;
    this.inTerminal = inTerminal;
  }

  parse(stop = ""): SymbolRef[][] {
    const alternatives: SymbolRef[][] = [];
    while (true) {
      const sequence: SymbolRef[] = [];
      this.space();
      while (
        this.index < this.source.length &&
        this.peek() !== "|" &&
        this.peek() !== stop
      ) {
        const atom = this.atom();
        if (atom) sequence.push(atom);
        this.space();
      }
      alternatives.push(sequence);
      if (this.peek() !== "|") break;
      this.index++;
    }
    if (stop) {
      if (this.peek() !== stop) this.fail(`missing '${stop}'`);
      this.index++;
    } else if (this.index !== this.source.length) {
      this.fail(`unexpected '${this.peek()}'`);
    }
    return alternatives;
  }

  private atom(): SymbolRef | null {
    this.space();
    let atom: SymbolRef | null;
    const char = this.peek();
    if (char === '"') atom = this.quoted();
    else if (char === "/") atom = this.regex();
    else if (char === "%" && JSON_KEYWORD.test(this.source.slice(this.index)))
      atom = this.json();
    else if (char === "(") {
      this.index++;
      atom = this.grammar.group(this.parse(")"));
    } else {
      const match = /^[A-Za-z_]\w*/.exec(this.source.slice(this.index));
      if (!match) this.fail(`unsupported token '${char ?? "end of line"}'`);
      this.index += match[0].length;
      atom = { kind: "rule", name: match[0] };
    }
    const quantifier = this.peek();
    if (quantifier === "?" || quantifier === "*" || quantifier === "+") {
      this.index++;
      atom = this.grammar.group(atom ? [[atom]] : [[]], quantifier);
    } else if (quantifier === "{" || quantifier === "[" || quantifier === "~") {
      this.fail(`unsupported operator '${quantifier}'`);
    }
    return atom;
  }

  private quoted(): SymbolRef | null {
    const start = this.index++;
    let escaped = false;
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (!escaped && char === '"') {
        let value: string;
        try {
          value = JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          this.fail("invalid string literal", start);
        }
        return this.grammar.terminal(regexEscape(value));
      }
      escaped = !escaped && char === "\\";
      if (char !== "\\") escaped = false;
    }
    this.fail("unterminated string literal", start);
  }

  private json(): SymbolRef {
    const keyword = this.index;
    if (this.inTerminal)
      this.fail("%json literals cannot be used in terminals", keyword);
    this.index += "%json".length;
    this.space();
    const start = this.index;
    const end = jsonValueEnd(this.source, start);
    if (end === -1) this.fail("unterminated %json value", keyword);
    let schema: unknown;
    try {
      schema = JSON.parse(this.source.slice(start, end));
    } catch (error) {
      this.fail(
        `invalid %json value: ${error instanceof Error ? error.message : String(error)}`,
        start,
      );
    }
    this.index = end;
    return this.grammar.json(schema);
  }

  private regex(): SymbolRef {
    const start = ++this.index;
    let escaped = false;
    let inClass = false;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (!escaped) {
        if (char === "[") inClass = true;
        else if (char === "]") inClass = false;
        else if (char === "/" && !inClass) {
          const regex = this.source.slice(start, this.index++);
          if (/^[A-Za-z]/.test(this.peek() ?? ""))
            this.fail("regex flags are unsupported");
          return this.grammar.terminal(unescapeSlashes(regex))!;
        }
      }
      escaped = !escaped && char === "\\";
      if (char !== "\\") escaped = false;
      this.index++;
    }
    this.fail("unterminated regex terminal", start - 1);
  }

  private space(): void {
    while (/\s/.test(this.peek() ?? "")) this.index++;
  }

  private peek(): string | undefined {
    return this.source[this.index];
  }

  private fail(message: string, index = this.index): never {
    throw new SyntaxError(
      `unsupported Lark syntax at column ${index + 1}: ${message}`,
    );
  }
}

function logicalLines(source: string): string[] {
  const result: string[] = [];
  let openJson = false;
  for (const original of source.split(/\r?\n/)) {
    const line = stripComment(original).trim();
    if (!line) continue;
    if (openJson) {
      // A multi-line %json value continues the logical line that opened it.
      result[result.length - 1] += `\n${line}`;
    } else if (line.startsWith("|")) {
      if (result.length === 0 || result.at(-1)!.startsWith("%")) {
        throw new SyntaxError(
          "unsupported Lark syntax: alternative without a rule",
        );
      }
      result[result.length - 1] += ` ${line}`;
    } else result.push(line);
    openJson = hasOpenJson(result.at(-1)!);
  }
  return result;
}

const TERMINAL_NAME = /^_?[A-Z][A-Z0-9_]*$/;
const JSON_KEYWORD = /^%json(?![\w])/;

/** Whether a logical line ends inside a `%json` value. */
function hasOpenJson(line: string): boolean {
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === '"' || char === "/") {
      index = skipDelimited(line, index, char);
    } else if (char === "%" && JSON_KEYWORD.test(line.slice(index))) {
      index += "%json".length;
      while (/\s/.test(line[index] ?? "")) index++;
      if (index === line.length) return true;
      const end = jsonValueEnd(line, index);
      if (end === -1) return true;
      index = end;
    } else index++;
  }
  return false;
}

/** The index after a Lark string literal or regex starting at `start`. */
function skipDelimited(line: string, start: number, delimiter: string): number {
  let inClass = false;
  for (let index = start + 1; index < line.length; index++) {
    const char = line[index];
    if (char === "\\") index++;
    else if (delimiter === "/" && char === "[") inClass = true;
    else if (delimiter === "/" && char === "]") inClass = false;
    else if (char === delimiter && !inClass) return index + 1;
  }
  return line.length;
}

/**
 * The index after the JSON value starting at `start`, or -1 when the source
 * ends first. Only the value's extent is found here; JSON.parse validates it.
 */
function jsonValueEnd(source: string, start: number): number {
  const first = source[start];
  if (first === '"') return jsonStringEnd(source, start);
  if (first !== "{" && first !== "[") {
    const scalar = /^[A-Za-z0-9.+-]+/.exec(source.slice(start));
    return scalar ? start + scalar[0].length : start;
  }
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      index = jsonStringEnd(source, index);
      if (index === -1) return -1;
      index--;
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function jsonStringEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (char === "\\") index++;
    else if (char === '"') return index + 1;
  }
  return -1;
}

/** Lark regexes escape their delimiter as `\/`; the regex engine needs `/`. */
function unescapeSlashes(regex: string): string {
  return regex.replace(/\\(.)/gs, (escape, char: string) =>
    char === "/" ? "/" : escape,
  );
}

function stripComment(line: string): string {
  let quoted = false;
  let regex = false;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (!escaped && char === '"' && !regex) quoted = !quoted;
    else if (!escaped && char === "/" && !quoted) regex = !regex;
    else if (!quoted && !regex && char === "#") return line.slice(0, index);
    escaped = !escaped && char === "\\";
    if (char !== "\\") escaped = false;
  }
  return line;
}

function regexEscape(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
