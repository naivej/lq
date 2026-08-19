/**
 * Small TeX-to-MathML converter for Live formula insets.
 * Covers the LyX subset: greek, scripts, sums, delimiters, fractions, primes.
 * Unknown commands fall back to mtext so source never becomes executable HTML.
 */
function escapeLiveHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const GREEK: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  ell: "ℓ",
  infty: "∞",
  cdot: "⋅",
  ldots: "…",
  dots: "…",
  cdots: "⋯",
  times: "×",
  pm: "±",
  mp: "∓",
  leq: "≤",
  geq: "≥",
  neq: "≠",
  in: "∈",
  subset: "⊂",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  partial: "∂",
};

const LARGEOP = new Set(["sum", "prod", "int", "oint"]);
const LARGEOP_CHAR: Record<string, string> = {
  sum: "∑",
  prod: "∏",
  int: "∫",
  oint: "∮",
};

const ENV = /\\begin\{(equation\*?|align\*?|displaymath|multline\*?|gather\*?|eqnarray\*?)\}([\s\S]*)\\end\{\1\}/;

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

export function renderFormulaHtml(source: string, equationNo?: number): string {
  const { display, body } = unwrapLatexSource(source);
  const inner = latexToMathML(body);
  const displayAttr = display ? ' display="block"' : "";
  const math =
    `<math xmlns="http://www.w3.org/1998/Math/MathML"${displayAttr}><semantics>${inner}<annotation encoding="application/x-tex">${escapeLiveHtml(body)}</annotation></semantics></math>`;
  const eqno = equationNo !== undefined ? `<span class="eqno">(${equationNo})</span>` : "";
  return `<span class="formula">${math}${eqno}</span>`;
}

export function latexToMathML(source: string): string {
  const p = new Parser(source);
  const body = p.parseExpr();
  return body || `<mtext>${escapeLiveHtml(source)}</mtext>`;
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
    if (name === "frac") {
      const a = this.parseGroupOrAtom();
      const b = this.parseGroupOrAtom();
      return `<mfrac>${a}${b}</mfrac>`;
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
    if (name === "text" || name === "mathrm" || name === "textrm" || name === "operatorname") {
      const inner = this.readGroupText();
      return `<mtext>${escapeLiveHtml(inner)}</mtext>`;
    }
    if (name === "label") {
      this.readGroupText();
      return "";
    }
    if (name === "begin" || name === "end") {
      this.readGroupText();
      return "";
    }
    if (LARGEOP.has(name)) {
      return `<mo largeop="true">${LARGEOP_CHAR[name]}</mo>`;
    }
    if (GREEK[name]) {
      const ch = GREEK[name];
      if (ch.length === 1 && /[⋅…⋯×±∓≤≥≠∈⊂→←∂∞]/.test(ch)) return `<mo>${ch}</mo>`;
      return `<mi>${ch}</mi>`;
    }
    // Unknown command: skip one optional group and show the name.
    if (this.s[this.i] === "{") this.readGroupText();
    return `<mi>${escapeLiveHtml("\\" + name)}</mi>`;
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

  private skipSpace(): void {
    while (this.i < this.s.length && /[ \t]/.test(this.s[this.i])) this.i++;
  }
}
