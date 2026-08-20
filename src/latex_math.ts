/**
 * Small TeX-to-MathML converter for Live formula insets.
 * Covers the LyX subset: greek, scripts, sums, delimiters, fractions, primes.
 * Unknown commands fall back to mtext so source never becomes executable HTML.
 */
const MATH_COLOR: Record<string, string> = {
  red: "red",
  green: "green",
  blue: "blue",
  cyan: "cyan",
  magenta: "magenta",
  yellow: "yellow",
  black: "black",
  white: "white",
  brown: "brown",
  gray: "gray",
  grey: "gray",
  darkgray: "#404040",
  lightgray: "#c0c0c0",
  lime: "lime",
  olive: "olive",
  orange: "orange",
  pink: "pink",
  purple: "purple",
  teal: "teal",
  violet: "violet",
  darkred: "#8b0000",
  darkgreen: "#008000",
  darkblue: "#00008b",
};

function mathColor(name: string): string {
  return MATH_COLOR[name.toLowerCase()] ?? name;
}

function escapeLiveHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const SYM_MI: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", varkappa: "ϰ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ",
  sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ", varphi: "ϕ", chi: "χ",
  psi: "ψ", omega: "ω",
  Gamma: "Γ", varGamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", Upsilon: "Υ",
  ell: "ℓ", aleph: "ℵ", hbar: "ℏ", hslash: "ℏ", imath: "ı", jmath: "ȷ",
  wp: "℘", Re: "ℜ", Im: "ℑ", nabla: "∇", partial: "∂", infty: "∞",
  emptyset: "∅", varnothing: "∅", mho: "℧", Bbbk: "k",
  ellipsis: "…",
};

const SYM_MO: Record<string, string> = {
  cdot: "⋅", ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", iddots: "⋰",
  times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘", bullet: "•",
  cap: "∩", cup: "∪", sqcap: "⊓", sqcup: "⊔", uplus: "⊎", vee: "∨", wedge: "∧",
  oplus: "⊕", ominus: "⊖", otimes: "⊗", oslash: "⊘", odot: "⊙",
  to: "→", gets: "←", rightarrow: "→", leftarrow: "←",
  downarrow: "↓", uparrow: "↑", leftrightarrow: "↔",
  Rightarrow: "⇒", Leftarrow: "⇐", Downarrow: "⇓", Uparrow: "⇑", Leftrightarrow: "⇔",
  longrightarrow: "⟶", longleftarrow: "⟵", longleftrightarrow: "⟷",
  Longrightarrow: "⟹", Longleftarrow: "⟸", Longleftrightarrow: "⟺",
  mapsto: "↦", longmapsto: "⟼", leadsto: "⇝", dasharrow: "⇢",
  hookleftarrow: "↩", hookrightarrow: "↪",
  leftharpoonup: "↼", leftharpoondown: "↽", rightharpoonup: "⇀", rightharpoondown: "⇁",
  rightleftharpoons: "⇌",
  nearrow: "↗", searrow: "↘", swarrow: "↙", nwarrow: "↖",
  updownarrow: "↕", Updownarrow: "⇕",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", geqq: "≧", leqq: "≦", ne: "≠", neq: "≠",
  ll: "≪", gg: "≫", approx: "≈", sim: "∼", simeq: "≃", cong: "≅", equiv: "≡",
  propto: "∝", asymp: "≍", doteq: "≐",
  in: "∈", ni: "∋", notin: "∉", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇",
  sqsubseteq: "⊑", sqsupseteq: "⊒",
  prec: "≺", succ: "≻", preceq: "≼", succeq: "≽",
  parallel: "∥", nparallel: "∦", mid: "∣", nmid: "∤", perp: "⊥",
  models: "⊨", vdash: "⊢", dashv: "⊣",
  exists: "∃", nexists: "∄", forall: "∀", neg: "¬", lnot: "¬",
  land: "∧", lor: "∨",
  langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
  backslash: "\\", vert: "|", Vert: "∥",
  inf: "inf",
  angle: "∠", measuredangle: "∡", sphericalangle: "∢", triangle: "△",
  triangleleft: "◃", triangleright: "▹", bigtriangleup: "△", bigtriangledown: "▽",
  diamond: "⋄", Diamond: "◇", lozenge: "◊", Lozenge: "◊",
  clubsuit: "♣", diamondsuit: "♦", heartsuit: "♥", spadesuit: "♠",
  sharp: "♯", flat: "♭", natural: "♮",
  dagger: "†", ddagger: "‡", dag: "†", ddag: "‡",
  prime: "′", backprime: "‵",
  bot: "⊥", top: "⊤", surd: "√",
  coprod: "∐",
  amalg: "⨿", wr: "≀",
  lessgtr: "≶", gtrless: "≷",
  smile: "⌣", frown: "⌢", bowtie: "⋈",
  checkmark: "✓", maltese: "✠",
  euro: "€", yen: "¥", pounds: "£", copyright: "©", P: "¶",
  complement: "∁", therefore: "∴", because: "∵",
  Box: "□", bigcirc: "○", setminus: "∖", bigstar: "★",
  blacklozenge: "◆", blacktriangle: "▲", blacktriangledown: "▼",
  circledR: "®", diagup: "╱", diagdown: "╲",
  lhd: "◃", rhd: "▹", unlhd: "⊴", unrhd: "⊵",
  circeq: "≗", circlearrowright: "↻", circlearrowleft: "↺",
  mathcircumflex: "^",
};

