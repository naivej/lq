# LyX Inset Syntax Reference

An inset is `\begin_inset <type> ... \end_inset`. What sits between the two markers is the **metadata** that controls how the inset behaves and how it is exported. This reference covers the metadata of the insets you will meet most often, grouped by how they serialize.

The LyX writer is more authoritative than a permissive reader: a lossless round trip should satisfy `serialize(parse(file_text)) === file_text`. Some conventions are cosmetic, but structural markers, inset status lines, header entries, and change regions must stay valid for LyX to open the file. Use `lq dump` on a LyX-generated fixture when the CST shape is uncertain; what looks like markup inside an ERT inset may be literal text.

All facts below are verified against LyX 2.5.1 source (`src/insets/*`) and real `.lyx` files. The preamble serialization lives in [`LyX_preamble.md`](LyX_preamble.md).

## 1. Serialization families

Every inset falls into one of four shapes:

| Family | Shape | Examples |
| ------ | ----- | -------- |
| **CommandInset** — key-value metadata | `CommandInset <type>` then one `param "value"` per line | `citation`, `ref`, `label`, `href`, `index`, `bibtex`, `bibitem`, `include`, `counter` |
| **Collapsible content** — header + `status` + paragraphs | `<Type> [subtype]` then `status open|collapsed` then a body of layouts | `Note`, `Branch`, `Phantom`, `ERT`, `Flex`, `Nomenclature`, `Argument` |
| **Opaque string** — header + raw LaTeX | `Formula <math-source>`, content may run to following lines | `Formula` |
| **Specialized param block** — inset-specific keyword lines | `Graphics`, `Float`, `Box`, `Tabular` | |

## 2. Inset data: opaque strings vs. structured metadata

Everything between `\begin_inset` and `\end_inset` is inset **data**, and it comes in two kinds. Knowing which is which tells you what you can safely rewrite by hand:

- **Opaque string data** — raw LaTeX that LyX does *not* parse while you edit the `.lyx` file:
  - the math source of a `Formula` inset, e.g. `Formula $x^2 + y^2 = z^2$`;
  - the raw LaTeX body of an `ERT` inset.
  They are plain text, not CST properties and not layouts. Write them as whole strings; never try to interpret or restructure their interior.

- **Structured document data** — everything else, which has meaning for round-trip fidelity:
  - `CommandInset` parameters: `LatexCommand`, `key`, `reference`, `name`, `target`, `filename`, …
  - structural lines: a tabular's `<features>`/`<column>`/`<cell>` metadata, Float's `placement`/`wide`/`sideways`, Branch's `inverted`, Box's `position`/`width`/…
  - layout structure inside collapsible insets: `status`, `\begin_layout`/`\end_layout`.

See §6 for the concrete `Formula` syntax.

## 3. Shared serialization rules

**CommandInset params:**
- Written as `name "value"`, one per line. Values are always double-quoted (`Lexer::quoteString`), so quotes inside the value are escaped.
- **Every non-empty param is written — including defaults.** A fresh citation writes `literal "false"` even though `false` is the default. Only *empty* params are omitted (e.g. `after` and `before` are dropped when empty).
- `preview true` appears only when preview is enabled (the param is absent otherwise).
- File params are stored **relative to the `.lyx` file** (`filename`, each entry of `bibfiles`, and `options` for `bibtex` as a `.bst` path). LyX rewrites them when the document moves.
- `LatexCommand` selects the concrete LaTeX command the inset maps to; it is always the first line after `CommandInset`.

**Collapsible content insets:**
- The `status open|collapsed` line always follows the header (before any content).
- Insets that hold paragraphs delegate to `InsetText::write()`, which writes a `Text` line followed by the layouts — but most collapsibles write the layouts directly.

**Terminator:** the double blank line after `\end_inset` is intentional in LyX output.

## 4. CommandInset family (key-value metadata)

### Shape

```
\begin_inset CommandInset <type>
LatexCommand <cmd>
preview true              # only if preview is enabled
<param> "<value>"         # one per non-empty param
\end_inset
```

### Master table

