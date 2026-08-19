# Live M1 parity floor and exclusions

This corpus is the M1 supported reader-visible floor (dev log 129). Expected
projections are asserted by `tests/preview_test.ts` after `normalizeReaderHtml`.
Do not commit generated `.xhtml` artifacts.

## Supported (compared)

| Fixture | Constructs | Math mode |
|---|---|---|
| `headings_paragraphs.lyx` | Section/Subsection, Standard, empty paragraph, Unicode, astral | `html_math_output 3` (LaTeX) |
| `front_matter_math.lyx` | Title, Author + title footnote, grouped Abstract, display/inline math | LaTeX |
| `lists_quotes.lyx` | Itemize, nested Itemize, Enumerate, Description, Quote | LaTeX |
| `table_figure_foot_math.lyx` | Tabular, Float figure + `live-figure.png`, Foot, Formula | LaTeX |
| `hostile.lyx` | Source strings that must stay escaped in HTML | LaTeX |
| `tracked_ert_notes.lyx` | Inserted text as current; deleted/ERT/private notes omitted | LaTeX |

Line-ending and parse-failure cases are generated in tests (temp files), not
committed as fixtures.

## Exclusions (not a failed Live feature)

- Deleted tracked-change text — native XHTML skips it; Live matches.
- ERT — `InsetERT::xhtml()` is empty; Live omits with `ERT_OMITTED`.
- Private `Note` / `Comment` — absent from the clean XHTML body; Live omits.
- Header, preamble, modules, branches, index, command-inset bookkeeping (labels).
- Generated `magicparlabel-*` ids and incidental CSS classes — comparator drops them.
- Native XHTML `<head>`, user `\html_preamble`, layout CSS — never compared or shipped.
- MathML / image math — M1 fixtures declare LaTeX math output; Live emits escaped source.
- Review badges, source tokens, selection references, outline, edit targets.

Unknown insets are an escaped fallback plus a diagnostic, not silent support.
