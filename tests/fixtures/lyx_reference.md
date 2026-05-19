LyX is a document processor that uses LaTeX as its backend typesetting engine.

# LyX reference for syntax, structural patterns, and specialized layouts

## 1. File Structure
LyX files are plain text with a `.lyx` extension.

```lyx
#LyX 2.5 created this file.
\lyxformat 643
\begin_document
\begin_header
... (Document settings, properties, and preamble)
\end_header
\begin_body
... (Actual content layouts and insets)
\end_body
\end_document
```

## 2. Document Header (`\begin_header`)
### Core Settings
- `\textclass`: The base LaTeX class (e.g., `article`, `report`, `beamer`).
- `\begin_preamble` / `\end_preamble`: custom raw LaTeX code.
- `\language`: Document language setting (e.g., `british`, `english`).
- `\use_package`: Toggles specific LaTeX packages (`amsmath`, `amssymb`, etc.).
- `\cite_engine`: Citation management system (`biblatex`, `basic`, `natbib`).

### Layout Properties
- `\secnumdepth` / `\tocdepth`: Control numbering and Table of Contents levels.
- `\paragraph_separation`: `indent` or `skip`.

## 3. Layouts (`\begin_layout`)
Layouts define the semantic role of a block.

### Standard & Meta-Data
| Layout | Purpose |
|:---|:---|
| `Standard` | Regular body text. |
| `Title`, `Subtitle` | Main document titles. |
| `Author`, `Affiliation` | Author names and institution links. |
| `Email`, `URL`, `Address` | Contact info (often in academic classes). |
| `Date` | Document date (supports custom preambles). |
| `Abstract`, `Keywords` | Paper summary and indexing terms. |
| `Thanks`, `Acknowledgments` | Footnoted or sectioned thanks. |

### Document Logic & Sections
- `Section`, `Subsection`, `Subsubsection`: Standard hierarchical headings.
- `Chapter`, `Part`: Higher-level headings (in `report` or `book`).
- `Appendix`: Marks the beginning of an appendix section.
- `Bibliography`: Environment for manual citation lists.

### Lists & Specialized Blocks
- `Itemize`, `Enumerate`, `Description`: List types.
- `LyX-Code`: Monospaced code blocks.
- `Verse`, `Quote`, `Quotation`: Formatted text blocks.
- `Mainline`, `Variation`, `BoardCentered`: Specialized layout for Chess/Games.
- `Frame`, `Block`, `AlertBlock`: Specific to Beamer (Presentations).

### Theorem Environments (Mathematical)
Common in classes like `AMS Article`:
- `Theorem`, `Lemma`, `Corollary`, `Proposition`, `Conjecture`.
- `Fact`, `Criterion`, `Axiom`, `Definition`, `Example`, `Condition`.
- `Problem`, `Remark`, `Notation`, `Summary`, `Case`, `Conclusion`, `Proof`.

## 4. Insets (`\begin_inset`)
Insets are nested elements that provide rich functionality.

### Command-Based (`CommandInset`)
Used for operations that map to high-level LaTeX commands.
- `label`: Marks a target for references (e.g., `sec:label`).
- `ref`: cross-reference to a label.
- `citation`: BibTeX/Biblatex citations (`citet`, `citep`).
- `toc`: Generates the Table of Contents.
- `bibtex`: Links a `.bib` file and sets the bibliography style.
- `href`: External URL links.
- `include`: Includes another file (LyX, TeX, or Graphic).
- `index_print`: Displays the generated index.

### Mathematics (`Formula`)
- **Inline**: `$ ... $` syntax.
- **Displayed**: `\begin{equation} ... \end{equation}` inside the inset.
- **Labels**: Managed via `\label{...}` inside the formula text.

### Layout Insets
- `Foot`: Creates a footnote (stores layouts inside).
- `Note`: Internal LyX comments (visible in editor, not in output).
- `ERT` (Evil Red Text): Injects raw LaTeX directly into the body.
- `Box`: Frames or styled containers.
- `VSpace` / `HSpace`: Control manual spacing.
- `Newline` / `Newpage`: Manual document breaks.
- `Tabular`: The core table structure.

### Graphics & Floats
- **Float figure / table**: Containers for floating content with captions.
- **Graphics**: 
  ```lyx
  \begin_inset Graphics
      filename relative/path/to/image.png
      scale 50
  \end_inset
  ```

### Typography & Marks
- `Quotes eld`/`erd`: Left/Right curly double quotes.
- `space ~`: Non-breaking space.
- `SpecialChar LyX`/`LaTeX`/`TeX`: Official logos.

## 5. Table Structure (`\begin_inset Tabular`)
Tables use a specific XML-like subset:
- `<lyxtabular>`: Root tag defining rows/columns.
- `<column>`: Alignment and width settings (e.g., `width="2cm"`).
- `<cell>`: Contains the `\begin_inset Text` which holds layouts.

## 6. Tracked Changes
LyX supports tracking changes (revisions) directly in the file.

### Header Configuration
To enable tracked changes, the header includes:
- `\tracking_changes true`: Toggles the change tracking feature.
- `\author <author_id> "<author_name>"`: Defines the author ID used in the changes (e.g., `\author 236438948 "author_name"`).

### Body Syntax
Changes in the document body are marked using specific commands followed by the author ID and a timestamp:
- `\change_deleted <author_id> <timestamp>`: Marks the beginning of deleted text.
- `\change_inserted <author_id> <timestamp>`: Marks the beginning of inserted text.
- `\change_unchanged`: Marks the end of the tracked change block and returns to normal text.

**Example:**
```lyx
\begin_layout Standard
I 
\change_deleted 236438948 1776668506
write
\change_inserted 236438948 1776668507
edit
\change_unchanged
 something with tracked changes.
\end_layout
```

# Additional resources
- Examples of lyx documents can be found in  [examples](./examples) folder.