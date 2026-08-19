import { assertStringIncludes } from "@std/assert";
import { formatBibliographyEntry, parseBibtex } from "../src/bib.ts";

Deno.test("parseBibtex + authoryear entry matches Abernethy2003 shape", () => {
  const raw = Deno.readTextFileSync(
    new URL("./fixtures/biblioExample.bib", import.meta.url),
  );
  const cit = parseBibtex(raw).find((c) => c.key === "Abernethy2003");
  if (!cit) throw new Error("Abernethy2003 missing");
  const html = formatBibliographyEntry(cit);
  assertStringIncludes(html, "Abernethy, Colin D. et al. (2003)");
  assertStringIncludes(html, "“A highly stable N-heterocyclic carbene");
  assertStringIncludes(html, "Cl—C(carbene)");
  assertStringIncludes(html, "<i>J. Am. Chem. Soc.</i>");
  assertStringIncludes(html, "125.5");
  assertStringIncludes(html, "pp. 1128–1129");
  assertStringIncludes(html, "doi: 10.1021/ja0276321");
});