const MATRIX_ENV: Record<string, { open: string; close: string }> = {
  matrix: { open: "", close: "" },
  smallmatrix: { open: "", close: "" },
  pmatrix: { open: "(", close: ")" },
  bmatrix: { open: "[", close: "]" },
  Bmatrix: { open: "{", close: "}" },
  vmatrix: { open: "|", close: "|" },
  Vmatrix: { open: "∥", close: "∥" },
  cases: { open: "{", close: "" },
  array: { open: "", close: "" },
  aligned: { open: "", close: "" },
  alignedat: { open: "", close: "" },
  gathered: { open: "", close: "" },
  split: { open: "", close: "" },
  subarray: { open: "", close: "" },
};

const LARGEOP = new Set([
  "sum", "prod", "int", "oint", "iint", "iiint", "iiiint",
  "bigcap", "bigcup", "bigvee", "bigwedge", "bigodot", "bigoplus", "bigotimes",
  "bigsqcup", "biguplus", "coprod",
  "oiint", "sqint", "sqiint", "fint", "dotsint",
  "ointclockwise", "ointctrclockwise", "landupint", "landdownint",
]);
const LARGEOP_CHAR: Record<string, string> = {
  sum: "∑", prod: "∏", int: "∫", oint: "∮", iint: "∬", iiint: "∭", iiiint: "⨌",
  bigcap: "⋂", bigcup: "⋃", bigvee: "⋁", bigwedge: "⋀",
  bigodot: "⨀", bigoplus: "⨁", bigotimes: "⨂", bigsqcup: "⨆", biguplus: "⨄",
  coprod: "∐",
  oiint: "∯", sqint: "∰", sqiint: "∰", fint: "⨏", dotsint: "∫⋯",
  ointclockwise: "∲", ointctrclockwise: "∳", landupint: "∫", landdownint: "∫",
};

const OPNAME = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
  "sinh", "cosh", "tanh", "ln", "log", "lg", "exp", "lim", "limsup", "liminf",
  "max", "min", "sup", "inf", "det", "dim", "ker", "hom", "arg", "deg", "gcd",
  "Pr", "mod", "bmod", "sgn",
]);

const ACCENT_OVER: Record<string, string> = {
  hat: "^", widehat: "^", tilde: "˜", widetilde: "˜", bar: "¯", vec: "→",
  dot: "˙", ddot: "¨", dddot: "⃛", ddddot: "⃜",
  acute: "´", grave: "`", breve: "˘", check: "ˇ", mathring: "˚",
  overline: "¯", overrightarrow: "→", overleftarrow: "←", overleftrightarrow: "↔",
};

const ACCENT_UNDER: Record<string, string> = {
  underline: "_", underrightarrow: "→", underleftarrow: "←", underleftrightarrow: "↔",
  utilde: "˜",
};

const SKIP_NEXT = new Set([
  "limits", "nolimits", "nonumber", "notag", "mathop",
]);

const SKIP_GROUP = new Set([
  "tag", "label", "hspace", "vspace", "rule",
  "leftroot", "uproot", "smashoperator", "adjustlimits",
]);

const ENV = /\\begin\{(equation\*?|align\*?|alignat\*?|flalign\*?|displaymath|multline\*?|gather\*?|eqnarray\*?)\}(?:\{[^}]*\})?([\s\S]*)\\end\{\1\}/;

export function unwrapLatexSource(source: string): { display: boolean; body: string } {
  let s = source.trim();
  let display = false;
  const env = ENV.exec(s);
  if (env && env.index === 0 && env[0].length === s.length) {
    display = true;
    s = env[2].trim();
  } else if (s.startsWith("$$") && s.endsWith("$$")) {
    display = true;
    s = s.slice(2, -2).trim();
  } else if (s.startsWith("\\[") && s.endsWith("\\]")) {
    display = true;
    s = s.slice(2, -2).trim();
  } else if (s.startsWith("$") && s.endsWith("$") && s.length >= 2) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\\label\{[^}]*\}/g, "").trim();
  return { display, body: s };
}

function extractTag(body: string): { star: boolean; text: string } | undefined {
  const m = /\\tag(\*)?\{([^{}]*)\}/.exec(body);
  if (!m) return undefined;
  return { star: m[1] === "*", text: m[2] };
}

