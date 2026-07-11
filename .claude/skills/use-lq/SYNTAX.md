# LyX Syntax Reference

Reference for raw LyX inset syntax. Loaded when constructing `--raw-file` payloads or understanding inset structure. See `SKILL.md` for the workflow that drives when to reach for this.

## Citation Inset (`CommandInset citation`)

```
\begin_inset CommandInset citation
LatexCommand citet
key "Einstein1905"
literal "false"
after ""
before ""
\end_inset
```

| Param            | Default        | Notes                                      |
| ---------------- | -------------- | ------------------------------------------ |
| `key`          | *(required)* | BibTeX citation key                        |
| `literal`      | `"false"`    | `"true"` bypasses cite engine formatting |
| `after`        | `""`         | Text after citation, e.g.`"p. 42"`       |
| `before`       | `""`         | Text before citation, e.g.`"see "`       |
| `pretextlist`  | `""`         | Multi-citation preamble                    |
| `posttextlist` | `""`         | Multi-citation postamble                   |

Omit params that use the default — LyX only writes non-default values.

## Cross-Reference Inset (`CommandInset ref`)

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

| Param         | Default        | Notes                                    |
| ------------- | -------------- | ---------------------------------------- |
| `reference` | *(required)* | Label name                               |
| `plural`    | `"false"`    | "Section" → "Sections"                  |
| `caps`      | `"false"`    | Capitalize prefix                        |
| `noprefix`  | `"false"`    | Hide "Section"/"Figure" prefix           |
| `nolink`    | `"false"`    | No hyperlink                             |
| `tuple`     | `"list"`     | `"list"` or `"range"` for multi-refs |

The `plural`/`caps`/`noprefix`/`nolink`/`tuple` params are LyX-internal — they affect GUI display, not LaTeX output.

## Note Insets

The `Note` inset family has three subtypes. All use `\begin_inset Note <subtype>`:

| Syntax                          | LyX UI Name          | Output                                                         |
| ------------------------------- | -------------------- | -------------------------------------------------------------- |
| `\begin_inset Note Note`      | **LyX Note**   | Internal notes that will not appear in LaTex or PDF output     |
| `\begin_inset Note Comment`   | **Comment**    | Internal notes that will appear in LaTex but not in PDF output |
| `\begin_inset Note Greyedout` | **Greyed Out** | This note will appear in the output as text in a color         |

Skip these notes when reading the LyX document. Add new notes to store metadata or comments; never edit existing ones.

## More Examples

Use official templates at `path/to/lyx/templates/**/*.lyx` and official help files at `path/to/lyx/Resources/doc/*.lyx` to understand more about LyX syntax.