| Inset type | `LatexCommand` (typical) | Key params |
| ---------- | ------------------------ | ---------- |
| `citation` | `citet`, `citep`, `cite`, `citeauthor`, `citeyear`, `nocite`, … | `key`, `after`, `before`, `pretextlist`, `posttextlist`, `literal` |
| `ref` | `ref`, `pageref`, `vref`, `vpageref`, `eqref`, `nameref`, … | `reference`, `plural`, `caps`, `noprefix`, `nolink`, `tuple`, `options` |
| `label` | `label` | `name` |
| `href` | `href` | `target`, `name`, `type`, `literal` |
| `index` | `index` | `name`, `type`, `literal` |
| `index_print` | `printindex`, `printsubindex` | `type`, `name` |
| `nomencl_print` | `printnomenclature` | `set_width`, `width` |
| `bibtex` | `bibtex`, `addbibresource` | `bibfiles`, `options`, `btprint`, `biblatexopts`, `encoding` |
| `bibitem` | `bibitem` | `key`, `label`, `literal` |
| `include` | `include`, `input`, `verbatiminput`, `verbatiminput*` | `filename`, `lstparams`, `literal` |
| `counter` | `counter` | `counter`, `value`, `lyxonly` |

### Citation Inset

```
\begin_inset CommandInset citation
LatexCommand citet
key "Einstein1905"
literal "false"
\end_inset
```

| Param | Notes |
| ----- | ----- |
| `key` | *(required)* BibTeX citation key; comma-separated for multi-citations |
| `literal` | `"true"` bypasses cite-engine formatting (raw LaTeX output) |
| `after` | Text after the citation, e.g. `"p. 42"` |
| `before` | Text before the citation, e.g. `"see "` |
| `pretextlist` | Preamble text for multi-citations |
| `posttextlist` | Postamble text for multi-citations |

`key` and `literal` are always present; `after`/`before`/`pretextlist`/`posttextlist` appear only when non-empty.

### Cross-Reference Inset

```
\begin_inset CommandInset ref
LatexCommand ref
reference "sec:Section_label"
plural "false"
caps "false"
noprefix "false"
nolink "false"
tuple "list"
\end_inset
```

| Param | Notes |
| ----- | ----- |
| `reference` | *(required)* Target label name |
| `options` | Extra LaTeX options, e.g. varioref's name handling |
| `plural` | `"true"` → "Sections" instead of "Section" |
| `caps` | Capitalize the prefix ("Section" → "SECTION") |
| `noprefix` | Hide the "Section"/"Figure" prefix entirely |
| `nolink` | Render as plain text, no hyperlink |
| `tuple` | `"list"` or `"range"` for multi-reference formatting |

The `plural`/`caps`/`noprefix`/`nolink`/`tuple` params are LyX-internal: they affect GUI display, not LaTeX output. LyX writes them all on a default ref (they are non-empty).

### Hyperlink Inset

```
\begin_inset CommandInset href
LatexCommand href
name "LyX Homepage"        # optional display text
target "https://www.lyx.org"
type "web"                 # "" (web), "mailto:", "file:", "other", ...
literal "false"
\end_inset
```

| Param | Notes |
| ----- | ----- |
| `target` | *(required)* URL, email, or file path |
| `name` | Optional display text; if omitted the target is shown |
| `type` | `""`/`"web"` (URL), `"mailto:"`, `"file:"`, or `"other"`; `file:` targets are path-adjusted on write |
| `literal` | `"true"` bypasses hyperref escaping |

### Label, Index, and other simple command insets

```
\begin_inset CommandInset label
LatexCommand label
name "sec:Section_label"
\end_inset

\begin_inset CommandInset index
LatexCommand index
name "keyword"
type "idx"                 # optional sub-index type
literal "false"
\end_inset
```

- `label` carries a single param, `name` — the label every `ref` points at.
- `index` (`LatexCommand index`) has `name` (the indexed term) and `type` (the sub-index, e.g. `idx`); `index_print` (`printindex`/`printsubindex`) is the *print* inset and takes `type` + `name` (the index title).

### Bibliography insets

