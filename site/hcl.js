// HCL in the browser: a lexer, parser, evaluator and formatter for the part of
// the language Terraform configurations use. The playground and the X-ray both
// use it. No DOM access, so the tests drive it under Node.
"use strict";

(function (root) {
  class HCLError extends Error {
    constructor(summary, detail, line) {
      super(summary);
      this.summary = summary;
      this.detail = detail;
      this.line = line;
    }
  }

  // --- lexer -------------------------------------------------------------------

  const PUNCT = ["<=", ">=", "==", "!=", "&&", "||", "=>", "...", "{", "}", "[", "]", "(", ")", "=", ",", ".", ":", "?", "!", "+", "-", "*", "/", "%", "<", ">"];

  // A template ("..." or heredoc) becomes parts: literal text and the source of
  // each ${...} interpolation, which the parser parses in turn.
  function templateParts(text, line, quoted) {
    const parts = [];
    let lit = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted && ch === "\\") {
        const n = text[++i];
        const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
        if (n === "u") { lit += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16) || 63); i += 4; } else lit += map[n] ?? n;
      } else if ((ch === "$" || ch === "%") && text[i + 1] === ch && text[i + 2] === "{") {
        lit += ch + "{";
        i += 2;
      } else if (ch === "$" && text[i + 1] === "{") {
        let depth = 1;
        let j = i + 2;
        let inStr = false;
        for (; j < text.length && depth; j++) {
          if (inStr) { if (text[j] === "\\") j++; else if (text[j] === '"') inStr = false; } else if (text[j] === '"') inStr = true;
          else if (text[j] === "{") depth++;
          else if (text[j] === "}") depth--;
        }
        if (depth) throw new HCLError("Invalid template interpolation", "Expected a closing brace to end the interpolation expression, but found end of file.", line);
        if (lit) parts.push(lit);
        lit = "";
        parts.push({ src: text.slice(i + 2, j - 1), line });
        i = j - 1;
      } else lit += ch;
    }
    if (lit || !parts.length) parts.push(lit);
    return parts;
  }

  // notes, when given, collects each comment's line and column for the formatter.
  function lex(src, notes) {
    const toks = [];
    let i = 0;
    let line = 1;
    let lineStart = 0;
    const push = (t, v, extra) => toks.push({ t, v, line, ...extra });
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\n") { push("nl"); line++; i++; lineStart = i; continue; }
      if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
      if (ch === "#" || (ch === "/" && src[i + 1] === "/")) { if (notes) notes.push({ line, col: i - lineStart }); while (i < src.length && src[i] !== "\n") i++; continue; }
      if (ch === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end < 0) throw new HCLError("Unterminated block comment", "There is no closing marker for this comment.", line);
        line += (src.slice(i, end).match(/\n/g) || []).length;
        i = end + 2;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        let depth = 0;
        let text = "";
        while (j < src.length) {
          const c = src[j];
          if (c === "\\") { text += c + (src[j + 1] || ""); j += 2; continue; }
          if (c === "$" && src[j + 1] === "{") { depth++; text += "${"; j += 2; continue; }
          if (depth && c === "}") depth--;
          if (c === "\n" && !depth) break;
          if (c === '"' && !depth) break;
          text += c;
          j++;
        }
        if (src[j] !== '"') throw new HCLError("Unterminated template string", "No closing marker was found for the string.", line);
        push("str", text, { parts: templateParts(text, line, true) });
        line += (text.match(/\n/g) || []).length;
        i = j + 1;
        continue;
      }
      if (ch === "<" && src[i + 1] === "<" && /[-A-Za-z]/.test(src[i + 2] || "")) {
        const m = /^<<(-?)([A-Za-z_][\w]*)\r?\n/.exec(src.slice(i));
        if (m) {
          const startLine = line;
          const bodyStart = i + m[0].length;
          const rest = src.slice(bodyStart).split("\n");
          let k = 0;
          while (k < rest.length && rest[k].trim() !== m[2]) k++;
          if (k === rest.length) throw new HCLError("Unterminated template string", `No closing marker was found for the heredoc "${m[2]}".`, startLine);
          let body = rest.slice(0, k);
          if (m[1]) {
            const pad = Math.min(...body.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
            body = body.map((l) => l.slice(Number.isFinite(pad) ? pad : 0));
          }
          const text = body.map((l) => l + "\n").join("");
          push("str", text, { parts: templateParts(text, startLine, false), heredoc: true });
          line += k + 1;
          i = bodyStart + rest.slice(0, k + 1).join("\n").length;
          continue;
        }
      }
      const num = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 40));
      if (num) { push("num", Number(num[0])); i += num[0].length; continue; }
      const id = /^[A-Za-z_][\w-]*/.exec(src.slice(i, i + 200));
      if (id) { push("id", id[0]); i += id[0].length; continue; }
      const p = PUNCT.find((x) => src.startsWith(x, i));
      if (!p) throw new HCLError("Invalid character", `This character is not used within the language: ${JSON.stringify(ch)}.`, line);
      push("op", p);
      i += p.length;
    }
    push("eof");
    return toks;
  }

  // --- parser ------------------------------------------------------------------

  class Parser {
    constructor(toks) { this.toks = toks; this.i = 0; this.depth = 0; }
    peek() {
      if (this.depth) while (this.toks[this.i].t === "nl") this.i++;
      return this.toks[this.i];
    }
    next() { const t = this.peek(); if (t.t !== "eof") this.i++; return t; }
    is(v) { const t = this.peek(); return t.t === "op" && t.v === v; }
    eat(v) { if (this.is(v)) { this.next(); return true; } return false; }
    expect(v, summary, detail) {
      const t = this.peek();
      if (!this.eat(v)) throw new HCLError(summary || "Invalid expression", detail || `Expected "${v}" here.`, t.line);
    }
    skipNl() { while (this.toks[this.i].t === "nl") this.i++; }

    body(nested) {
      const attrs = {};
      const blocks = [];
      const order = [];
      for (;;) {
        this.skipNl();
        const t = this.toks[this.i];
        if (t.t === "eof") {
          if (nested) throw new HCLError("Unclosed configuration block", "There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.", nested);
          break;
        }
        if (t.t === "op" && t.v === "}") {
          if (nested) { this.i++; break; }
          throw new HCLError("Argument or block definition required", "An argument or block definition is required here.", t.line);
        }
        if (t.t !== "id") throw new HCLError("Argument or block definition required", "An argument or block definition is required here.", t.line);
        this.i++;
        const after = this.toks[this.i];
        if (after.t === "op" && after.v === "=") {
          this.i++;
          if (attrs[t.v]) throw new HCLError("Attribute redefined", `The argument "${t.v}" was already set at line ${attrs[t.v].line}. Each argument may be set only once.`, t.line);
          const expr = this.expr();
          const end = this.toks[this.i];
          if (!(end.t === "nl" || end.t === "eof" || (end.t === "op" && end.v === "}" && nested))) {
            throw new HCLError("Missing newline after argument", "An argument definition must end with a newline.", end.line);
          }
          attrs[t.v] = { name: t.v, expr, line: t.line };
          order.push(attrs[t.v]);
          continue;
        }
        const labels = [];
        while (this.toks[this.i].t === "str" || this.toks[this.i].t === "id") {
          const l = this.toks[this.i++];
          labels.push(l.t === "str" ? l.v : l.v);
        }
        const open = this.toks[this.i];
        if (!(open.t === "op" && open.v === "{")) {
          throw new HCLError(open.t === "op" && open.v === "=" ? "Argument or block definition required" : "Invalid block definition",
            open.t === "op" && open.v === "=" ? "An argument or block definition is required here." : 'Either a quoted string block label or an opening brace ("{") is expected here.', open.line);
        }
        this.i++;
        const inner = this.body(t.line);
        const block = { type: t.v, labels, ...inner, line: t.line };
        blocks.push(block);
        order.push(block);
      }
      return { attrs, blocks, order };
    }

    // Operators must sit on the same line as their left operand.
    rawIs(v) { const t = this.toks[this.i]; return t.t === "op" && t.v === v; }

    expr() {
      const c = this.binary(0);
      if (this.rawIs("?")) {
        this.i++;
        const a = this.expr();
        this.expect(":", "Missing false expression in conditional", "The conditional operator (...?...:...) requires a false expression, delimited by a colon.");
        return { k: "cond", c, a, b: this.expr() };
      }
      return c;
    }

    binary(level) {
      const LEVELS = [["||"], ["&&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "%"]];
      if (level === LEVELS.length) return this.unary();
      let a = this.binary(level + 1);
      for (;;) {
        const t = this.toks[this.i];
        if (t.t !== "op" || !LEVELS[level].includes(t.v)) return a;
        this.next();
        a = { k: "op", op: t.v, a, b: this.binary(level + 1) };
      }
    }

    unary() {
      if (this.eat("!")) return { k: "not", a: this.unary() };
      if (this.eat("-")) return { k: "neg", a: this.unary() };
      return this.postfix(this.primary());
    }

    postfix(base) {
      const steps = [];
      for (;;) {
        if (this.toks[this.i].t === "op" && this.toks[this.i].v === ".") {
          this.i++;
          const t = this.toks[this.i];
          if (t.t === "id") { this.i++; steps.push({ a: t.v }); } else if (t.t === "num") { this.i++; steps.push({ i: { k: "lit", v: t.v } }); } else if (t.t === "op" && t.v === "*") { this.i++; steps.push({ splat: true }); } else throw new HCLError("Invalid attribute name", "An attribute name is required after a dot.", t.line);
        } else if (this.toks[this.i].t === "op" && this.toks[this.i].v === "[") {
          this.i++;
          this.depth++;
          if (this.eat("*")) { steps.push({ splat: true }); } else steps.push({ i: this.expr() });
          this.expect("]", "Missing close bracket on index", "The index operator must end with a closing bracket (\"]\").");
          this.depth--;
        } else break;
      }
      return steps.length ? { k: "get", base, steps, line: base.line } : base;
    }

    primary() {
      const t = this.next();
      if (t.t === "num") return { k: "lit", v: t.v };
      if (t.t === "str") return this.template(t);
      if (t.t === "id") {
        if (t.v === "true" || t.v === "false") return { k: "lit", v: t.v === "true" };
        if (t.v === "null") return { k: "lit", v: null };
        if (this.toks[this.i].t === "op" && this.toks[this.i].v === "(") {
          this.i++;
          this.depth++;
          const args = [];
          let expand = false;
          while (!this.is(")")) {
            args.push(this.expr());
            if (this.eat("...")) expand = true;
            if (!this.eat(",")) break;
          }
          this.expect(")", "Missing argument separator", 'A comma is required to separate each function argument from the next.');
          this.depth--;
          return { k: "call", name: t.v, args, expand, line: t.line };
        }
        return { k: "var", name: t.v, line: t.line };
      }
      if (t.t === "op" && t.v === "(") {
        this.depth++;
        const e = this.expr();
        this.expect(")");
        this.depth--;
        return { k: "paren", e };
      }
      if (t.t === "op" && t.v === "[") {
        this.depth++;
        if (this.peek().t === "id" && this.peek().v === "for") return this.forExpr(true, t.line);
        const items = [];
        while (!this.is("]")) {
          items.push(this.expr());
          if (!this.eat(",")) break;
        }
        this.expect("]", "Missing item separator", "Expected a comma to mark the beginning of the next item.");
        this.depth--;
        return { k: "list", items };
      }
      if (t.t === "op" && t.v === "{") {
        this.depth++;
        if (this.peek().t === "id" && this.peek().v === "for") return this.forExpr(false, t.line);
        const items = [];
        while (!this.is("}")) {
          const kt = this.peek();
          let key;
          if (kt.t === "id" && this.toks[this.i + 1] && this.toks[this.i + 1].t === "op" && /^(=|:)$/.test(this.toks[this.i + 1].v)) { this.next(); key = { k: "lit", v: kt.v }; } else key = this.expr();
          if (!this.eat("=") && !this.eat(":")) throw new HCLError("Missing key/value separator", "Expected an equals sign (\"=\") to mark the beginning of the attribute value.", this.peek().line);
          items.push({ key, val: this.expr() });
          // Items are separated by commas or newlines.
          if (this.toks[this.i].t !== "nl" && !this.eat(",") && !this.is("}")) throw new HCLError("Missing attribute separator", "Expected a newline or comma to mark the beginning of the next attribute.", this.peek().line);
        }
        this.expect("}");
        this.depth--;
        return { k: "obj", items };
      }
      throw new HCLError("Invalid expression", "Expected the start of an expression, but found an invalid expression token.", t.line);
    }

    forExpr(list, line) {
      this.next();
      const names = [this.next().v];
      if (this.eat(",")) names.push(this.next().v);
      const inTok = this.next();
      if (inTok.v !== "in") throw new HCLError("Invalid 'for' expression", 'The "in" keyword is required after the iterator variable names.', inTok.line);
      const src = this.expr();
      this.expect(":", "Invalid 'for' expression", "A colon is required after the collection expression.");
      const keyE = list ? null : this.expr();
      if (!list) this.expect("=>", "Invalid 'for' expression", 'An object "for" expression requires "=>" between key and value.');
      const valE = this.expr();
      const group = !list && this.eat("...");
      let cond = null;
      if (this.peek().t === "id" && this.peek().v === "if") { this.next(); cond = this.expr(); }
      this.expect(list ? "]" : "}");
      this.depth--;
      return { k: "for", list, names, src, keyE, valE, cond, group, line };
    }

    template(t) {
      const parts = t.parts.map((p) => (typeof p === "string" ? p : parseExpr(p.src, p.line)));
      return parts.length === 1 && typeof parts[0] === "string" ? { k: "lit", v: parts[0], quoted: true } : { k: "tpl", parts, line: t.line };
    }
  }

  function parseExpr(src, line) {
    const toks = lex(src).map((t) => ({ ...t, line: line + t.line - 1 }));
    const p = new Parser(toks);
    p.depth = 1;
    const e = p.expr();
    if (p.peek().t !== "eof") throw new HCLError("Extra characters after interpolation expression", "Expected a closing brace to end the interpolation expression, but found extra characters.", line);
    return e;
  }

  // Parse a file into its top-level body. Errors carry the line they are on.
  function parse(src) {
    return new Parser(lex(String(src))).body(0);
  }

  // --- values ------------------------------------------------------------------

  // A value Terraform cannot know until apply, and a value marked sensitive.
  const UNKNOWN = Object.freeze({ unknown: true });
  class Sens { constructor(v) { this.v = v; } }
  const isUnknown = (v) => v === UNKNOWN;
  const unmark = (v) => (v instanceof Sens ? v.v : v);
  function deepSens(v) {
    if (v instanceof Sens) return true;
    if (Array.isArray(v)) return v.some(deepSens);
    if (v && typeof v === "object" && v !== UNKNOWN) return Object.values(v).some(deepSens);
    return false;
  }
  function deepUnknown(v) {
    if (v === UNKNOWN) return true;
    if (v instanceof Sens) return deepUnknown(v.v);
    if (Array.isArray(v)) return v.some(deepUnknown);
    if (v && typeof v === "object") return Object.values(v).some(deepUnknown);
    return false;
  }
  function strip(v) {
    if (v instanceof Sens) return strip(v.v);
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object" && v !== UNKNOWN) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]));
    return v;
  }
  const typeName = (v) => {
    v = unmark(v);
    if (v === null) return "null";
    if (Array.isArray(v)) return "tuple";
    if (typeof v === "object") return "object";
    return typeof v === "boolean" ? "bool" : typeof v;
  };

  class EvalError extends Error {
    constructor(summary, detail, line) { super(summary); this.summary = summary; this.detail = detail; this.line = line; }
  }

  function toStr(v, line) {
    v = unmark(v);
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return String(v);
    if (v === null) throw new EvalError("Invalid template interpolation value", "The expression result is null. Cannot include a null value in a string template.", line);
    throw new EvalError("Invalid template interpolation value", `Cannot include the given value in a string template: string required, but have ${typeName(v)}.`, line);
  }

  function ipToNum(ip) { return ip.split(".").reduce((n, o) => n * 256 + Number(o), 0); }
  function numToIp(n) { return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join("."); }

  const FUNCS = {
    abs: (x) => Math.abs(x), ceil: Math.ceil, floor: Math.floor, max: (...a) => Math.max(...a), min: (...a) => Math.min(...a),
    coalesce: (...a) => a.find((x) => x !== null && x !== ""), concat: (...a) => a.flat(1), contains: (l, x) => l.includes(x),
    distinct: (l) => [...new Set(l)], element: (l, i) => l[i % l.length], flatten: (l) => l.flat(Infinity), keys: (m) => Object.keys(m).sort(),
    values: (m) => Object.keys(m).sort().map((k) => m[k]), length: (x) => (typeof x === "string" ? x.length : Array.isArray(x) ? x.length : Object.keys(x).length),
    lookup: (m, k, d) => (k in m ? m[k] : d), lower: (s) => s.toLowerCase(), upper: (s) => s.toUpperCase(), merge: (...a) => Object.assign({}, ...a),
    join: (sep, l) => l.join(sep), split: (sep, s) => s.split(sep), replace: (s, a, b) => s.split(a).join(b), trimspace: (s) => s.trim(),
    startswith: (s, p) => s.startsWith(p), endswith: (s, p) => s.endsWith(p), substr: (s, o, n) => s.substr(o, n < 0 ? undefined : n),
    tolist: (l) => [...l], toset: (l) => [...new Set(l.map((x) => (typeof x === "number" ? String(x) : x)))].sort(), tomap: (m) => ({ ...m }),
    tostring: (x) => (x === null ? null : String(x)), tonumber: (x) => { const n = Number(x); if (Number.isNaN(n)) throw new Error(`Cannot convert "${x}" to number.`); return n; },
    tobool: (x) => x === true || x === "true", range: (a, b) => (b === undefined ? [...Array(a).keys()] : Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i)),
    sort: (l) => [...l].sort(), compact: (l) => l.filter((x) => x !== "" && x !== null), one: (l) => (l.length ? l[0] : null), sum: (l) => l.reduce((a, b) => a + b, 0),
    zipmap: (k, v) => Object.fromEntries(k.map((x, i) => [x, v[i]])), jsonencode: (v) => JSON.stringify(v), jsondecode: (s) => JSON.parse(s),
    base64encode: (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s).toString("base64")),
    format: (f, ...a) => { let i = 0; return f.replace(/%[sdv%]/g, (m) => (m === "%%" ? "%" : String(a[i++]))); },
    cidrsubnet: (prefix, bits, num) => {
      const [ip, len] = prefix.split("/");
      const nlen = Number(len) + bits;
      if (nlen > 32) throw new Error(`insufficient address space to extend prefix of ${len} by ${bits}`);
      return `${numToIp(ipToNum(ip) + num * 2 ** (32 - nlen))}/${nlen}`;
    },
    title: (s) => s.replace(/\b\w/g, (c) => c.toUpperCase()), timestamp: () => "2026-10-30T09:00:00Z", uuid: () => "8a1d6c52-4f0e-4b7a-9d2c-1e3f5a7b9c0d"
  };

  // ctx: { scope(name, line) -> value, funcs?: extra functions, locals }
  function evaluate(node, ctx) {
    switch (node.k) {
      case "lit": return node.v;
      case "paren": return evaluate(node.e, ctx);
      case "tpl": {
        let out = "";
        let sens = false;
        for (const p of node.parts) {
          if (typeof p === "string") { out += p; continue; }
          const v = evaluate(p, ctx);
          if (v instanceof Sens) sens = true;
          if (isUnknown(unmark(v))) return UNKNOWN;
          out += toStr(v, node.line);
        }
        return sens ? new Sens(out) : out;
      }
      case "list": return node.items.map((x) => evaluate(x, ctx));
      case "obj": {
        const o = {};
        for (const it of node.items) {
          const key = it.key.k === "var" ? it.key.name : evaluate(it.key, ctx);
          o[toStr(key)] = evaluate(it.val, ctx);
        }
        return o;
      }
      case "var": return ctx.scope(node.name, node.line, node);
      case "get": {
        let v = evaluate(node.base, ctx);
        let sens = false;
        for (let s = 0; s < node.steps.length; s++) {
          const step = node.steps[s];
          if (v instanceof Sens) { sens = true; v = v.v; }
          if (isUnknown(v)) return UNKNOWN;
          if (step.splat) {
            const rest = { k: "get", base: { k: "lit", v: null }, steps: node.steps.slice(s + 1), line: node.line };
            const list = v === null ? [] : Array.isArray(v) ? v : [v];
            const out = list.map((item) => (rest.steps.length ? evaluate({ ...rest, base: { k: "lit", v: item } }, ctx) : item));
            return sens ? new Sens(out) : out;
          }
          if (v === null) throw new EvalError("Attempt to get attribute from null value", "This value is null, so it does not have any attributes.", node.line);
          if ("a" in step) {
            if (typeof v !== "object" || Array.isArray(v)) throw new EvalError("Unsupported attribute", `Can't access attributes on a ${Array.isArray(v) ? "list of objects" : "primitive-typed value (" + typeName(v) + ")"}. Did you mean to access an attribute for a specific element of the list, or across all elements of the list?`, node.line);
            if (!(step.a in v)) throw new EvalError("Unsupported attribute", `This object does not have an attribute named "${step.a}".`, node.line);
            v = v[step.a];
          } else {
            let k = evaluate(step.i, ctx);
            if (k instanceof Sens) { sens = true; k = k.v; }
            if (isUnknown(k)) return UNKNOWN;
            if (Array.isArray(v)) {
              if (typeof k !== "number" || !(k in v)) throw new EvalError("Invalid index", `The given key does not identify an element in this collection value: the collection has ${v.length} element${v.length === 1 ? "" : "s"}.`, node.line);
              v = v[k];
            } else {
              if (typeof v !== "object" || !(String(k) in v)) throw new EvalError("Invalid index", "The given key does not identify an element in this collection value.", node.line);
              v = v[String(k)];
            }
          }
        }
        return sens && !(v instanceof Sens) ? new Sens(v) : v;
      }
      case "call": {
        const fn = (ctx.funcs && ctx.funcs[node.name]) || FUNCS[node.name];
        if (node.name === "try" || node.name === "can") {
          for (const a of node.args) {
            try { const v = evaluate(a, ctx); if (node.name === "can") return true; return v; } catch (e) { if (!(e instanceof EvalError)) throw e; }
          }
          if (node.name === "can") return false;
          throw new EvalError("Error in function call", 'Call to function "try" failed: no expression succeeded.', node.line);
        }
        if (!fn) throw new EvalError("Call to unknown function", `There is no function named "${node.name}".`, node.line);
        let args = node.args.map((a) => evaluate(a, ctx));
        if (node.expand && args.length) args = [...args.slice(0, -1), ...unmark(args[args.length - 1])];
        if (node.name === "sensitive") return new Sens(unmark(args[0]));
        if (node.name === "nonsensitive") return strip(args[0]);
        if (args.some(deepUnknown)) return UNKNOWN;
        const sens = args.some(deepSens);
        let out;
        try { out = fn(...args.map(strip)); } catch (e) {
          if (e instanceof EvalError) throw e;
          throw new EvalError("Error in function call", `Call to function "${node.name}" failed: ${e.message}`, node.line);
        }
        if (node.name === "toset" && Array.isArray(out)) Object.defineProperty(out, "tqSet", { value: true });
        return sens ? new Sens(out) : out;
      }
      case "not": { const v = evaluate(node.a, ctx); return isUnknown(unmark(v)) ? UNKNOWN : !unmark(v); }
      case "neg": { const v = evaluate(node.a, ctx); return isUnknown(unmark(v)) ? UNKNOWN : -unmark(v); }
      case "op": {
        const a = evaluate(node.a, ctx);
        if (node.op === "&&" && unmark(a) === false) return false;
        if (node.op === "||" && unmark(a) === true) return true;
        const b = evaluate(node.b, ctx);
        const x = unmark(a);
        const y = unmark(b);
        if (isUnknown(x) || isUnknown(y)) return UNKNOWN;
        const sens = a instanceof Sens || b instanceof Sens;
        const num = (v) => {
          const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
          if (typeof n !== "number" || Number.isNaN(n)) throw new EvalError("Invalid operand", `Unsuitable value for ${node.op === "+" ? "left" : "right"} operand: a number is required.`, node.line);
          return n;
        };
        const ops = {
          "+": () => num(x) + num(y), "-": () => num(x) - num(y), "*": () => num(x) * num(y), "/": () => num(x) / num(y), "%": () => num(x) % num(y),
          "==": () => JSON.stringify(x) === JSON.stringify(y), "!=": () => JSON.stringify(x) !== JSON.stringify(y),
          "<": () => num(x) < num(y), ">": () => num(x) > num(y), "<=": () => num(x) <= num(y), ">=": () => num(x) >= num(y),
          "&&": () => Boolean(x && y), "||": () => Boolean(x || y)
        };
        const out = ops[node.op]();
        return sens ? new Sens(out) : out;
      }
      case "cond": {
        const c = unmark(evaluate(node.c, ctx));
        if (isUnknown(c)) return UNKNOWN;
        if (typeof c !== "boolean") throw new EvalError("Incorrect condition type", "The condition expression must be of type bool.", node.line);
        return evaluate(c ? node.a : node.b, ctx);
      }
      case "for": {
        const src = unmark(evaluate(node.src, ctx));
        if (isUnknown(src)) return UNKNOWN;
        const entries = Array.isArray(src) ? src.map((v, i) => [i, v]) : Object.entries(src || {});
        const out = node.list ? [] : {};
        for (const [k, v] of entries) {
          const vars = node.names.length === 2 ? { [node.names[0]]: k, [node.names[1]]: v } : { [node.names[0]]: v };
          const inner = { ...ctx, scope: (name, line, n) => (name in vars ? vars[name] : ctx.scope(name, line, n)) };
          if (node.cond && !unmark(evaluate(node.cond, inner))) continue;
          if (node.list) out.push(evaluate(node.valE, inner));
          else {
            const key = toStr(evaluate(node.keyE, inner), node.line);
            const val = evaluate(node.valE, inner);
            if (node.group) (out[key] = out[key] || []).push(val);
            else if (key in out) throw new EvalError("Duplicate object key", `Two different items produced the key "${key}" in this 'for' expression.`, node.line);
            else out[key] = val;
          }
        }
        return out;
      }
      default: throw new EvalError("Invalid expression", "This expression is not supported here.", node.line);
    }
  }

  // Every reference an expression makes: [{root, steps, line}] where steps are
  // the static attribute names that follow (var.x, aws_s3_bucket.logs.arn).
  function refs(node, out = [], bound = new Set()) {
    if (!node || typeof node !== "object") return out;
    if (node.k === "var") { if (!bound.has(node.name)) out.push({ root: node.name, steps: [], line: node.line }); return out; }
    if (node.k === "get") {
      if (node.base.k === "var" && !bound.has(node.base.name)) {
        const steps = [];
        for (const s of node.steps) {
          if ("a" in s) steps.push(s.a);
          else if (s.i && s.i.k === "lit") steps.push(s.i.v);
          else break;
        }
        out.push({ root: node.base.name, steps, line: node.line });
      } else refs(node.base, out, bound);
      for (const s of node.steps) if (s.i) refs(s.i, out, bound);
      return out;
    }
    if (node.k === "for") {
      refs(node.src, out, bound);
      const inner = new Set([...bound, ...node.names]);
      for (const e of [node.keyE, node.valE, node.cond]) refs(e, out, inner);
      return out;
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach((x) => (x && x.key ? (refs(x.key, out, bound), refs(x.val, out, bound)) : refs(x, out, bound)));
      else if (v && typeof v === "object" && v.k) refs(v, out, bound);
    }
    return out;
  }

  // Render a value as HCL, the way plan output and the console show it.
  function show(v, indent = "") {
    if (v instanceof Sens) return "(sensitive value)";
    if (v === UNKNOWN) return "(known after apply)";
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return v.includes("\n") ? `<<-EOT\n${v.replace(/\n$/, "").split("\n").map((l) => indent + "    " + l).join("\n")}\n${indent}  EOT` : JSON.stringify(v);
    if (typeof v !== "object") return String(v);
    const inner = indent + "  ";
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      if (v.every((x) => typeof x !== "object" || x === null)) {
        const flat = `[${v.map((x) => show(x)).join(", ")}]`;
        if (flat.length < 60) return flat;
      }
      return `[\n${v.map((x) => inner + show(x, inner) + ",").join("\n")}\n${indent}]`;
    }
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    const quote = (k) => (/^[A-Za-z_][\w-]*$/.test(k) ? k : JSON.stringify(k));
    const w = Math.max(...keys.map((k) => quote(k).length));
    return `{\n${keys.map((k) => `${inner}${quote(k).padEnd(w)} = ${show(v[k], inner)}`).join("\n")}\n${indent}}`;
  }

  // --- formatter (terraform fmt) ---------------------------------------------------

  // The same passes as Terraform's own formatter (hclwrite): indent by the net
  // brackets each line opens, one space around "=", then align the "=" of
  // consecutive one-line arguments and the trailing comments of consecutive lines.
  // Blank lines, comment lines and multi-line values break an alignment run.
  function format(src) {
    const text = String(src).replace(/\r\n/g, "\n");
    const notes = [];
    const toks = lex(text, notes);
    const byLine = {};
    const frozen = new Set();
    for (const t of toks) {
      if (t.t === "nl" || t.t === "eof") continue;
      (byLine[t.line] = byLine[t.line] || []).push(t);
      if (t.t === "str" && t.heredoc) for (let k = t.line + 1; k <= t.line + t.v.split("\n").length; k++) frozen.add(k);
    }
    const comment = Object.fromEntries(notes.map((c) => [c.line, c.col]));
    const change = (t) => (t.t !== "op" ? 0 : "{[(".includes(t.v) ? 1 : "}])".includes(t.v) ? -1 : 0);
    const stack = [];
    const rows = text.split("\n").map((raw, idx) => {
      const n = idx + 1;
      if (frozen.has(n)) return { raw };
      const lt = byLine[n] || [];
      let code = raw;
      let note = "";
      if (n in comment) {
        code = raw.slice(0, comment[n]);
        note = raw.slice(comment[n]).trimEnd();
      }
      code = code.trim();
      if (!code && !note) return { text: "" };
      const net = lt.reduce((sum, t) => sum + change(t), 0);
      let indent = stack.length;
      if (net > 0) stack.push(net);
      else if (net < 0) {
        let closed = -net;
        while (closed > 0 && stack.length) {
          const top = stack[stack.length - 1];
          if (closed >= top) { closed -= top; stack.pop(); } else { stack[stack.length - 1] -= closed; closed = 0; }
        }
        indent = stack.length;
      }
      const pad = "  ".repeat(indent);
      if (!code) return { text: pad + note };
      const isAssign = lt.length > 1 && (lt[0].t === "id" || lt[0].t === "str") && lt[1].t === "op" && lt[1].v === "=";
      let name = null;
      if (isAssign) {
        const at = code.indexOf("=", lt[0].t === "str" ? code.indexOf('"', 1) + 1 : 0);
        name = code.slice(0, at).trim();
        code = `${name} = ${code.slice(at + 1).trim()}`;
      } else code = code.replace(/^([A-Za-z_][\w-]*)((?:\s+"[^"]*"|\s+[A-Za-z_][\w-]*)*)\s*\{$/, (all, kw, labels) => [kw, ...labels.trim().split(/\s+/).filter(Boolean)].join(" ") + " {");
      return { pad, code, note, name: isAssign && net === 0 ? name : null };
    });
    // Align "=" across runs of one-line arguments, then trailing comments.
    const run = (key, width, apply) => {
      for (let i = 0; i < rows.length;) {
        if (!key(rows[i])) { i++; continue; }
        let j = i;
        while (j < rows.length && key(rows[j])) j++;
        const w = Math.max(...rows.slice(i, j).map(width));
        for (let k = i; k < j; k++) apply(rows[k], w);
        i = j;
      }
    };
    run((r) => r.name != null, (r) => r.pad.length + r.name.length, (r, w) => {
      r.code = r.name.padEnd(w - r.pad.length) + r.code.slice(r.name.length);
    });
    run((r) => r.code && r.note, (r) => r.pad.length + r.code.length, (r, w) => { r.code = r.code.padEnd(w - r.pad.length); });
    return rows.map((r) => (r.raw !== undefined ? r.raw : r.text !== undefined ? r.text : r.pad + r.code + (r.note ? " " + r.note : ""))).join("\n");
  }

  root.TQHCL = { parse, parseExpr, lex, evaluate, refs, format, show, HCLError, EvalError, UNKNOWN, Sens, unmark, strip, deepSens, deepUnknown, isUnknown, typeName, FUNCS };
})(typeof window !== "undefined" ? window : globalThis);
