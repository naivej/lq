/**
 * Small TeX-to-MathML converter for Live formula insets.
 * Covers the LyX subset: greek, scripts, sums, delimiters, fractions, primes.
 * Unknown commands fall back to mtext so source never becomes executable HTML.
 * Math-mode fonts emit Unicode alphanumerics (MathML Core / DL153).
 */
import { MATH_ALPHANUM, type MathAlphanumVariant } from "./math_alphanum.ts";

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

/** Max nested `\newcommand` expansions (DL132 F5) — cycles fall back instead of exhausting the stack. */
const MAX_MACRO_EXPANSION_DEPTH = 64;

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

type MathFamily = "normal" | "script" | "fraktur" | "double-struck" | "sans" | "mono";
type MathSeries = "medium" | "bold";
type MathShape = "italic" | "up";
type MathFontState = { family: MathFamily; series: MathSeries; shape: MathShape };

const DEFAULT_MATH_FONT: MathFontState = { family: "normal", series: "medium", shape: "italic" };

/** LyX GUI math fonts (toolbar + Edit → Math → Text Properties). */
const MATH_FONT_CMD: Record<string, Partial<MathFontState>> = {
  mathbf: { series: "bold", shape: "up" },
  boldsymbol: { series: "bold", shape: "italic" },
  mathit: { shape: "italic" },
  mathsf: { family: "sans", shape: "up" },
  mathtt: { family: "mono", shape: "up" },
  mathbb: { family: "double-struck", shape: "up" },
  mathds: { family: "double-struck", shape: "up" },
  mathfrak: { family: "fraktur", shape: "up" },
  mathcal: { family: "script", shape: "up" },
  mathscr: { family: "script", shape: "up" },
  mathrm: { family: "normal", series: "medium", shape: "up" },
  mathnormal: { family: "normal", series: "medium", shape: "italic" },
};

/** Text-in-math fonts: keep mtext (spaces) and paint with CSS. */
const TEXT_FONT_STYLE: Record<string, string> = {
  textbf: "font-weight:bold",
  textit: "font-style:italic",
  textsl: "font-style:italic",
  textsf: "font-family:sans-serif",
  texttt: "font-family:monospace",
  textsc: "font-variant:small-caps",
};
const TEXT_PLAIN = new Set([
  "text",
  "textrm",
  "textnormal",
  "textup",
  "textmd",
  "operatorname",
]);

function isDefaultFont(font: MathFontState): boolean {
  return font.family === "normal" && font.series === "medium" && font.shape === "italic";
}

function needsUprightMi(font: MathFontState): boolean {
  return font.family === "normal" && font.series === "medium" && font.shape === "up";
}

function styledAlphanum(ch: string, font: MathFontState): string {
  const row = MATH_ALPHANUM[ch];
  if (!row) return ch;
  const pick = (...keys: MathAlphanumVariant[]): string | undefined => {
    for (const k of keys) {
      if (row[k]) return row[k];
    }
    return undefined;
  };
  if (font.family === "double-struck") return pick("doubleStruck") ?? ch;
  if (font.family === "script") {
    return (font.series === "bold" ? pick("boldScript", "script") : pick("script")) ?? ch;
  }
  if (font.family === "fraktur") {
    return (font.series === "bold" ? pick("boldFraktur", "fraktur") : pick("fraktur")) ?? ch;
  }
  if (font.family === "sans") {
    if (font.series === "bold" && font.shape === "italic") {
      return pick("boldItalicSans", "boldSans", "italicSans", "sans") ?? ch;
    }
    if (font.series === "bold") return pick("boldSans", "sans") ?? ch;
    if (font.shape === "italic") return pick("italicSans", "sans") ?? ch;
    // Digits: LyX stores sans-serif digits in the bold_sans column.
    return pick("sans", "boldSans") ?? ch;
  }
  if (font.family === "mono") return pick("monospace") ?? ch;
  if (font.shape === "up") return (font.series === "bold" ? pick("bold") : undefined) ?? ch;
  if (font.series === "bold") return pick("boldItalic", "bold") ?? ch;
  return pick("italic") ?? ch;
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
  // mhchem bond atoms (also used inside `\ce{…}`)
  sbond: "−", dbond: "=", tbond: "≡", hyphen: "‐",
};