```
\begin_inset CommandInset bibtex
LatexCommand bibtex
bibfiles "refs,other"
options "plain"
btprint "btPrintSorted"    # optional
\end_inset

\begin_inset CommandInset bibitem
LatexCommand bibitem
key "Einstein1905"
label "1"                  # optional custom label
literal "false"
\end_inset
```

- `bibtex` generates the bibliography from `.bib` files: `bibfiles` is comma-separated (each path relative to the `.lyx` file), `options` is the `.bst` style (path-adjusted), `btprint`/`biblatexopts` control the bibliography style under biblatex.
- `bibitem` is a manual bibliography entry: `key` is the citation key, `label` an optional custom display label.

### Include Inset

```
\begin_inset CommandInset include
LatexCommand include
filename "chapter1.tex"    # relative to the .lyx file
literal "false"
\end_inset
```

| Param | Notes |
| ----- | ----- |
| `filename` | *(required)* Included file; path-adjusted relative to the `.lyx` file |
| `lstparams` | Key=value list for `LatexCommand lstlisting` mode |
| `literal` | `"true"` for verbatim raw inclusion |

`LatexCommand` selects the mode: `include`/`input` (LaTeX), `verbatiminput`/`verbatiminput*` (raw text), or `lstlisting` (syntax-highlighted listing, uses `lstparams`).

### Counter Inset

```
\begin_inset CommandInset counter
LatexCommand counter
counter "equation"
value "5"
lyxonly "true"
\end_inset
```

`counter` names the counter to alter, `value` sets it, `lyxonly` changes only LyX's internal value without emitting LaTeX. All three are LyX-internal.

## 5. Collapsible content insets (`status` + body)

### Shape

```
\begin_inset <Type> [<subtype>]
status open|collapsed

\begin_layout <Layout>
...body...
\end_layout

\end_inset
```

| Inset | Header line | Notes |
| ----- | ----------- | ----- |
| `Note` | `Note Note` / `Note Comment` / `Note Greyedout` | `Note` = invisible, `Comment` = exported as comment, `Greyedout` = grayed text |
| `Branch` | `Branch <name>` then `inverted 0\|1` | Content included only when the branch is active; `inverted 1` negates |
| `Phantom` | `Phantom Phantom` / `Phantom HPhantom` / `Phantom VPhantom` | Invisible (but occupying) text variants |
| `ERT` | `ERT` | Raw LaTeX — opaque string data, no metadata |
| `Flex` | `Flex <style>` | Custom inset from a layout/style |
| `Nomenclature` | `Nomenclature` | Symbol in `Plain Layout`, description in `Description` |
| `Argument` | `Argument <name>` | Optional argument slot, e.g. `Argument post:1` |

### Note

```
\begin_inset Note Comment
status open

\begin_layout Plain Layout
Reviewer comment
\end_layout

\end_inset
```

The subtype token right after `Note` selects the note flavor — it is the only metadata.

### Branch

```
\begin_inset Branch OutDated
inverted 0
status collapsed

\begin_layout Standard
...
\end_layout

\end_inset
```

The branch name is written raw on the line after `Branch` (it may contain spaces — the parser reads it as a whole line, not a quoted token). `inverted 0|1` follows it; `1` inverts membership (content shown when the branch is *off*).

### ERT

```
\begin_inset ERT
status collapsed

\begin_layout Plain Layout
\usepackage{foo}
\end_layout

\end_inset
```

ERT has no metadata at all — the body *is* raw LaTeX, and like `Formula` it is **opaque string data** (see §2): LyX does not parse it while you edit the file. Structurally it still has the `status` line and a `Plain Layout`, but the layout's content is raw LaTeX, not LyX text.

### Nomenclature entry

```
\begin_inset Nomenclature
status open

\begin_layout Plain Layout
<symbol>
\end_layout

\begin_layout Description
<description>
\end_layout

\end_inset
```

The symbol is the first layout's text; the description lives in the `Description` layout. The *print* counterpart is the CommandInset `nomencl_print` (see §4).

### Argument

```
\begin_inset Argument post:1
status open

\begin_layout Plain Layout
Optional argument text
\end_layout

\end_inset
```

`Argument <name>` marks a slot for an optional/positional argument of a surrounding command or custom layout. Common names: `1`, `2`, …, `item:1`, `post:1`, `note:1`, `caption`, `short`. The name is metadata — it decides where the content lands in the generated LaTeX.

