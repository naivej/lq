# Domain recipes

## Cross-references

Find the exact label first — labels are text inside `CommandInset label` blocks:

```bash
lq read file.lyx "inset[CommandInset label]" --text-only
lq read file.lyx "inset[CommandInset label]:contains(sec:)" --text-only
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