/** Optional preamble `\newcommand` macros applied while converting formulas. */
export type MathMacro = {
  nargs: number;
  /** Optional first-arg default when `\newcommand{\x}[n][default]{…}`. */
  optionalDefault?: string;
  body: string;
};

export type MathMacroMap = Map<string, MathMacro>;

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
  // underline/underbar use menclose "bottom" (full-width), not a short "_" mo.
  underrightarrow: "→", underleftarrow: "←", underleftrightarrow: "↔",
  utilde: "˜",
};

const SKIP_NEXT = new Set([
  "limits", "nolimits", "nonumber", "notag", "mathop",
]);

const SKIP_GROUP = new Set([
  "tag", "label", "hspace", "vspace", "rule",
  "leftroot", "uproot", "adjustlimits",
]);

const ENV = /\\begin\{(equation\*?|align\*?|alignat\*?|flalign\*?|displaymath|multline\*?|gather\*?|eqnarray\*?)\}(?:\{[^}]*\})?([\s\S]*)\\end\{\1\}/;
const NUMBERED_ENV = /^(equation|align|alignat|flalign|multline|gather|eqnarray)$/;
const MULTI_LINE_ENV = /^(align|alignat|flalign|gather|multline|eqnarray)\*?$/;

export type FormulaLine = {
  tex: string;
  consumesNumber: boolean;
  labels: string[];
  tag?: { star: boolean; text: string };
};

export type FormulaLinePlan = {
  display: boolean;
  numbered: boolean;
  env: string;
  lines: FormulaLine[];
};

function peelLatexSource(source: string): {
  display: boolean;
  numbered: boolean;
  env: string;
  rawBody: string;
} {
  let s = source.trim();
  let display = false;
  let numbered = false;
  let envName = "";
  const env = ENV.exec(s);
  if (env && env.index === 0 && env[0].length === s.length) {
    display = true;
    envName = env[1];
    numbered = NUMBERED_ENV.test(env[1]);
    s = env[2].trim();
  } else if (s.startsWith("$$") && s.endsWith("$$")) {
    display = true;
    envName = "$$";
    s = s.slice(2, -2).trim();
  } else if (s.startsWith("\\[") && s.endsWith("\\]")) {
    display = true;
    envName = "[";
    s = s.slice(2, -2).trim();
  } else if (s.startsWith("$") && s.endsWith("$") && s.length >= 2) {
    envName = "$";
    s = s.slice(1, -1).trim();
  }
  return { display, numbered, env: envName, rawBody: s };
}

export function unwrapLatexSource(source: string): {
  display: boolean;
  numbered: boolean;
  env: string;
  body: string;
} {
  const peeled = peelLatexSource(source);
  return {
    display: peeled.display,
    numbered: peeled.numbered,
    env: peeled.env,
    body: peeled.rawBody.replace(/\\label\{[^}]*\}/g, "").trim(),
  };
}

function extractTag(body: string): { star: boolean; text: string } | undefined {
  const m = /\\tag(\*)?\{([^{}]*)\}/.exec(body);
  if (!m) return undefined;
  return { star: m[1] === "*", text: m[2] };
}

