# Domain recipes

## Cross-references

Find the exact label first — `name` is inset data:

```bash
lq read file.lyx "inset[CommandInset label]"
lq read file.lyx "inset[CommandInset label]:contains(sec:)"
```

Then insert a standard reference:

```bash
lq insert file.lyx "layout[Standard]:last" append --ref "sec:methods"
lq insert file.lyx "layout[Standard]:last" append --ref "fig:results" --ref-cmd pageref
```

Non-default parameters (`plural`, `caps`, `tuple`, …) need a `--raw-file` payload; read the LyX syntax reference before constructing it.

## Citations

Find keys with `lq bib` instead of dumping a bibliography file:

```bash
lq bib file.lyx --search "author topic"
```

Then insert a standard citation:

```bash
lq insert file.lyx "layout[Standard]:last" append --cite "Einstein1905"
lq insert file.lyx "layout[Standard]:last" append --cite "Einstein1905" --cite-cmd citep
```

Before/after text, multiple keys, or literal mode need a `--raw-file` payload.

## Lists

List items are repeated layout blocks, not literal LaTeX `\item` commands:

```lyx
\begin_layout Itemize
First bullet point.
\end_layout
\begin_layout Itemize
Second bullet point.
\end_layout
```

Use `Enumerate` for numbered items and `Description` for description items; wrap nested lists in `\begin_deeper` / `\end_deeper` in a raw payload.

## Inserting new content

- `split-after` splits a block's prose: a direct `text` selector is not a valid target; apply `:change(...)` or `:property(...)` to the containing block instead.
- `--text` requires `--layout`, except with `split-after` where bare `--text` inserts inline text.
- For prose that should carry a citation, insert the text and the citation inset in one pass with a `--raw-file` payload.
- For complex payloads, prefer two passes: create the skeleton first, then populate it. A complex footnote (citations, cross-refs, math) starts with `--footnote` and is then populated with `split-after` and other helpers.

## Tables

Ground-up drafting uses `--table` / `lq table`, not `--raw-file`. Look (lines, alignment, merge, booktabs) stays in LyX. Do not invent format flags.

**W0 — List.** `lq table file.lyx` is the full catalog; each row already has `data`. `lq table file.lyx 2` (or a selector / the catalog’s `at`) is a one-row slice of the same shape. Listing keeps every match; a mutation (`set`, `add-row`, `add-column`, `delete-row`, `delete-column`) needs exactly one table — several matches refuse, they do not bulk-edit. Catalog `n` is file order, including unnumbered and change-deleted tables — not “Table 2” on the page. `at` is a normal selector: host lyx-selection with `inset[Tabular]` appended (nth-match among that host’s tables when it has more than one). Use it with `lq table`, `lq read`, `insert`, `delete`, or a cell `lq set` (`"<at> inset[Text]:nth-match(m) layout[Plain Layout]"`). A note-hosted table starts `inset[Note Note]… layout[Plain Layout] inset[Tabular]`, not the body paragraph that holds the note. Surrounding prose is the host prefix (drop the `inset[Tabular]…` suffix) with `lq read`. That row’s `data` is what `set --data` expects. Do not use `lq read` on Tabular for numbers. Optional catalog `merges` lists each merged range from its top-left cell; the other cells of the merge are empty fields in `data`.

**W1 — First draft.** `lq insert file.lyx "layout[Standard]:last" after --table "Year,GDP\n2020,1.2\n2021,1.4"` — a new Standard with an empty-caption table float. Then caption/label.

**W2 — Caption and label.** Float: `set` `inset[Float table]:last inset[Caption Standard] layout[Plain Layout]`; `insert … append --label tab:results`. Longtable: the caption lives in a cell — `set` `"<at> inset[Caption Standard] layout[Plain Layout]"` (the person turns Caption on in LyX first; this does not add a caption row). `--ref` as in Cross-references. If a label already exists, `set` only. Find labels with `lq read file.lyx "inset[CommandInset label]"`.

**W3 — Blank grid, person dresses it, agent sets numbers.** `--table ",,\n,,"` (2×3 empty fields). Then `lq table file.lyx 2 set --data "…"`. `--table ""` is rejected. Round-trip: read → edit `data` → `set`. Formula cells stay; `data` is prose only.

**W4 — One cell.** `lq read … inset[Text] --count` then `lq set file.lyx "<at> inset[Text]:nth-match(7) layout[Plain Layout]" "…"`. Count physical cells, including empty fields of a merge. Do not send a 1×1 `--data` through `lq table set` for a single cell.

**W5 — Extra or fewer rows/columns** after look exists: `add-row` / `add-column` (optional `--data`); `delete-row` / `delete-column` (`--index` required). Replay the table (`at` / `inset[Tabular]`) to revert a tracked row or column; replay a cell layout to peel `--data` / cell `set` only.

**W6 — Recreate** only when no look is worth keeping (`delete` + `insert --table`).

**W7 — Look stays in LyX.** No flags for booktabs, alignment, merge, or rules. Do not hand-build `<cell topline=…>` via `--raw-file` unless asked.

**W8 — Pick with `n` or `at`**, not LyX’s Table N. A mutation needs one table; if a selector hits several, list and pick `n` (or paste that row’s `at`). Caption/label pick is a **selector** (`:contains(Results)` on the Float, or `"<at> inset[Caption Standard]"` for a longtable), not a third token. `at` already points at the table — do not re-derive `inset[Tabular]:nth-match(n)` from `n` (that `n` is file-wide; `at`’s nth-match is host-scoped). Create is `insert --table`.
