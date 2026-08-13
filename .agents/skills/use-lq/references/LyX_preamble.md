# LyX Preamble Syntax Reference

The **preamble** is the user's raw LaTeX code that LyX copies verbatim into the preamble of the exported document (between `\documentclass` and `\begin{document}`). In the `.lyx` file it is stored as an opaque block between `\begin_preamble` and `\end_preamble`.

All facts below are verified against LyX 2.5.1 source (`src/BufferParams.cpp`, `src/support/Lexer.cpp`, `src/tex2lyx/Preamble.cpp`) and real `.lyx` files.

## 1. Serialization shape

```
\begin_preamble
<raw LaTeX, one line per file line>
\end_preamble
```

The block is **opaque string data** — like the math source of a `Formula` or the body of an `ERT` inset (§2 of `LyX_inset.md`): LyX does *not* parse the interior while you edit the `.lyx` file. What sits between the markers is copied into the exported LaTeX preamble as-is. It is plain text, not CST properties and not layouts. Write it as a whole string; never try to interpret or restructure its interior.

Real example (`tests/fixtures/Graphics_and_Insets/XY-Pic.lyx`):

```
\begin_preamble
% DO NOT ALTER THIS PREAMBLE!!!
%
% This preamble is designed to ensure that the file prints
% out as advertised. ...
\usepackage[all]{xy}

% define new commands used in sec. 5.1
\newcommand{\xyR}[1]{
  \xydef@\xymatrixrowsep@{#1}}
...
\end_preamble
\options BCOR7.5mm
```

## 2. Position in the header

`BufferParams::writeFile()` writes these blocks in this exact order:

```
\textclass <quoted-layout-name>
\begin_metadata                 # Only if non-empty
  ...
\end_metadata
\begin_preamble                 # Only if LaTeX preamble non-empty
  ...
\end_preamble
\begin_preamble_html            # Only if HTML preamble non-empty
  ...
\end_preamble_html
\options <options-string>       # Only if non-empty
\use_default_options <bool>
...
```

Facts:

- The preamble block is **conditional**: it is written only when the preamble is non-empty (`!preamble.empty()`). Absence is normal and must be handled.
- It follows `\begin_metadata` / `\end_metadata` and precedes `\options`.
- The body is written **flush-left** with trailing newlines trimmed (`rtrim(preamble, "\n")`), so the content never ends with blank lines.

## 3. Reading rules (`Lexer::getLongString`)

`BufferParams::readPreamble()` reads the body with `lex.getLongString("\\end_preamble")`:

- Content runs until a line whose **trimmed** text equals `\end_preamble` — compared **case-insensitively**.
- Each line is preserved, a trailing `\n` appended; blank lines inside the body are preserved.
- **Prefix stripping**: the first line's leading whitespace becomes the block "prefix"; that exact prefix is stripped from the start of every later line that begins with it. Content LyX writes is flush-left, so in practice the prefix is empty.
- A missing `\end_preamble` is a parse error ("Long string not ended by ...").
- Round-trip asymmetry to respect: reading appends `\n` after the last line, writing strips **all** trailing `\n`. A body ending with blank lines before `\end_preamble` is normalized away on the next write.

## 4. Content: what goes in

Anything valid in a LaTeX preamble:

- `\usepackage[...]{...}` package loads
- `\newcommand`, `\renewcommand`, `\def`, `\let` macro definitions
- `\setlength`, `\addtolength`, … length/register tweaks
- `\PassOptionsToPackage{...}{...}`
- `%` comments

Do not confuse with related header properties:

| Header item | Meaning |
| ----------- | ------- |
| `\begin_preamble` | User raw LaTeX → goes into the exported preamble (before `\begin{document}`) |
| `\options` | Document-class options → goes into `\documentclass[...]`, **not** the preamble |
| `\begin_modules` | Loaded LyX modules; each contributes its own preamble snippet at export time, independently of the user preamble |
| `\begin_metadata` | `\DocumentMetadata` for the PDF (LaTeX 2022+), written before `\documentclass` |

## 5. In the exported LaTeX

In `BufferParams::writeLaTeX()`, the user preamble is emitted near the end of the exported preamble, under the comment:

```
% User specified LaTeX commands.
```

The whole trailing group — LyX-specific macros, textclass-specific preamble, the user preamble, and footmisc/subfig/bullet definitions — is wrapped in `\makeatletter` … `\makeatother`. It lands after the "system" preamble (`\documentclass`, fonts, fontenc, encoding, geometry, hyperref, line spacing) and before theorem definitions and the babel call.

A preamble containing only whitespace is **skipped** in the export (`containsOnly(preamble, " \n\t")`).

## 6. HTML preamble

```
\begin_preamble_html
<raw HTML/CSS for the exported HTML head>
\end_preamble_html
```

Same block shape, same opaque treatment, same reading rules — but the content lands in the `<head>` of the exported HTML under the comment `<!-- User specified HTML <head> commands -->` instead of the LaTeX preamble. Written only when non-empty, immediately after the LaTeX preamble block.

## 7. From tex2lyx (.tex → .lyx)

When converting LaTeX, tex2lyx recognizes known package loads and class options and maps them to LyX settings; the **leftover** raw preamble is written verbatim into `\begin_preamble` (with auto-loadable package snippets substituted away). So a preamble produced by `tex2lyx` is precisely the part it could not interpret.

## 8. In lq's CST

The preamble is a single opaque block node nested inside the header:

```
document
└─ header
   └─ preamble block (tag = "preamble", isBeginVariant = true)
      ├─ text node  (one per line)
      ├─ text node
      └─ ...
```

- children are `text` nodes, one per line
- serialization re-emits `\begin_preamble`, the text lines, `\end_preamble`

`preamble_html` is a separate block node with `tag = "preamble_html"`, nested the same way.

Editing rules:

- Treat the interior as opaque — replace whole lines, never restructure them.
- Don't leave a trailing blank line before `\end_preamble`: LyX trims trailing `\n` on write, so it would be lost (lossy round-trip).
- Keep the body flush-left: an indented first line becomes LyX's prefix-strip pattern for all following lines on the next read (lossy round-trip).