function splitTopLevel(s: string, sep: "\\\\" | "&"): string[] {
  const parts: string[] = [];
  let start = 0;
  let brace = 0;
  let envDepth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") brace++;
    else if (ch === "}" && brace > 0) brace--;
    else if (ch === "\\" && brace === 0) {
      if (s.startsWith("\\begin{", i)) envDepth++;
      else if (s.startsWith("\\end{", i)) envDepth = Math.max(0, envDepth - 1);
      else if (sep === "\\\\" && envDepth === 0 && s[i + 1] === "\\") {
        parts.push(s.slice(start, i));
        i++;
        if (s[i + 1] === "*") i++;
        if (s[i + 1] === "[") {
          const close = s.indexOf("]", i + 2);
          if (close >= 0) i = close;
        }
        start = i + 1;
      }
    } else if (sep === "&" && ch === "&" && brace === 0 && envDepth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  if (sep === "&") return parts.map((p) => p.trim());
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export function planFormulaLines(source: string): FormulaLinePlan {
  const peeled = peelLatexSource(source);
  const chunks = MULTI_LINE_ENV.test(peeled.env)
    ? splitTopLevel(peeled.rawBody, "\\\\")
    : [peeled.rawBody];
  const lines = (chunks.length > 0 ? chunks : [""]).map((tex, i, arr) => {
    const labels = [...tex.matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1]);
    const tag = extractTag(tex);
    const skip = /\\nonumber\b|\\notag\b/.test(tex);
    let consumesNumber = false;
    if (peeled.numbered && !skip) {
      consumesNumber = peeled.env === "multline" ? i === arr.length - 1 : true;
    }
    return { tex, consumesNumber, labels, tag };
  });
  return { display: peeled.display, numbered: peeled.numbered, env: peeled.env, lines };
}

function stripLineCommands(tex: string): string {
  return tex
    .replace(/\\label\{[^}]*\}/g, "")
    .replace(/\\tag\*?\{[^{}]*\}/g, "")
    .replace(/\\nonumber\b/g, "")
    .replace(/\\notag\b/g, "")
    .trim();
}

function lineToMathML(tex: string, macros?: MathMacroMap): string {
  const clean = stripLineCommands(tex);
  if (clean.includes("&")) {
    const cells = splitTopLevel(clean, "&").map((c) =>
      `<mtd>${latexToMathML(c, macros) || "<mrow/>"}</mtd>`
    );
    return `<mtable><mtr>${cells.join("")}</mtr></mtable>`;
  }
  return latexToMathML(clean, macros);
}

