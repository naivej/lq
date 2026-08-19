export interface Citation {
  key: string;
  type?: string;
  title?: string;
  author?: string;
  year?: string;
  journal?: string;
  volume?: string;
  number?: string;
  pages?: string;
  doi?: string;
  publisher?: string;
  booktitle?: string;
}

function extractBraced(body: string, start: number): { value: string; end: number } | null {
  if (body[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) return { value: body.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

function extractField(body: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*`, "i");
  const m = re.exec(body);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  while (i < body.length && /\s/.test(body[i])) i++;
  if (body[i] === "{") {
    const braced = extractBraced(body, i);
    return braced?.value;
  }
  if (body[i] === '"') {
    const end = body.indexOf('"', i + 1);
    if (end === -1) return undefined;
    return body.slice(i + 1, end);
  }
  const rest = body.slice(i).match(/^([^\s,}]+)/);
  return rest?.[1];
}

export function cleanBibText(raw: string): string {
  let s = raw.replace(/\s+/g, " ");
  s = s.replace(/\\textsc\{([^}]*)\}/gi, "$1");
  s = s.replace(/\\emph\{([^}]*)\}/gi, "$1");
  s = s.replace(/\\LaTeXe\{\}?/g, "LaTeX2ε");
  s = s.replace(/\\LaTeX\{\}?/g, "LaTeX");
  s = s.replace(/\\TeX\{\}?/g, "TeX");
  s = s.replace(/\\LyX\{\}?/g, "LyX");
  s = s.replace(/---/g, "—");
  s = s.replace(/--/g, "–");
  s = s.replace(/~/g, " ");
  s = s.replace(/[{}]/g, "");
  return s.trim();
}

function parsePerson(part: string): { first: string; last: string } {
  const t = part.trim();
  if (t.includes(",")) {
    const comma = t.indexOf(",");
    return { last: t.slice(0, comma).trim(), first: t.slice(comma + 1).trim() };
  }
  const bits = t.split(/\s+/);
  return { last: bits[bits.length - 1] ?? t, first: bits.slice(0, -1).join(" ") };
}

/** Authoryear-ish author list: first as Last, First; 3+ authors become et al. */
export function formatBibAuthors(author: string | undefined): string {
  if (!author) return "Unknown";
  const people = author.split(/\s+and\s+/i).map(parsePerson).filter((p) => p.last);
  if (people.length === 0) return "Unknown";
  const one = (p: { first: string; last: string }) => p.first ? `${p.last}, ${p.first}` : p.last;
  if (people.length === 1) return one(people[0]);
  if (people.length === 2) return `${one(people[0])} and ${one(people[1])}`;
  return `${one(people[0])} et al.`;
}

function escapeBibHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Reader-facing bibliography line (biblatex authoryear-ish). Returns HTML. */
export function formatBibliographyEntry(c: Citation): string {
  const bits: string[] = [escapeBibHtml(formatBibAuthors(c.author))];
  if (c.year) bits.push(` (${escapeBibHtml(c.year)})`);
  if (c.title) bits.push(`. “${escapeBibHtml(cleanBibText(c.title))}”`);
  if (c.journal) bits.push(`. In: <i>${escapeBibHtml(cleanBibText(c.journal))}</i>`);
  else if (c.booktitle) bits.push(`. In: <i>${escapeBibHtml(cleanBibText(c.booktitle))}</i>`);
  else if (c.publisher) bits.push(`. ${escapeBibHtml(cleanBibText(c.publisher))}`);
  if (c.volume) {
    bits.push(` ${escapeBibHtml(c.volume)}`);
    if (c.number) bits.push(`.${escapeBibHtml(c.number)}`);
  }
  if (c.pages) bits.push(`, pp. ${escapeBibHtml(c.pages.replace(/-+/g, "–"))}`);
  if (c.doi) bits.push(`. doi: ${escapeBibHtml(c.doi)}`);
  bits.push(".");
  return bits.join("");
}

export function parseBibtex(content: string): Citation[] {
  const citations: Citation[] = [];
  const entryRegex = /@([a-zA-Z]+)\s*\{\s*([^,]+),([\s\S]*?)\n\}/g;

  let match;
  while ((match = entryRegex.exec(content)) !== null) {
    const type = match[1].toLowerCase();
    const key = match[2].trim();
    const body = match[3];
    const field = (name: string) => {
      const raw = extractField(body, name);
      return raw === undefined ? undefined : cleanBibText(raw);
    };
    const cit: Citation = { key, type };
    cit.title = field("title");
    cit.author = field("author");
    cit.year = field("year")?.match(/\d{4}/)?.[0];
    cit.journal = field("journal") ?? field("journaltitle");
    cit.volume = field("volume");
    cit.number = field("number");
    cit.pages = field("pages");
    cit.doi = field("doi");
    cit.publisher = field("publisher");
    cit.booktitle = field("booktitle");
    citations.push(cit);
  }

  return citations;
}