export function renderFormulaHtml(source: string, equationNo?: number | string): string {
  const { display, body } = unwrapLatexSource(source);
  const inner = latexToMathML(body);
  const displayAttr = display ? ' display="block"' : "";
  const math =
    `<math xmlns="http://www.w3.org/1998/Math/MathML"${displayAttr}><semantics>${inner}<annotation encoding="application/x-tex">${escapeLiveHtml(body)}</annotation></semantics></math>`;
  const tagged = extractTag(body);
  let eqno = "";
  if (display) {
    if (tagged) {
      eqno = tagged.star
        ? `<span class="eqno">${escapeLiveHtml(tagged.text)}</span>`
        : `<span class="eqno">(${escapeLiveHtml(tagged.text)})</span>`;
    } else if (equationNo !== undefined) {
      eqno = `<span class="eqno">(${equationNo})</span>`;
    }
  }
  return `<span class="formula">${math}${eqno}</span>`;
}

export function latexToMathML(source: string): string {
  const p = new Parser(source);
  const body = p.parseExpr();
  return body || `<mtext>${escapeLiveHtml(source)}</mtext>`;
}

function parseCdGroup(line: string, i: number): { text: string; next: number } {
  if (line[i] === "{") {
    let depth = 1;
    i++;
    const start = i;
    while (i < line.length && depth > 0) {
      if (line[i] === "{") depth++;
      else if (line[i] === "}") depth--;
      if (depth > 0) i++;
    }
    const text = line.slice(start, i);
    if (line[i] === "}") i++;
    return { text, next: i };
  }
  const start = i;
  while (i < line.length && line[i] !== "@" && line[i] !== ">" && line[i] !== "<" &&
    line[i] !== "A" && line[i] !== "V" && line[i] !== "|" && line[i] !== "=" && line[i] !== ".") {
    i++;
  }
  return { text: line.slice(start, i), next: i };
}

function cdLabeledArrow(ch: string, over: string, under: string): string {
  let inner = `<mo>${ch}</mo>`;
  const top = over ? latexToMathML(over) : "";
  const bot = under ? latexToMathML(under) : "";
  if (top && bot) inner = `<munderover>${inner}${bot}${top}</munderover>`;
  else if (top) inner = `<mover>${inner}${top}</mover>`;
  else if (bot) inner = `<munder>${inner}${bot}</munder>`;
  return inner;
}

function parseCdArrow(line: string, i: number): { html: string; next: number } {
  if (line[i] !== "@") return { html: "", next: i };
  i++;
  if (line[i] === ".") return { html: "", next: i + 1 };
  if (line[i] === "=") return { html: "<mo>=</mo>", next: i + 1 };
  if (line[i] === "|") return { html: "<mo>∥</mo>", next: i + 1 };
  if (line[i] === ">" || line[i] === "<") {
    const dir = line[i];
    const mark = dir;
    i++;
    const a = parseCdGroup(line, i);
    i = a.next;
    if (line[i] !== mark) return { html: cdLabeledArrow(dir === ">" ? "→" : "←", a.text, ""), next: i };
    i++;
    const b = parseCdGroup(line, i);
    i = b.next;
    if (line[i] === mark) i++;
    return { html: cdLabeledArrow(dir === ">" ? "→" : "←", a.text, b.text), next: i };
  }
  if (line[i] === "A" || line[i] === "V") {
    const mark = line[i];
    const ch = mark === "A" ? "↑" : "↓";
    i++;
    const a = parseCdGroup(line, i);
    i = a.next;
    if (line[i] !== mark) return { html: cdLabeledArrow(ch, a.text, ""), next: i };
    i++;
    const b = parseCdGroup(line, i);
    i = b.next;
    if (line[i] === mark) i++;
    return { html: cdLabeledArrow(ch, a.text, b.text), next: i };
  }
  return { html: "", next: i };
}

class Parser {
  constructor(private readonly s: string, private i = 0) {}

  parseExpr(): string {
    const parts: string[] = [];
    while (this.i < this.s.length) {
      if (this.s[this.i] === "}") break;
      if (this.s[this.i] === "&") {
        this.i++;
        continue;
      }
      if (this.s[this.i] === "\n" || this.s[this.i] === "\r") {
        this.i++;
        continue;
      }
      parts.push(this.parseWithScripts());
      this.skipSpace();
      if (this.startsCommand("brack") || this.startsCommand("brace")) {
        const which = this.startsCommand("brack") ? "brack" : "brace";
        this.i += 1 + which.length;
        const right = this.parseWithScripts();
        const left = parts.pop() ?? "";
        const open = which === "brack" ? "[" : "{";
        const close = which === "brack" ? "]" : "}";
        parts.push(
          `<mrow><mo>${open}</mo><mfrac linethickness="0">${left}${right}</mfrac><mo>${close}</mo></mrow>`,
        );
      }
    }
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    return `<mrow>${parts.join("")}</mrow>`;
  }