function mathHtml(inner: string, body: string, display: boolean): string {
  const displayAttr = display ? ' display="block"' : "";
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${displayAttr}><semantics>${inner}<annotation encoding="application/x-tex">${escapeLiveHtml(body)}</annotation></semantics></math>`;
}

function lineEqnoHtml(line: FormulaLine, no?: number | string): string {
  if (line.tag) {
    return line.tag.star
      ? `<span class="eqno">${escapeLiveHtml(line.tag.text)}</span>`
      : `<span class="eqno">(${escapeLiveHtml(line.tag.text)})</span>`;
  }
  if (line.consumesNumber && no !== undefined) return `<span class="eqno">(${no})</span>`;
  return "";
}

export function renderFormulaHtml(
  source: string,
  equationNo?: number | string | Array<number | string | undefined>,
  macros?: MathMacroMap,
): string {
  const plan = planFormulaLines(source);
  const nos = Array.isArray(equationNo) ? equationNo : [equationNo];
  if (plan.lines.length > 1) {
    const rows = plan.lines.map((line, i) => {
      const body = stripLineCommands(line.tex);
      const math = mathHtml(lineToMathML(line.tex, macros), body, true);
      return `<span class="formula-row">${math}${lineEqnoHtml(line, nos[i])}</span>`;
    });
    return `<span class="formula">${rows.join("")}</span>`;
  }
  const line = plan.lines[0] ?? { tex: "", consumesNumber: false, labels: [] as string[] };
  const body = stripLineCommands(line.tex);
  const inner = latexToMathML(body, macros);
  return `<span class="formula">${mathHtml(inner, body, plan.display)}${lineEqnoHtml(line, nos[0])}</span>`;
}

export function latexToMathML(source: string, macros?: MathMacroMap, macroDepth = 0): string {
  const p = new Parser(source, 0, macros, macroDepth);
  const body = p.parseExpr();
  return body || `<mtext>${escapeLiveHtml(source)}</mtext>`;
}

/**
 * Parse simple `\newcommand{\name}[n][default]{body}` forms from a LaTeX preamble.
 * Enough for Help Math.lyx demo aliases (`\gr`, `\us`, `\cb`, `\fb`, …).
 */
export function parseNewcommands(preamble: string): MathMacroMap {
  const out: MathMacroMap = new Map();
  const cmdRe =
    /\\newcommand\*?\{\\([A-Za-z]+)\}(?:\[(\d+)\])?(?:\[([^\]]*)\])?\{/g;
  let m: RegExpExecArray | null;
  while ((m = cmdRe.exec(preamble)) !== null) {
    const name = m[1]!;
    const nargs = m[2] ? parseInt(m[2], 10) : 0;
    const optionalDefault = m[3];
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < preamble.length && depth > 0) {
      const ch = preamble[i++]!;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    const body = preamble.slice(bodyStart, i - 1);
    out.set(name, {
      nargs,
      optionalDefault: optionalDefault !== undefined ? optionalDefault : undefined,
      body,
    });
  }
  return out;
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

/** Light mhchem-ish expander for `\ce{…}` — subscripts, superscripts, arrows. */
function expandChemExpr(tex: string): string {
  const s = tex.trim();
  const parts: string[] = [];
  let i = 0;
  const readBracket = (): string => {
    if (s[i] !== "[") return "";
    i++;
    const start = i;
    let depth = 1;
    while (i < s.length && depth > 0) {
      if (s[i] === "[") depth++;
      else if (s[i] === "]") depth--;
      if (depth > 0) i++;
    }
    const text = s.slice(start, i);
    if (s[i] === "]") i++;
    return text;
  };
  const readGroup = (): string => {
    if (s[i] === "{") {
      i++;
      let depth = 1;
      let out = "";
      while (i < s.length && depth > 0) {
        const ch = s[i++];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) break;
        }
        out += ch;
      }
      return out;
    }
    return s[i] ? s[i++] : "";
  };
  while (i < s.length) {
    if (s.startsWith("<=>", i) || s.startsWith("<->", i)) {
      parts.push("<mo>⇌</mo>");
      i += 3;
      continue;
    }
    if (s.startsWith("->", i) || s.startsWith("<-", i)) {
      const right = s.startsWith("->", i);
      i += 2;
      const over = readBracket();
      const under = readBracket();
      let arrow = `<mo>${right ? "→" : "←"}</mo>`;
      const top = over ? latexToMathML(over) : "";
      const bot = under ? latexToMathML(under) : "";
      if (top && bot) arrow = `<munderover>${arrow}${bot}${top}</munderover>`;
      else if (top) arrow = `<mover>${arrow}${top}</mover>`;
      else if (bot) arrow = `<munder>${arrow}${bot}</munder>`;
      parts.push(arrow);
      continue;
    }
    if (s[i] === "^") {
      i++;
      const script = readGroup();
      const prev = parts.pop() ?? "<mrow/>";
      parts.push(`<msup>${prev}${latexToMathML(script)}</msup>`);
      continue;
    }
    if (s[i] === "_") {
      i++;
      const script = readGroup();
      const prev = parts.pop() ?? "<mrow/>";
      parts.push(`<msub>${prev}${latexToMathML(script)}</msub>`);
      continue;
    }
    if (/[0-9]/.test(s[i]!)) {
      let n = "";
      while (i < s.length && /[0-9]/.test(s[i]!)) n += s[i++];
      const prev = parts[parts.length - 1];
      if (prev && prev.startsWith("<mi")) {
        parts.pop();
        parts.push(`<msub>${prev}<mn>${n}</mn></msub>`);
      } else {
        parts.push(`<mn>${n}</mn>`);
      }
      continue;
    }
    if (/[A-Za-z]/.test(s[i]!)) {
      let name = s[i++]!;
      if (i < s.length && /[a-z]/.test(s[i]!)) name += s[i++]!;
      parts.push(`<mi mathvariant="normal">${escapeLiveHtml(name)}</mi>`);
      continue;
    }
    if (s[i] === "+" || s[i] === "-" || s[i] === "(" || s[i] === ")" || s[i] === "[" || s[i] === "]") {
      parts.push(`<mo>${escapeLiveHtml(s[i++]!)}</mo>`);
      continue;
    }
    if (/\s/.test(s[i]!)) {
      i++;
      continue;
    }
    if (s[i] === "\\") {
      parts.push(latexToMathML(s.slice(i)));
      break;
    }
    parts.push(`<mtext>${escapeLiveHtml(s[i++]!)}</mtext>`);
  }
  if (parts.length === 0) return "<mrow/>";
  if (parts.length === 1) return parts[0]!;
  return `<mrow>${parts.join("")}</mrow>`;
}

class Parser {
  private font: MathFontState = { ...DEFAULT_MATH_FONT };

  constructor(
    private readonly s: string,
    private i = 0,
    private readonly macros: MathMacroMap | undefined = undefined,
    private readonly macroDepth = 0,
  ) {}

  private withFont(patch: Partial<MathFontState>, body: () => string): string {
    const prev = this.font;
    this.font = { ...prev, ...patch };
    try {
      return body();
    } finally {
      this.font = prev;
    }
  }

  private emitIdent(ch: string): string {
    if (isDefaultFont(this.font)) return `<mi>${escapeLiveHtml(ch)}</mi>`;
    const glyph = styledAlphanum(ch, this.font);
    const attr = needsUprightMi(this.font) ? ' mathvariant="normal"' : "";
    return `<mi${attr}>${escapeLiveHtml(glyph)}</mi>`;
  }

  private emitNumber(n: string): string {
    if (isDefaultFont(this.font) || needsUprightMi(this.font)) {
      const attr = needsUprightMi(this.font) ? ' mathvariant="normal"' : "";
      return `<mn${attr}>${n}</mn>`;
    }
    const glyphs = [...n].map((d) => styledAlphanum(d, this.font)).join("");
    return `<mn>${escapeLiveHtml(glyphs)}</mn>`;
  }

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
      return this.emitNumber(n);
    }
    if (/[A-Za-z]/.test(ch)) return this.emitIdent(ch);
    if (ch === "=" || ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "," ||
      ch === ":" || ch === ";" || ch === "(" || ch === ")" || ch === "[" || ch === "]" ||
      ch === "|" || ch === "<" || ch === ">") {
      return `<mo>${escapeLiveHtml(ch)}</mo>`;
    }
    if (ch === "'") return "<mo>′</mo>";
    return this.emitIdent(ch);
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
    const macro = this.macros?.get(name);
    if (macro) return this.expandMacro(name, macro);
    const fontPatch = MATH_FONT_CMD[name];
    if (fontPatch) return this.withFont(fontPatch, () => this.parseGroupOrAtom());
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
      // Optional [l]/[r]/unit args — ignore for MathML shape.
      if (this.s[this.i] === "[") {
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
    if (TEXT_PLAIN.has(name) || TEXT_FONT_STYLE[name]) {
      const inner = this.readGroupText();
      const css = TEXT_FONT_STYLE[name];
      return css
        ? `<mtext style="${css}">${escapeLiveHtml(inner)}</mtext>`
        : `<mtext>${escapeLiveHtml(inner)}</mtext>`;
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
      // \fcolorbox{frame}{fill}{content} — frame must stay visible (Math.lyx `\cb{red}{…}`).
      const frame = this.readGroupText().trim();
      const fill = this.readGroupText().trim();
      const inner = this.parseGroupOrAtom();
      const border = mathColor(frame);
      const bg = mathColor(fill);
      return `<menclose notation="box" style="border:2px solid ${escapeLiveHtml(border)};padding:0.15em"><mstyle mathbackground="${escapeLiveHtml(bg)}">${inner}</mstyle></menclose>`;
    }
    if (name === "underline" || name === "underbar") {
      // Full-width rule under the whole argument (not a short "_" glyph).
      return `<menclose notation="bottom">${this.parseGroupOrAtom()}</menclose>`;
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
      const left = this.readGroupText();
      const right = this.readGroupText();
      const op = this.parseWithScripts();
      const leftScripts = this.parseSideScripts(left);
      const rightScripts = this.parseSideScripts(right);
      return `<mmultiscripts>${op}${rightScripts.sub}${rightScripts.sup}<mprescripts/>${leftScripts.sub}${leftScripts.sup}</mmultiscripts>`;
    }
    if (name === "smashoperator") {
      if (this.s[this.i] === "[") {
        this.i++;
        this.parseExprUntil("]");
        if (this.s[this.i] === "]") this.i++;
      }
      return this.parseGroupOrAtom();
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
    if (name === "ensuremath") {
      if (this.s[this.i] === "{") {
        const inner = this.readGroupText();
        return latexToMathML(inner);
      }
      return this.parseWithScripts();
    }
    if (name === "ce") {
      if (this.s[this.i] === "{") {
        return expandChemExpr(this.readGroupText());
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
      const inner = this.parseGroupOrAtom();
      return `<mphantom>${inner}</mphantom>`;
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
      // Optional thickness [3pt] etc.
      if (this.s[this.i] === "[") {
        this.i++;
        this.parseExprUntil("]");
        if (this.s[this.i] === "]") this.i++;
      }
      const inner = this.parseGroupOrAtom();
      const over = name.startsWith("over");
      const bar = over
        ? (name.includes("bracket") ? "⎴" : "⏞")
        : (name.includes("bracket") ? "⎵" : "⏟");
      const brace = over
        ? `<mover>${inner}<mo>${bar}</mo></mover>`
        : `<munder>${inner}<mo>${bar}</mo></munder>`;
      // Limits after the brace sit above/below (Op-style), not as msup/msub beside it.
      return this.attachBraceLimits(brace);
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
    if (SYM_MI[name]) return this.emitIdent(SYM_MI[name]!);
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

  private expandMacro(name: string, macro: MathMacro): string {
    if (this.macroDepth >= MAX_MACRO_EXPANSION_DEPTH) {
      return `<mtext>\\${name}</mtext>`;
    }
    const args: string[] = [];
    let mandatory = macro.nargs;
    if (macro.optionalDefault !== undefined && mandatory > 0) {
      if (this.s[this.i] === "[") {
        this.i++;
        let raw = "";
        while (this.i < this.s.length && this.s[this.i] !== "]") raw += this.s[this.i++];
        if (this.s[this.i] === "]") this.i++;
        args.push(raw);
      } else {
        args.push(macro.optionalDefault);
      }
      mandatory -= 1;
    }
    for (let n = 0; n < mandatory; n++) {
      this.skipSpace();
      args.push(this.readGroupText());
    }
    let body = macro.body;
    for (let n = args.length; n >= 1; n--) {
      body = body.replaceAll(`#${n}`, args[n - 1]!);
    }
    // Macros often wrap math in `$…$` for `\framebox` / `\fcolorbox`.
    body = body.replace(/\$([^$]*)\$/g, "$1");
    return latexToMathML(body, this.macros, this.macroDepth + 1);
  }

  /** Limits on \overbrace/\underbrace sit above/below the brace (not msup/msub). */
  private attachBraceLimits(brace: string): string {
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
      break;
    }
    if (sub && sup) return `<munderover>${brace}${sub}${sup}</munderover>`;
    if (sub) return `<munder>${brace}${sub}</munder>`;
    if (sup) return `<mover>${brace}${sup}</mover>`;
    return brace;
  }

  /** Parse a `\sideset` left/right script group into MathML sub/sup (or `<none/>`). */
  private parseSideScripts(tex: string): { sub: string; sup: string } {
    const p = new Parser(tex);
    let sub = "<none/>";
    let sup = "<none/>";
    while (p.i < p.s.length) {
      p.skipSpace();
      if (p.i >= p.s.length) break;
      if (p.s[p.i] === "_") {
        p.i++;
        sub = p.parseGroupOrAtom() || "<none/>";
        continue;
      }
      if (p.s[p.i] === "^") {
        p.i++;
        sup = p.parseGroupOrAtom() || "<none/>";
        continue;
      }
      if (p.s[p.i] === "'") {
        p.i++;
        const primes = "<mo>′</mo>";
        sup = sup !== "<none/>" ? `<mrow>${sup}${primes}</mrow>` : primes;
        continue;
      }
      break;
    }
    return { sub, sup };
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