## 6. Specialized param insets

### Graphics

```
\begin_inset Graphics
	filename plots/figure.pdf   # relative to the .lyx file
	width 8cm                   # or lyxscale, scale, height, ...
	keepAspectRatio

\end_inset
```

Graphics uses **tab-indented `key value` lines without quotes** — unlike CommandInset. Only non-default values are written. The `filename` is relative to the `.lyx` file.

| Param | Notes |
| ----- | ----- |
| `filename` | *(required)* Image file, path-adjusted |
| `lyxscale` | Integer percent scale on screen only |
| `scale` | Output scale percent (mutually exclusive with `width`/`height`) |
| `width` / `height` | Output size as a `Length`, e.g. `8cm`, `50col%`, `0.5\textwidth`; setting one clears `scale` |
| `keepAspectRatio` | Flag (bare keyword, no value) |
| `draft` | Flag; placeholder box only |
| `rotateAngle`, `rotateOrigin` | Rotation |
| `BoundingBox` | Four lengths: `xl yb xr yt` |
| `clip` | Flag; clip to bounding box |
| `special` | Raw LaTeX options |
| `groupId` | Groups images for shareable graphics (e.g. matlab2tikz) |
| `display` | `false` → inline instead of float |
| `darkModeSensitive` | Flag |

### Float

```
\begin_inset Float figure
placement document
alignment document
wide false
sideways false
status open

\begin_layout Plain Layout
...float content + \begin_inset Caption ...
\end_layout

\end_inset
```

`Float <type>` takes the float class (`figure`, `table`, `algorithm`, …). Metadata lines:
- `placement` — `document` (class default) or an explicit string like `htbp`
- `alignment` — `document`, `left`, `center`, `right`
- `wide` — `true` spans both columns in two-column documents
- `sideways` — `true` rotates the float

Then the usual `status` and body. Subfloats and the `FloatList <type>` (list of floats) inset follow the same header pattern.

### Box

```
\begin_inset Box Boxed
position "t"
hor_pos "c"
has_inner_box 1
inner_pos "t"
use_parbox 0
use_makebox 0
width "100col%"
special "none"
height "1in"
height_special "totalheight"
thickness "0.4pt"
separation "3pt"
shadowsize "4pt"
framecolor "black"
backgroundcolor "none"
status open

\begin_layout Plain Layout
...
\end_layout

\end_inset
```

`Box <type>` selects the box style (`Boxed`, `Frameless`, `Framed`, `ovalbox`, `shadowbox`, `doublebox`, `makebox`). All params are always written (with quotes). `position`/`hor_pos`/`inner_pos` are single letters (`t`, `c`, `b`, `l`, `r`, `s`), `width`/`height`/`thickness`/`separation`/`shadowsize` are `Length`s, `special` is `none` or a raw LaTeX keyword, `framecolor`/`backgroundcolor` are LyX color names, `height_special` is `totalheight` or `height`.

### Tabular

```
\begin_inset Tabular
<row/column metadata block>
...
\end_inset
```

Tabulars carry their own verbose metadata block (column alignments, widths, borders, multicolumns, rotated cells, …) with tab-indented `key value` lines. It is large and mechanical — treat it as opaque: when editing a table by hand, preserve the block byte-for-byte and change only cell text.

### Formula

```
\begin_inset Formula $x^2 + y^2 = z^2$      # inline math
\end_inset

\begin_inset Formula \[ \sum_{i=0}^n i = \frac{n(n+1)}{2} \]   # display math
\end_inset
```

`Formula` is the one inset whose data is a raw LaTeX math string — **opaque string data** (see §2). There are no params, no `status`, no layouts. The math source starts right after `Formula ` and runs to `\end_inset`; it may span several lines, in which case `\end_inset` sits alone on its own line. Treat the whole string as one unit — LyX parses it only with its math engine when the document is opened.

## 7. More examples

Use official templates at `path/to/lyx/templates/**/*.lyx` and official help files at `path/to/lyx/Resources/doc/*.lyx` to understand more about LyX syntax.