  private parseWithScripts(): string {
    const base = this.parseNucleus();
    let sub: string | undefined;
    let sup: string | undefined;
    while (this.i < this.s.length) {
      this.skipSpace();
      if (this.s[this.i] === "_") {
        this.i++;
        sub = this.parseGroupOrAtom();
        continue;
      }
      if (this.s[this.i] === "^") {
        this.i++;
        sup = this.parseGroupOrAtom();
        continue;
      }
      if (this.s[this.i] === "'") {
        this.i++;
        const primes = "<mo>′</mo>";
        sup = sup ? `<mrow>${sup}${primes}</mrow>` : primes;
        continue;
      }
      break;
    }
    const large = base.includes('largeop="true"');
    if (sub && sup) {
      return large ? `<munderover>${base}${sub}${sup}</munderover>` : `<msubsup>${base}${sub}${sup}</msubsup>`;
    }
    if (sub) return large ? `<munder>${base}${sub}</munder>` : `<msub>${base}${sub}</msub>`;
    if (sup) return large ? `<mover>${base}${sup}</mover>` : `<msup>${base}${sup}</msup>`;
    return base;
  }

  private parseGroupOrAtom(): string {
    this.skipSpace();
    if (this.s[this.i] === "{") {
      this.i++;
      const inner = this.parseExpr();
      if (this.s[this.i] === "}") this.i++;
      return inner || "<mrow/>";
    }
    return this.parseNucleus();
  }

  private parseNucleus(): string {
    this.skipSpace();
    if (this.i >= this.s.length) return "";
    const ch = this.s[this.i];
    if (ch === "{") return this.parseGroupOrAtom();
    if (ch === "\\") return this.parseCommand();
    if (ch === "." && this.s.startsWith("...", this.i)) {
      this.i += 3;
      return "<mo>…</mo>";
    }
    this.i++;
    if (ch >= "0" && ch <= "9") {
      let n = ch;
      while (this.i < this.s.length && this.s[this.i] >= "0" && this.s[this.i] <= "9") {
        n += this.s[this.i++];
      }
      return `<mn>${n}</mn>`;
    }
    if (/[A-Za-z]/.test(ch)) return `<mi>${escapeLiveHtml(ch)}</mi>`;
    if (ch === "=" || ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "," ||
      ch === ":" || ch === ";" || ch === "(" || ch === ")" || ch === "[" || ch === "]" ||
      ch === "|" || ch === "<" || ch === ">") {
      return `<mo>${escapeLiveHtml(ch)}</mo>`;
    }
    if (ch === "'") return "<mo>′</mo>";
    return `<mi>${escapeLiveHtml(ch)}</mi>`;
  }

  private parseCommand(): string {
    this.i++; // skip \
    if (this.i >= this.s.length) return "";
    const next = this.s[this.i];
    if (!/[A-Za-z]/.test(next)) {
      this.i++;
      if (next === "," || next === ":" || next === ";" || next === " ") return "<mspace width='0.16em'/>";
      if (next === "\\" ) return "<mspace linebreak='newline'/>";
      if (next === "{" || next === "}" || next === "_" || next === "%") return `<mi>${escapeLiveHtml(next)}</mi>`;
      return `<mo>${escapeLiveHtml(next)}</mo>`;
    }
    let name = "";
    while (this.i < this.s.length && /[A-Za-z]/.test(this.s[this.i])) name += this.s[this.i++];
    this.skipSpace();
    if (name === "left") {
      const open = this.readDelimiter();
      const parts: string[] = [];
      while (this.i < this.s.length && this.s[this.i] !== "}") {
        this.skipSpace();
        if (this.startsCommand("right")) {
          this.i += 1 + "right".length;
          const close = this.readDelimiter();
          const inner = parts.length === 1 ? parts[0] : parts.length ? `<mrow>${parts.join("")}</mrow>` : "";
          return `<mrow><mo>${escapeLiveHtml(open)}</mo>${inner}<mo>${escapeLiveHtml(close)}</mo></mrow>`;
        }
        parts.push(this.parseWithScripts());
      }
      const inner = parts.length === 1 ? parts[0] : parts.length ? `<mrow>${parts.join("")}</mrow>` : "";
      return `<mrow><mo>${escapeLiveHtml(open)}</mo>${inner}</mrow>`;
    }
    if (name === "right") {
      const close = this.readDelimiter();
      return `<mo>${escapeLiveHtml(close)}</mo>`;
    }
    if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac" ||
      name === "nicefrac" || name === "unitfrac") {
      if (name === "unitfrac" && this.s[this.i] === "[") {
        this.i++;
        this.parseExprUntil("]");
        if (this.s[this.i] === "]") this.i++;
      }
      const a = this.parseGroupOrAtom();
      const b = this.parseGroupOrAtom();
      return `<mfrac>${a}${b}</mfrac>`;
    }
    if (name === "binom" || name === "dbinom" || name === "tbinom") {
      const a = this.parseGroupOrAtom();
      const b = this.parseGroupOrAtom();
      return `<mfrac linethickness="0">${a}${b}</mfrac>`;
    }
    if (name === "sqrt") {
      if (this.s[this.i] === "[") {
        this.i++;
        const idx = this.parseExprUntil("]");
        if (this.s[this.i] === "]") this.i++;
        return `<mroot>${this.parseGroupOrAtom()}${idx}</mroot>`;
      }
      return `<msqrt>${this.parseGroupOrAtom()}</msqrt>`;
    }
    if (name === "text" || name === "mathrm" || name === "textrm" || name === "operatorname" ||
      name === "textbf" || name === "textsf" || name === "texttt") {
      const inner = this.readGroupText();
      return `<mtext>${escapeLiveHtml(inner)}</mtext>`;
    }
    if (name === "mbox") return this.parseGroupOrAtom();
    if (name === "makebox") {
      while (this.s[this.i] === "[") {
        this.i++;
        this.parseExprUntil("]");
        if (this.s[this.i] === "]") this.i++;
      }
      return this.parseGroupOrAtom();
    }
    if (name === "parbox") {
      if (this.s[this.i] === "[") {
        this.i++;
        this.parseExprUntil("]");
        if (this.s[this.i] === "]") this.i++;
      }
      if (this.s[this.i] === "{") this.readGroupText();
      return this.parseGroupOrAtom();
    }
    if (name === "genfrac") {
      const left = this.readGroupText();
      const right = this.readGroupText();
      const bar = this.readGroupText();
      this.readGroupText();
      const a = this.parseGroupOrAtom();
      const b = this.parseGroupOrAtom();
      const frac = bar === "0pt" || bar === "0" || bar === "0mm"
        ? `<mfrac linethickness="0">${a}${b}</mfrac>`
        : `<mfrac>${a}${b}</mfrac>`;
      if (!left && !right) return frac;
      return `<mrow>${left ? `<mo>${escapeLiveHtml(left)}</mo>` : ""}${frac}${right ? `<mo>${escapeLiveHtml(right)}</mo>` : ""}</mrow>`;
    }
    if (
      name === "scriptstyle" || name === "scriptscriptstyle" ||
      name === "textstyle" || name === "displaystyle"
    ) {
      const rest = this.parseExpr();
      if (name === "scriptstyle") return `<mstyle mathsize="75%">${rest}</mstyle>`;
      if (name === "scriptscriptstyle") return `<mstyle mathsize="60%">${rest}</mstyle>`;
      return rest;
    }
    if (name === "raisebox") {
      const height = this.readGroupText().trim();
      const inner = this.parseGroupOrAtom();
      return `<mpadded voffset="${escapeLiveHtml(height)}">${inner}</mpadded>`;
    }
    if (name === "textcolor") {
      const color = this.readGroupText().trim();
      const inner = this.parseGroupOrAtom();
      return `<mstyle mathcolor="${escapeLiveHtml(mathColor(color))}">${inner}</mstyle>`;
    }
    if (name === "color") {
      const color = this.s[this.i] === "{" ? this.readGroupText().trim() : this.readColorWord();
      const rest = this.parseExpr();
      return `<mstyle mathcolor="${escapeLiveHtml(mathColor(color))}">${rest}</mstyle>`;
    }
    if (name === "boxed") {
      const inner = this.parseGroupOrAtom();
      return `<menclose notation="box">${inner}</menclose>`;
    }
    if (name === "colorbox") {
      const color = this.readGroupText().trim();
      const inner = this.parseGroupOrAtom();
      return `<mstyle mathbackground="${escapeLiveHtml(mathColor(color))}">${inner}</mstyle>`;
    }
    if (name === "fcolorbox") {
      this.readGroupText();
      const fill = this.readGroupText().trim();
      const inner = this.parseGroupOrAtom();
      return `<menclose notation="box"><mstyle mathbackground="${escapeLiveHtml(mathColor(fill))}">${inner}</mstyle></menclose>`;
    }
    if (name === "fbox" || name === "framebox") {
      if (this.s[this.i] === "[") {
        this.i++;
        this.parseExprUntil("]");
        if (this.s[this.i] === "]") this.i++;
      }
      const inner = this.parseGroupOrAtom();
      return `<menclose notation="box">${inner}</menclose>`;
    }
    if (name === "mathds") {
      const inner = this.parseGroupOrAtom();
      return `<mstyle mathvariant="double-struck">${inner}</mstyle>`;
    }
    if (name === "pmod") {
      const inner = this.parseGroupOrAtom();
      return `<mrow><mo>(</mo><mtext>mod </mtext>${inner}<mo>)</mo></mrow>`;
    }
    if (name === "pod") {
      const inner = this.parseGroupOrAtom();
      return `<mrow><mo>(</mo>${inner}<mo>)</mo></mrow>`;
    }
    if (name === "Bra") {
      return `<mrow><mo>⟨</mo>${this.parseGroupOrAtom()}<mo>|</mo></mrow>`;
    }
    if (name === "Ket") {
      return `<mrow><mo>|</mo>${this.parseGroupOrAtom()}<mo>⟩</mo></mrow>`;
    }
    if (name === "Braket") {
      return `<mrow><mo>⟨</mo>${this.parseGroupOrAtom()}<mo>⟩</mo></mrow>`;
    }
    if (name === "cancel") {
      return `<menclose notation="updiagonalstrike">${this.parseGroupOrAtom()}</menclose>`;
    }
    if (name === "bcancel") {
      return `<menclose notation="downdiagonalstrike">${this.parseGroupOrAtom()}</menclose>`;
    }
    if (name === "xcancel") {
      return `<menclose notation="updiagonalstrike downdiagonalstrike">${this.parseGroupOrAtom()}</menclose>`;
    }
    if (name === "cancelto") {
      const to = this.parseGroupOrAtom();
      const inner = this.parseGroupOrAtom();
      return `<msup><menclose notation="updiagonalstrike">${inner}</menclose>${to}</msup>`;
    }
    if (name === "sideset") {
      this.parseGroupOrAtom();
      this.parseGroupOrAtom();
      return this.parseWithScripts();
    }
    if (name === "splitfrac" || name === "splitdfrac") {
      const a = this.parseGroupOrAtom();
      const b = this.parseGroupOrAtom();
      return `<mfrac>${a}${b}</mfrac>`;
    }
    if (name === "substack") {
      const raw = this.readGroupText();
      const rows = raw.split(/\\\\/).map((row) => `<mtr><mtd>${latexToMathML(row.trim())}</mtd></mtr>`);
      return `<mtable>${rows.join("")}</mtable>`;
    }
    if (name === "intertext" || name === "shortintertext") {
      const inner = this.readGroupText();
      return `<mtext>${escapeLiveHtml(inner)}</mtext>`;
    }
    if (name === "varliminf") return `<munder><mi>lim</mi><mo>―</mo></munder>`;
    if (name === "varlimsup") return `<mover><mi>lim</mi><mo>―</mo></mover>`;
    if (name === "varprojlim") return `<munder><mi>lim</mi><mo>←</mo></munder>`;
    if (name === "varinjlim") return `<munder><mi>lim</mi><mo>→</mo></munder>`;
    if (name === "relax") return "";
    if (name === "footnotesize" || name === "scriptsize") return this.parseWithScripts();
    if (name === "unit") {
      const inner = this.s[this.i] === "{" ? this.readGroupText() : this.readColorWord();
      return `<mtext>${escapeLiveHtml(inner)}</mtext>`;
    }
    if (name === "uptau") return "<mi>τ</mi>";
    if (name === "uppi") return "<mi>π</mi>";
    if (name === "upmu") return "<mi>μ</mi>";
    if (name === "upnu") return "<mi>ν</mi>";
    if (name === "hfill" || name === "negmedspace" || name === "negthickspace" || name === "negthinspace") {
      return "<mspace width='0.2em'/>";
    }
    if (name === "hdotsfor" || name === "dotfill") {
      if (this.s[this.i] === "{") this.readGroupText();
      return "<mo>⋯</mo>";
    }
    if (name === "hrulefill") return "<mo>─</mo>";
    if (name === "lefteqn" || name === "shoveleft" || name === "oldstylenums") {
      return this.parseGroupOrAtom();
    }
    if (name === "mathbf" || name === "boldsymbol" || name === "mathsf" || name === "mathtt" ||
      name === "mathit" || name === "mathcal" || name === "mathfrak" || name === "mathbb" ||
      name === "mathscr") {
      const inner = this.parseGroupOrAtom();
      const variant = name === "mathbf" || name === "boldsymbol"
        ? "bold"
        : name === "mathsf"
        ? "sans-serif"
        : name === "mathtt"
        ? "monospace"
        : name === "mathcal" || name === "mathscr"
        ? "script"
        : name === "mathfrak"
        ? "fraktur"
        : name === "mathbb"
        ? "double-struck"
        : "italic";
      return `<mstyle mathvariant="${variant}">${inner}</mstyle>`;
    }
    if (name === "ce" || name === "ensuremath") {
      if (this.s[this.i] === "{") {
        const inner = this.readGroupText();
        return `<mtext>${escapeLiveHtml(inner)}</mtext>`;
      }
      return this.parseWithScripts();
    }
    if (SKIP_NEXT.has(name)) return this.parseWithScripts();
    if (SKIP_GROUP.has(name)) {
      if (this.s[this.i] === "[") {
        this.i++;
        this.parseExprUntil("]");
        if (this.s[this.i] === "]") this.i++;
      }
      if (this.s[this.i] === "{") this.readGroupText();
      return "";
    }
    if (name === "quad") return "<mspace width='1em'/>";
    if (name === "qquad") return "<mspace width='2em'/>";
    if (name === "," || name === "thinspace") return "<mspace width='0.16em'/>";
    if (name === "phantom" || name === "hphantom" || name === "vphantom") {
      this.parseGroupOrAtom();
      return "<mspace width='0.4em'/>";
    }
    if (name === "not") {
      const next = this.parseWithScripts();
      if (next === "<mo>=</mo>") return "<mo>≠</mo>";
      return `<menclose notation="updiagonalstrike">${next}</menclose>`;
    }
    if (name === "underset" || name === "overset" || name === "stackrel") {
      const acc = this.parseGroupOrAtom();
      const base = this.parseGroupOrAtom();
      return name === "underset" ? `<munder>${base}${acc}</munder>` : `<mover>${base}${acc}</mover>`;
    }
    if (/^x/.test(name) && /arrow|harpoon|hook/.test(name)) {
      let under = "";
      let over = "";
      if (this.s[this.i] === "[") {
        this.i++;
        under = this.parseExprUntil("]");
        if (this.s[this.i] === "]") this.i++;
      }
      if (this.s[this.i] === "{") over = this.parseGroupOrAtom();
      const core = name.replace(/^x/, "").replace(/^long/, "");
      const ch = SYM_MO[core] ?? SYM_MO[name] ?? (name.toLowerCase().includes("left") ? "←" : "→");
      const arrow = `<mo>${ch}</mo>`;
      if (under && over) return `<munderover>${arrow}${under}${over}</munderover>`;
      if (over) return `<mover>${arrow}${over}</mover>`;
      if (under) return `<munder>${arrow}${under}</munder>`;
      return arrow;
    }
    if (ACCENT_OVER[name]) {
      const inner = this.parseGroupOrAtom();
      return `<mover>${inner}<mo>${escapeLiveHtml(ACCENT_OVER[name])}</mo></mover>`;
    }
    if (ACCENT_UNDER[name]) {
      const inner = this.parseGroupOrAtom();
      return `<munder>${inner}<mo>${escapeLiveHtml(ACCENT_UNDER[name])}</mo></munder>`;
    }
    if (name === "overbrace" || name === "underbrace" || name === "overbracket" || name === "underbracket") {
      const inner = this.parseGroupOrAtom();
      const bar = name.startsWith("over") ? "⏞" : "⏟";
      return name.startsWith("over")
        ? `<mover>${inner}<mo>${bar}</mo></mover>`
        : `<munder>${inner}<mo>${bar}</mo></munder>`;
    }
    if (/^(?:b|B)ig+[lrm]?$/.test(name) || name === "middle") {
      return `<mo>${escapeLiveHtml(this.readDelimiter())}</mo>`;
    }
    if (name === "begin") {
      const env = this.readGroupText();
      if (env === "CD") return this.parseCD();
      if (MATRIX_ENV[env]) return this.parseMatrix(env);
      return "";
    }
    if (name === "end") {
      this.readGroupText();
      return "";
    }
    if (LARGEOP.has(name)) {
      return `<mo largeop="true">${LARGEOP_CHAR[name]}</mo>`;
    }
    if (OPNAME.has(name)) return `<mi>${name}</mi>`;
    if (SYM_MO[name]) return `<mo>${SYM_MO[name]}</mo>`;
    if (SYM_MI[name]) return `<mi>${SYM_MI[name]}</mi>`;
    // Unknown command: skip one optional group and show the name.
    if (this.s[this.i] === "{") this.readGroupText();
    return `<mi>${escapeLiveHtml("\\" + name)}</mi>`;
  }

  private parseCD(): string {
    const endAt = this.s.indexOf("\\end{CD}", this.i);
    const raw = (endAt < 0 ? this.s.slice(this.i) : this.s.slice(this.i, endAt)).trim();
    this.i = endAt < 0 ? this.s.length : endAt + "\\end{CD}".length;
    const lines = raw.split(/\\\\/).map((l) => l.trim()).filter((l) => l.length > 0);
    const rows = lines.map((line) => this.parseCdLine(line));
    return `<mtable columnspacing="0.4em" rowspacing="0.4em">${
      rows.map((r) => `<mtr>${r.map((c) => `<mtd>${c}</mtd>`).join("")}</mtr>`).join("")
    }</mtable>`;
  }

  private parseCdLine(line: string): string[] {
    const cells: string[] = [];
    let i = 0;
    const takeText = (): string => {
      const start = i;
      while (i < line.length && line[i] !== "@") i++;
      const raw = line.slice(start, i).trim();
      return raw ? latexToMathML(raw) : "";
    };
    if (!line.startsWith("@")) cells.push(takeText());
    while (i < line.length) {
      if (line[i] !== "@") {
        cells.push(takeText());
        continue;
      }
      const { html, next } = parseCdArrow(line, i);
      i = next;
      cells.push(html);
      if (i < line.length && line[i] !== "@") cells.push(takeText());
    }
    if (line.startsWith("@")) {
      const padded: string[] = [];
      for (let c = 0; c < cells.length; c++) {
        padded.push(cells[c]);
        if (c < cells.length - 1) padded.push("");
      }
      return padded;
    }
    return cells;
  }

  private parseMatrix(env: string): string {
    this.skipSpace();
    if (this.s[this.i] === "[") {
      this.i++;
      this.parseExprUntil("]");
      if (this.s[this.i] === "]") this.i++;
    }
    this.skipSpace();
    if (this.s[this.i] === "{") this.readGroupText();
    const rows: string[][] = [];
    let row: string[] = [];
    const flush = () => {
      if (row.length) {
        rows.push(row);
        row = [];
      }
    };
    while (this.i < this.s.length) {
      this.skipSpace();
      if (this.s[this.i] === "\n" || this.s[this.i] === "\r") {
        this.i++;
        continue;
      }
      if (this.startsCommand("end")) {
        this.i += 1 + "end".length;
        this.readGroupText();
        flush();
        break;
      }
      row.push(this.parseMatrixCell() || "<mrow/>");
      this.skipSpace();
      if (this.s[this.i] === "&") {
        this.i++;
        continue;
      }
      if (this.s.startsWith("\\\\", this.i)) {
        this.i += 2;
        this.skipSpace();
        if (this.s[this.i] === "[") {
          this.i++;
          this.parseExprUntil("]");
          if (this.s[this.i] === "]") this.i++;
        }
        flush();
        continue;
      }
      flush();
      if (this.startsCommand("end")) continue;
      break;
    }
    const table = `<mtable>${
      rows.map((r) => `<mtr>${r.map((c) => `<mtd>${c}</mtd>`).join("")}</mtr>`).join("")
    }</mtable>`;
    const fences = MATRIX_ENV[env] ?? { open: "", close: "" };
    if (!fences.open && !fences.close) return table;
    const close = fences.close ? `<mo>${escapeLiveHtml(fences.close)}</mo>` : "";
    return `<mrow><mo>${escapeLiveHtml(fences.open)}</mo>${table}${close}</mrow>`;
  }

  private parseMatrixCell(): string {
    const parts: string[] = [];
    while (this.i < this.s.length) {
      this.skipSpace();
      if (this.s[this.i] === "&") break;
      if (this.s.startsWith("\\\\", this.i)) break;
      if (this.startsCommand("end")) break;
      if (this.s[this.i] === "\n" || this.s[this.i] === "\r") {
        this.i++;
        continue;
      }
      parts.push(this.parseWithScripts());
    }
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    return `<mrow>${parts.join("")}</mrow>`;
  }

  private readDelimiter(): string {
    this.skipSpace();
    if (this.s[this.i] === "\\") {
      this.i++;
      let name = "";
      while (this.i < this.s.length && /[A-Za-z]/.test(this.s[this.i])) name += this.s[this.i++];
      if (name === "lvert" || name === "rvert" || name === "vert") return "|";
      if (name === "langle") return "⟨";
      if (name === "rangle") return "⟩";
      if (name === "{") return "{";
      if (name === "}") return "}";
      return name || this.s[this.i - 1] || "";
    }
    if (this.i < this.s.length) return this.s[this.i++];
    return "";
  }

  private readGroupText(): string {
    this.skipSpace();
    if (this.s[this.i] !== "{") return "";
    this.i++;
    let depth = 1;
    let out = "";
    while (this.i < this.s.length && depth > 0) {
      const ch = this.s[this.i++];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      out += ch;
    }
    return out;
  }

  private parseExprUntil(stop: string): string {
    const start = this.i;
    const saved = this.s;
    // Temporarily parse until the stop char at depth 0.
    const parts: string[] = [];
    while (this.i < saved.length && saved[this.i] !== stop) {
      if (saved[this.i] === "}") break;
      parts.push(this.parseWithScripts());
    }
    if (parts.length === 0) {
      this.i = start;
      return "";
    }
    if (parts.length === 1) return parts[0];
    return `<mrow>${parts.join("")}</mrow>`;
  }

  private startsCommand(name: string): boolean {
    if (this.s[this.i] !== "\\") return false;
    if (!this.s.startsWith(name, this.i + 1)) return false;
    const after = this.s[this.i + 1 + name.length];
    return !after || !/[A-Za-z]/.test(after);
  }

  private readColorWord(): string {
    this.skipSpace();
    let name = "";
    while (this.i < this.s.length && /[A-Za-z]/.test(this.s[this.i])) name += this.s[this.i++];
    return name;
  }

  private skipSpace(): void {
    while (this.i < this.s.length && /[ \t]/.test(this.s[this.i])) this.i++;
  }
}
