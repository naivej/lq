//! Built-in help catalog (Deno `help.ts`).

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PageGroup {
    Commands,
    Model,
    Concepts,
}

impl PageGroup {
    pub fn as_str(self) -> &'static str {
        match self {
            PageGroup::Commands => "commands",
            PageGroup::Model => "model",
            PageGroup::Concepts => "concepts",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct HelpSection {
    pub heading: &'static str,
    pub body: &'static str,
}

#[derive(Clone, Copy, Debug)]
pub struct FurtherReading {
    pub page: &'static str,
    pub hint: &'static str,
}

#[derive(Clone, Copy, Debug)]
pub struct HelpPage {
    pub id: &'static str,
    pub title: &'static str,
    pub sections: &'static [HelpSection],
    pub further_reading: &'static [FurtherReading],
}

pub fn reach_of(id: &str) -> &str {
    id.rsplit_once('/').map(|(_, r)| r).unwrap_or(id)
}

pub fn group_of(id: &str) -> Option<PageGroup> {
    if id == "home" {
        return None;
    }
    let prefix = id.split_once('/').map(|(g, _)| g)?;
    match prefix {
        "commands" => Some(PageGroup::Commands),
        "model" => Some(PageGroup::Model),
        "concepts" => Some(PageGroup::Concepts),
        _ => None,
    }
}

pub fn alias_of(id: &str) -> Option<&str> {
    if group_of(id) == Some(PageGroup::Commands) {
        Some(reach_of(id))
    } else {
        None
    }
}

pub static HELP_PAGES: &[HelpPage] = &[
    HelpPage {
        id: "home",
        title: "built-in help home and page map",
        sections: &[
            HelpSection {
                heading: "",
                body: r#"lq is a standalone CLI for parsing, querying, and mutating LyX documents (`.lyx` files):

1. Parse: reads a `.lyx` file into a Concrete Syntax Tree (CST).
2. Query: queries the CST with a CSS-like selector engine to find specific nodes.
3. Mutate: applies `set`, `delete`, `insert`, or `undo` to the matched nodes.
4. Serialize: converts the modified CST back into a `.lyx` file with lossless fidelity."#,
            },
            HelpSection {
                heading: "Help commands",
                body: r#"- `lq help` - this page; it is also the page map below.
- `lq help <page>` - open one help page, such as `lq help cst` or `lq help read`.
- `lq <command> --help` - command-specific help alias for the corresponding command page.
- `lq help --rich=auto|always|never` - control ANSI styling; the default is `auto`.
- Flags are typed: a boolean flag takes no value; unknown flags and extra arguments are errors."#,
            },
        ],
        further_reading: &[],
    },
    HelpPage {
        id: "model/guarantees",
        title: "the design guarantees behind lq",
        sections: &[
            HelpSection {
                heading: "Concrete fidelity",
                body: r#"`lq` is built on a "Lossless DOM" architecture. It parses `.lyx` files into a Concrete Syntax Tree (CST) rather than discarding source boundaries in an abstract model. For supported input, `serialize(parse(text))` is lossless after the current platform's line endings are normalized to LF. Text-node boundaries, inline properties, change markers, insets, and header structure are therefore meaningful data. Perfectly valid but idiosyncratic LyX formatting (such as trailing whitespace in specific tags or exact newline placement) is preserved exactly for the content `lq` parses.

An intentional mutation may reserialize the file, and LyX may later normalize cosmetic conventions that `lq` does not enforce — the 500-char column limit, punctuation newlines, font/change delta optimization. On Windows, LyX writes CRLF, while `lq` always serializes with LF line endings. Those are purely cosmetic: LyX reads the file without issue, and the result is a formatting-only diff, not structural corruption."#,
            },
            HelpSection {
                heading: "LyX format authority and lq policy",
                body: r#"The LyX writer and reader are authoritative for what a valid `.lyx` file can store: flat change regions, header shape, inset placement, and serialization constraints.

`lq` follows official LyX as closely as possible. A deviation is justified only when it is a better design in `lq`'s CLI context than in the LyX GUI — such as selector scoping, rejected tracked text visibility, JSON responses, and explicit refresh outcomes. LyX GUI preferences are therefore not automatically `lq`'s command contract, as long as the resulting file remains valid LyX syntax."#,
            },
            HelpSection {
                heading: "Ownership of the document pipeline",
                body: r#"`lq` owns `.lyx` parsing, selection, mutation, serialization. LyX owns document creation, import/export, LaTeX processing, and PDF generation. Disk is the primary integration surface.

`lq` operates entirely independently of the LaTeX layer: it does not parse or interact with LaTeX syntax, such as LaTeX inside Formula, ERT, or preamble payloads. Any raw LaTeX in the document is treated as opaque string data and preserved flawlessly by the lossless parser."#,
            },
            HelpSection {
                heading: "Commit and outcomes",
                body: "Document mutations validate flags, selectors, schema context, and tracking boundaries before committing the file. A hard error has a non-zero exit status and does not commit a partial mutation. A successful JSON response may contain warnings: warnings are non-fatal diagnostics, not proof that the operation failed. Refresh confirmation is a separate outcome from dispatch; an unconfirmed refresh can follow a successfully written file.",
            },
            HelpSection {
                heading: "Core and built-in validation",
                body: r#"Mutations validate before committing the file. Built-in insets (such as `Formula` or `Note`) and inline properties (such as `change_inserted`) are recognized everywhere, regardless of document class.
- Core CST guards: `document`, `body`, and `header` cannot be mutated directly.
- Malformed `--raw-file` syntax that does not parse as valid LyX is rejected entirely.
- Unknown inset types in a raw payload produce a warning but do not block the insertion, because LyX's reader is permissive about inset names. `lq` checks against a hardcoded registry of inset types (sourced from LyX's inset definitions), because no inset type is defined by a document class.
- Inline properties: unknown property keys are rejected with the list of valid alternatives."#,
            },
            HelpSection {
                heading: "Document-class validation",
                body: r#"Document-class constructs are validated against the `.layout` file selected by the header's `\textclass`; these checks are skipped when no layout files can be found. `insert` is the only mutation that creates new structure, so it validates what it adds. Valid values for a document come from `lq schema`.
- Layout name: an unrecognized layout is rejected with the list of valid alternatives.
- Context boundaries: document layouts (e.g. `Section`) cannot be inserted inside insets (e.g. `Foot`); `Plain Layout` is the normal layout inside insets, and insets must sit inside a layout rather than at the body level.
- Cross-class: layouts from another document class (e.g. `Frame` in an `article` document) are rejected."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "model/cst",
                hint: "concrete structure and losslessness",
            },
            FurtherReading {
                page: "concepts/insets",
                hint: "format boundaries",
            },
            FurtherReading {
                page: "commands/schema",
                hint: "valid values for a document class",
            },
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "flat change regions",
            },
            FurtherReading {
                page: "concepts/mutations",
                hint: "validation and commit guarantees",
            },
            FurtherReading {
                page: "concepts/state-scope",
                hint: "state and undo snapshots",
            },
        ],
    },
    HelpPage {
        id: "model/cst",
        title: "concrete syntax tree: nodes, scale, and losslessness",
        sections: &[
            HelpSection {
                heading: "CST nodes",
                body: r#"`lq` parses a `.lyx` file into a Concrete Syntax Tree (CST): a tree of concrete nodes rather than a normalized abstract document. The CST preserves LyX-specific structure and text boundaries needed for lossless serialization.

`Node` is `lq`'s basic unit of structure and selection. A node is a concrete piece of the parsed LyX source with one owner and one position in its parent's children. A node can be atomic, down to a single property line. So a change region or inline-style span, which is a run of text and other children delimited by property markers, is represented by several nodes. But a node is not necessarily atomic:

- a layout block can contain a whole paragraph-sized mixture of text, properties, insets, and tracked regions; and
- an inset block can contain metadata plus nested layout blocks, so selecting the inset and selecting its child layout are deliberately different operations.

This is why selecting a node is also choosing the size and kind of the proposed change. Most commands take a selector to select nodes, then apply their operation at that node's scale.

A literal line or text fragment is represented by one text node. The parser splits text at every state boundary, so a text node never straddles an inline property or tracked-change transition — text surrounding `emph on`, `emph default`, `change_deleted`, or `change_inserted` is therefore represented as separate text nodes. That gives `lq` a safe, fine-grained unit without inventing arbitrary character-range nodes: formatting and change regions are runs of whole nodes, not character ranges inside one text node.

Structure is atomic, but content is not: text-node content can be edited at substring level. `set --find` replaces a substring inside text, and `insert split-after` divides a block at a text occurrence. The resulting rule is: select a node for structure, use a substring operation (such as `--find` or `split-after`), and use state predicates to select the relevant run of nodes."#,
            },
            HelpSection {
                heading: "Node scale and contents",
                body: r#"Each entry below names a node kind by its tag and lists what it contains — together they tell you what the selection represents.

Each CST scale is a different unit of selection:

```text
document
  LyX source: \begin_document ... \end_document
  Contains:   the complete parsed file, including header and body.
  Use for:    inspect or serialize the whole document; do not mutate it
              directly.

Structural container (body, header, or another block container)
  LyX source: \begin_header ... \end_header, \begin_body ... \end_body
  Contains:   ordered child nodes; body holds layout siblings, header holds
              document properties.
  Use for:    understand ownership or inspect a subtree; core containers
              are protected from direct mutation.

layout[Standard], layout[Section]
  LyX source: \begin_layout Section ... \end_layout
  Contains:   a paragraph or heading's direct text, inline property markers,
              tracked regions, and inline inset blocks.
  Use for:    replace a paragraph, delete a paragraph, insert paragraph
              content, or anchor a section range.

inset[Foot], inset[Formula], inset[CommandInset citation]
  LyX source: \begin_inset Foot ... \end_inset
  Contains:   inset metadata and, for text insets, nested layout blocks; an
              inset may be atomic for tracking even when its prose is nested.
  Use for:    inspect, insert, or delete the whole inset; target a child
              layout for tracked prose edits.

text (a run such as "The quick " between property markers)
  LyX source: plain text with no marker.
  Contains:   literal text, which may be prose, raw inset payload, preamble
              data, file # comments, or metadata text depending on its owner.
  Use for:    inspect a precise run, or use --find / state predicates for
              surgical content work.

property[textclass], property[family], property[change_inserted]
  LyX source: \textclass article, \family roman, \change_inserted 1 <ts>,
              \language english
  Contains:   one LyX state or document property plus its optional value;
              change/style markers delimit neighboring runs.
  Use for:    inspect or edit one property value, or understand the state
              transition around text.
```"#,
            },
            HelpSection {
                heading: "Line-level classification",
                body: r#"A node's kind is decided line by line:

- a line starting with `\begin_` or `\end_` opens or closes a structural block;
- a line starting with `\<word>` is a property — unless the word is `index`, `branch`, or `modules`, which are block forms;
- every other line is a text node;
- inside an opaque block (`preamble`, `Formula`, `ERT`) every line is a text node until its matching `\end_` line. An embedded `\SpecialChar` token, for example, stays inside a text node rather than becoming a property."#,
            },
            HelpSection {
                heading: "Document structure and nesting",
                body: r#"An apparent paragraph is usually not one text node. It is a layout block where ordinary layouts are siblings under the document body, so a `Section` heading and the `Standard` paragraphs that follow it sit side by side at the same depth, not as parent and child. The tree may look like this:

```text
document
    block document
        block header
            ...
        block body
            layout[Section]
                text "Introduction"
            layout[Standard]
                text "A paragraph with "
                property[emph] on
                text "emphasis"
                property[emph] default
                property[change_deleted] <author timestamp>
                text "rejected wording"
                property[change_inserted] <author timestamp>
                text "replacement wording"
                property[change_unchanged]
                inset[Foot]
                    text "status collapsed"
                    layout[Plain Layout]
                        text "footnote prose"
            layout[Standard]
                text "A second paragraph"
```

Selecting the layout sees the paragraph as a mixed structural unit; selecting `text` sees only text runs; selecting `property` sees a single state entry; selecting the footnote inset sees the whole inset; and selecting its `Plain Layout` sees the prose unit inside it."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "concepts/selectors",
                hint: "selecting node scales",
            },
            FurtherReading {
                page: "concepts/mutations",
                hint: "every-match mutation rules",
            },
            FurtherReading {
                page: "concepts/insets",
                hint: "nested and atomic structures",
            },
            FurtherReading {
                page: "commands/schema",
                hint: "valid values for each node tag",
            },
            FurtherReading {
                page: "commands/read",
                hint: "inspect CST nodes",
            },
            FurtherReading {
                page: "model/guarantees",
                hint: "lossless fidelity",
            },
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "change regions as node runs",
            },
        ],
    },
    HelpPage {
        id: "concepts/state-scope",
        title: "local and global state selection",
        sections: &[
            HelpSection {
                heading: "State",
                body: r#""State" is `lq`'s persistent bookkeeping for a working area: the configuration, the parsed-document cache, and the undo snapshots, all stored together under a `.lq` directory (the state root). Every invocation selects one state, and the selected state contains three artifacts:

```text
<state root>/.lq/config.json  # lq configuration
<state root>/.lq/cache/       # the parsed-document cache, keyed by the
                              # file-content SHA-256 hash, so unchanged
                              # documents are not re-parsed.
<state root>/.lq/undo/        # the mutation snapshots used to restore the
                              # last mutation.
```

State selection starts at the current working directory: the nearest ancestor containing a `.lq` directory supplies local `config.json`, `cache/`, and `undo/`. A manually created empty local `.lq` is enough to activate local defaults. If no marker exists, `lq` uses the global `~/.lq` directory in the user's home folder; the global home directory itself is not treated as a local project marker.

Local and global state are completely separated: each scope owns its own `config.json`, `cache/`, and `undo/`, with no merging, sharing, or mixing between them."#,
            },
            HelpSection {
                heading: "Supporting-state behavior",
                body: r#"The cache and undo snapshots are conveniences, not the document. Neither can change a command's results:

- Cache — the cache is write-through: after a mutation, it is updated with the new CST, so even back-to-back edits hit the cache after the first parse. A miss or failure only means the file is parsed again; the outcome is identical, and there is nothing to fix. A local cache miss never falls back to global state.
- Undo snapshots — `lq undo <file>` restores the last mutation from a snapshot. Saving is best-effort: a mutation is committed even when the snapshot cannot be saved, and the later `undo` reports `UNDO_SNAPSHOT_UNAVAILABLE`. When the snapshot cannot be saved, that mutation's JSON includes a warning. It never falls back to replay on its own; replay requires an explicit selector (`lq undo <file> <selector>`). If the file was changed externally since the snapshot, pass a selector to replay tracked changes instead."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "model/guarantees",
                hint: "state and mutation guarantees",
            },
            FurtherReading {
                page: "commands/init",
                hint: "configuration options",
            },
            FurtherReading {
                page: "commands/undo",
                hint: "snapshot scope",
            },
        ],
    },
    HelpPage {
        id: "concepts/private-notes",
        title: "note visibility on the content/state/structure axes",
        sections: &[
            HelpSection {
                heading: "Visibility rule across three axes",
                body: r#"LyX private notes `Note Note` and `Note Comment` are source content that is retained in the `.lyx` file and CST but omitted from the visible document output, including generated PDF.

`lq`'s visibility rule has three axes, with every surface living on exactly one axis:

```text
Content  — matching / extracting text
  Surfaces: :contains(), bare text, --find, split-after, --text-only
  Default:  visible-only: private-note prose is excluded unless the
            selector is note-scoped.

State  — matching change regions / styles
  Surfaces: :change(), :property()
  Default:  always visible: state predicates see note prose (a deleted
            note's text is still :change(deleted)).

Structure  — locating nodes / lossless views
  Surfaces: structural tags, ~, read/dump CST, --toc
  Default:  lossless: note nodes stay present; the TOC never surfaces
            note headings or note text.
```"#,
            },
            HelpSection {
                heading: "Opting into note prose",
                body: "Leave private notes alone unless the operation explicitly concerns them. To opt into note prose on the content axis, make the selector note-scoped using a `:note` part or an explicit `inset[Note ...]` path (e.g. `inset[Note Note] layout[Plain Layout]`); note-scope is per `,` group, so `text, text:note` is \"visible text + note text\".",
            },
            HelpSection {
                heading: "Greyedout notes",
                body: "`Note Greyedout` is visible output and is not excluded by the private-note rule, so `:note(Greyedout)` is rejected.",
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "concepts/selectors",
                hint: "content, state, and structure axes",
            },
            FurtherReading {
                page: "concepts/insets",
                hint: "note structure and metadata",
            },
            FurtherReading {
                page: "commands/read",
                hint: "inspect visible and note content",
            },
            FurtherReading {
                page: "commands/insert",
                hint: "note-aware split operations",
            },
            FurtherReading {
                page: "commands/dump",
                hint: "lossless CST and TOC views",
            },
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "state axis and note prose",
            },
        ],
    },
    HelpPage {
        id: "concepts/insets",
        title: "inset structure, atomicity, and data",
        sections: &[
            HelpSection {
                heading: "Inset data",
                body: r#"Insets are structural blocks. An inset that can hold prose — text under a nested layout — is called a text inset. Text directly under an `inset` block is inset data: it carries no change or style state (`:change()`/`:property()` never match it) and no tracked change markers.

Inset data has two kinds:

- raw LaTeX inside a `Formula` or `ERT` is opaque string data instead of CST properties or layouts: the LaTeX layer is not parsed while editing the LyX file.
- parameters and structural lines — `CommandInset` parameters such as `LatexCommand`, `key`, `reference`, and `name`, structural lines such as a tabular's column alignment, and Float/Branch/Box metadata — are document data."#,
            },
            HelpSection {
                heading: "Working with insets",
                body: r#"- Data: seen by bare `text` and `:contains()`; edited by `--find` on the inset itself. Selectors test presence only, so a `:not()` inner selector also matches data.
- Prose: select it with `inset[Foot] layout[Plain Layout]`, or reach it with `:contains()` and the state predicates. `set`, `set --find`, `split-after`, and `delete` work there, and tracked change markers wrap the layout's prose, not the inset itself.
- Data and prose: both visible in `read`/`dump`. Use `--replace-all` for a full rewrite, or `delete` + `insert --raw-file` for a structural replacement.
- `set --find` from a surrounding layout stops at the whole inset, so it never reaches prose or data inside; `insert split-after` descends into an inset only to reach a nested layout's prose, never the data.
- An inline formula is a whole-inset unit: `\begin_inset Formula $...$` keeps its payload on the opening line, not in text nodes, so `--find` cannot reach it and `--replace-all` rewrites only the children, not that line. Replace it with `delete` + `insert --raw-file`."#,
            },
            HelpSection {
                heading: "Atomic tracking on insets",
                body: r#"- Tracked whole-inset operations stay atomic: deletion and insertion markers wrap the whole inset in the layout that carries it, never inside its metadata.
- An inset nested directly under another inset (for example, a `Text` inset inside a `Tabular` cell) has no layout to carry deletion markers, so a tracked deletion of it is rejected."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "model/cst",
                hint: "block and child structure",
            },
            FurtherReading {
                page: "concepts/mutations",
                hint: "every-match mutation rules",
            },
            FurtherReading {
                page: "commands/insert",
                hint: "inset generation helpers",
            },
            FurtherReading {
                page: "commands/set",
                hint: "tracked versus untracked inset edits",
            },
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "atomic tracking rules",
            },
            FurtherReading {
                page: "commands/delete",
                hint: "whole-inset deletion",
            },
            FurtherReading {
                page: "concepts/private-notes",
                hint: "note insets",
            },
            FurtherReading {
                page: "concepts/selectors",
                hint: "inset selectors",
            },
        ],
    },
    HelpPage {
        id: "concepts/mutations",
        title: "every-match mutation rules and safety",
        sections: &[HelpSection {
            heading: "Every match is edited",
            body: r#"The mutation commands are `set`, `delete`, `insert`, `undo`, and `table`.

A mutation applies to every node matched by its selector. `insert` duplicates its payload for every match. `set` and `delete` can affect the entire document if the selector is too broad. Replay `undo` reverts the current author's tracked changes in every matched block that has them.

`table` mutations are the exception: they need exactly one table.

When `set`, `delete`, `insert`, or `undo` matches more than one node, the command proceeds but includes a blast-radius warning.
A mutation whose selector matches nothing is a hard error: it exits non-zero and writes nothing.
To avoid surprises, check the selector's match count before mutating with `read --count`."#,
        }],
        further_reading: &[
            FurtherReading {
                page: "model/guarantees",
                hint: "validation and commit guarantees",
            },
            FurtherReading {
                page: "concepts/selectors",
                hint: "selector reach and scoping",
            },
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "reviewable mutation behavior",
            },
            FurtherReading {
                page: "commands/undo",
                hint: "snapshot and replay reach",
            },
            FurtherReading {
                page: "commands/set",
                hint: "tracked replacement",
            },
            FurtherReading {
                page: "commands/delete",
                hint: "tracked deletion",
            },
            FurtherReading {
                page: "commands/insert",
                hint: "tracked insertion",
            },
            FurtherReading {
                page: "commands/table",
                hint: "one table per mutation",
            },
        ],
    },
    HelpPage {
        id: "concepts/tracked-changes",
        title: "change regions and tracked behavior",
        sections: &[
            HelpSection {
                heading: "Tracked changes",
                body: r#"Tracked changes record each mutation as a reviewable edit attributed to the configured author:

- `set`: marks the old text as `change_deleted` and the new text as `change_inserted`;
- `delete`: marks the selected content as `change_deleted`;
- `insert`: marks the new content as `change_inserted`;
- replay `undo`: removes the configured author's tracked change markers.

These markers are LyX properties. They delimit tracked regions — runs of text in one change state. A marker value records an author ID and timestamp: `\change_<type> <author ID> <timestamp>`.

A region closes at the next marker because LyX keeps one active change per position: a region opened by `change_deleted` is closed when the next region, opened by `change_inserted`, begins, with no `change_unchanged` between them. `change_unchanged` ends the open region and returns to current text.

A tracked mutation also adds or updates the document header's tracking state and author table. A header-less document cannot safely receive tracked markers and is rejected before mutation.

Authors are matched by name: an existing `\author <id> "<name>"` line with an optional trailing email, or a negative LyX hash ID, is still recognized and reused, so a mutation never adds a duplicate `\author` entry or misattributes markers to a fresh ID. A new name gets the next sequential ID above the largest positive ID already present."#,
            },
            HelpSection {
                heading: "Locating tracked changes",
                body: r#"Tracked changes split text into three regions: `current`, `inserted`, and `deleted`. `:change(current|inserted|deleted)` selects nodes by region. Combining these regions shows:

- `current` + `inserted` = the document with the change applied;
- `current` + `deleted` = the document with all changes rejected;
- `deleted` + `inserted` = the change itself."#,
            },
            HelpSection {
                heading: "Reading tracked changes",
                body: "By default, `read` and `dump` output annotate tracked text with its change status, and `--text-only` emits inline change markers (`\\change_deleted{...}` / `\\change_inserted{...}`) so current and rejected text stay distinguishable. Note prose follows the private-note visibility rule.",
            },
            HelpSection {
                heading: "Editing tracked text",
                body: r#"Mutations see all text by default, including rejected text. This makes locating and editing consistent: a selector can locate a node by text and `--find` can operate on the same text. `:change()` then narrows the operation when the same phrase occurs in multiple regions: `lq set document.lyx "text:change(current)" "new phrase" --find "old phrase"`.

Tracked changes are flat: LyX cannot represent one change region nested inside another. When a replacement targets text inside `change_deleted`, `lq` therefore preserves the rejected text and inserts the replacement as an adjacent new tracked change instead of nesting it inside the deleted region. The rejected region keeps its original author, so another author's replay undo removes only their own adjacent insertion and cannot silently resurrect the rejection. When a replacement instead targets text inside another author's `change_inserted` region, the consumed insert becomes the editor's deletion — matching LyX, which overwrites the insert's attribution at edit time. Replaying that deletion restores the consumed text as plain current text, so the original author's later replay in the same span can re-add text.

Tracked full-text `set` (plain or `--replace-all`) follows LyX's per-position overwrite model rather than wiping the children: rejected regions survive, same-author pending insertions are consumed, and another author's pending insertions are re-authored as the current author's deletions.

A tracked plain `set` keeps the inline properties around the replaced text inside `\change_deleted`, so rejecting the change restores the original formatting; an untracked one drops them, leaving no dead markup."#,
            },
            HelpSection {
                heading: "Tracked deletions",
                body: "A tracked whole-layout `delete` follows the same per-position model as text: adjacent same-author deletions merge into one region, already-deleted content keeps its original author (never reattributed), and inline properties are folded inside the deleted region so rejecting the change restores the original formatting. A paragraph deleted through its last position ends inside the region with no trailing closer — the byte-exact form LyX itself writes. A layout with no trackable content (only font properties or an empty change region) is rejected — there is nothing for a marker to wrap, and LyX discards a change region without text on read; disable tracking to remove such a layout.",
            },
            HelpSection {
                heading: "Table tracking",
                body: r#"Tables keep two marks. Row and column structure uses the `change=` attribute on `<row>` / `<column>`. Cell prose uses ordinary `\change_*` inside the cell. Replay undo of the table reverts `change=`; replay of a cell layout reverts `\change_*`."#,
            },
            HelpSection {
                heading: "Non-trackable surfaces",
                body: r#"Change markers (`\change_*`) are only valid inside a layout's text. Inset metadata cannot carry those markers — a table's column alignment line, for example, is tabular XML, not a layout.

With tracking on, a mutation targeting preamble lines, `#` comments, header text, or inset metadata is rejected; disable tracking for those surfaces or target a layout's text instead.

Property nodes are not trackable as standalone targets: LyX tracks changes on character positions, not on inline properties or header values, and a change region containing no text is discarded on read. With tracking on, deleting a property node is rejected — target the text the property formats (`layout[Standard] text:property(emph)`) instead. `set` on a property value is a plain untracked edit (LyX does not track formatting or header edits) and stays available."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "model/guarantees",
                hint: "LyX format constraints",
            },
            FurtherReading {
                page: "concepts/selectors",
                hint: "region matching semantics",
            },
            FurtherReading {
                page: "commands/set",
                hint: "tracked replacement",
            },
            FurtherReading {
                page: "commands/delete",
                hint: "tracked deletion",
            },
            FurtherReading {
                page: "commands/insert",
                hint: "tracked insertion",
            },
            FurtherReading {
                page: "commands/undo",
                hint: "replay and snapshot restore",
            },
            FurtherReading {
                page: "commands/table",
                hint: "row and column commands",
            },
            FurtherReading {
                page: "concepts/insets",
                hint: "what cannot be tracked",
            },
            FurtherReading {
                page: "concepts/private-notes",
                hint: "note prose visibility",
            },
        ],
    },
    HelpPage {
        id: "concepts/selectors",
        title: "selector syntax and reach",
        sections: &[
            HelpSection {
                heading: "Tags",
                body: r#"Selectors are CSS-like expressions used to locate nodes in the Concrete Syntax Tree (CST) and may select multiple nodes at once. They may deviate from CSS convention to better serve LyX.

Structural tags match block and property nodes, taking an optional bracket argument. Valid argument values can be discovered with `lq schema`.

- `layout[...]` takes a document layout from `documentLayouts` or an inset layout from `insetLayouts`
- `inset[...]` takes an inset type from `insets`
- `inset[CommandInset ...]` takes a CommandInset subtype from that entry's `subtypes`
- `property[...]` takes an inline property key from `inlineProperties`

Content tag for text nodes:

- `text`: prose, raw inset payload, preamble data, file `#` comments, or metadata text depending on the owner."#,
            },
            HelpSection {
                heading: "Combinators",
                body: r#"- A space selects descendants: `layout[Standard] inset[Formula]` finds a Formula inside a Standard paragraph. Because normal document layouts are flat siblings, a descendant query is usually useful for insets or text inside a layout, not for finding later paragraphs in a section.
- A tilde `~` selects matching siblings after an anchor, including nodes nested in their subtrees: `layout[Section] ~ layout[Standard]` matches all Standard layouts after a Section, running to the end of the document.
- A comma `,` selects the union of multiple selector arms: `layout[Section], inset[Foot]` matches all Section and Foot layouts."#,
            },
            HelpSection {
                heading: "Pseudo-class evaluation",
                body: r#"Pseudo-classes are node predicates and must follow a tag. Each is a true/false filter that keeps only nodes matching its condition. Chain several pseudo-classes to narrow selection further.

Pseudo-classes fall into two kinds.

- `:contains()`, `:not()`, `:change()`, `:property()`, and `:note()` match each node independently, so their order in a chain does not matter.
- Positional filters `:first`, `:last`, `:nth-match()`, `:adjacent()`, and `:until()` filter the matched sequence and apply in the order written, so chaining order matters."#,
            },
            HelpSection {
                heading: "Content and note filters",
                body: r#"`:contains(text)`

`:contains()` searches recursively and case-sensitively through descendant text, including inset metadata and tracked changes, to locate a layout by text. A private note's content is found only when the selector is note-scoped.

Example: `layout[Standard]:contains(some phrase)` selects the Standard paragraphs whose text contains the phrase.

`text:contains(...)` never matches: text nodes are not returned for `:contains` (lq would otherwise mutate each matched text node twice), so that selector form always yields an empty match. lq rejects any selector containing this dead arm as an invalid selector.

The text may be given bare, or quoted with either single (`'...'`) or double (`"..."`) quotes. The quotes are stripped by the parser and exist only to allow a literal `'`, `"`, `(`, or `)` inside the phrase. Prefer double quotes when the phrase itself contains an apostrophe.

`:not(selector)`

`:not()` excludes a block whose subtree contains a match of the inner selector. A `:contains()` inner also matches the block's own text, so `:contains(x)` and `:not(:contains(x))` partition the document.

Example: `layout[Standard]:not(inset[Formula])` selects the Standard paragraphs that do not contain a Formula inset.

Text and property nodes have no descendants, so they always pass.

`:note([Note|Comment])`

`:note()` matches nodes inside a private note (`Note Note` / `Note Comment`) or the note inset itself. Bare `:note` = any private note; `:note(Note)` / `:note(Comment)` = a specific type.

Example: `text:note` selects the text nodes inside a private note, and `layout:note:contains(some phrase)` selects the note-scoped layouts whose text contains the phrase.

A `:note` part also makes its `,` group note-scoped on the content axis: content matching — `set --find` and `split-after` included — sees note prose, so `text, text:note` is "visible text + note text". An explicit `inset[Note ...]` path (e.g. `inset[Note Note] layout[Plain Layout]`) is equally note-scoped."#,
            },
            HelpSection {
                heading: "Tracked-state and style filters",
                body: r#"`:change(region)`

`:change(current|inserted|deleted)` filters nodes by tracked-change region: text nodes match their own region, and layouts and insets match when they sit in the parent's region or contain text in the requested region, including prose inside nested layouts of an atomically tracked inset.
Private-note prose is visible.
Property nodes and inset metadata do not match.

Example: `layout:change(deleted), inset:change(deleted)` selects the layouts and insets that sit in the deleted region or contain deleted text.

`:change()` also scopes `set --find` and `split-after`, so a phrase present in multiple regions can be disambiguated. Example: `set "text:change(current)" "new phrase" --find "old phrase"` replaces `old phrase` only in current text; `insert "layout:change(deleted)" split-after "some phrase" --text "!"` splits a paragraph inside its deleted region.

`:property(key[=value])`

`:property(key[=value])` filters nodes under an inline style state: text nodes match by their own style, and layouts and insets match when they sit in the parent's style span or contain styled text, including prose inside nested layouts.
Without `=value`, any non-default value for the key matches; with `=value`, the comparison is case-insensitive and exact.
Private-note prose is visible.
Change markers and inset metadata do not match.

Example: `text:property(emph)` filters the text that is currently emphasized.
`:property()` also scopes `set --find` and `split-after`, so a phrase in a specific style span can be targeted."#,
            },
            HelpSection {
                heading: "Positional and range filters",
                body: r#"`:first` and `:last`

These filter the matches in query traversal order.

Example: `layout[Section]:first` selects the first Section heading, and `layout[Standard]:last` selects the last Standard paragraph.

`:nth-match(an+b)`

This filters the matches in query traversal order. Use CSS-style formulas such as `:nth-match(2)`, `:nth-match(odd)`, `:nth-match(even)`, or `:nth-match(2n+1)`. An invalid formula is rejected as an invalid selector (it would match nothing).

Example: `layout[Section]:nth-match(2)` selects the second Section heading — the second match.

`:adjacent(selector)`

`:adjacent()` matches a node whose immediately preceding meaningful sibling matches the inner selector.

Example: `layout[Standard]:adjacent(layout[Quote])` selects the Standard paragraphs that directly follow a Quote layout.

Text and property nodes between the siblings are skipped: the CST interleaves blank-line text nodes between sibling layouts, so adjacency is judged between blocks, not literal child positions.

`:until(selector)`

`:until()` bounds a `~` sibling range. It rejects a candidate when any node matching the inner selector appears in document order between the anchor and the candidate, inclusive. So the range stops before the next matching node, and that boundary node, its subtree, and everything after it are excluded.

Example: `layout[Section]:contains(some phrase):first ~ layout[Standard]:until(layout[Section])` selects the Standard paragraphs between the first section that contains `some phrase` and the next section, stopping before the next section's heading.

The check also covers descendant candidates: a bare arm such as `layout[Section]:contains(some phrase):first ~ layout:until(layout[Section])` stops the whole subtree before the next heading, so the next section's heading and its content are not pulled in.

With several anchors (the left side matched more than one node), each candidate is bounded by its nearest preceding anchor: the range from one anchor is never cut by a boundary that belongs to a later anchor's range. With a bare left arm such as `layout ~ layout:until(layout[Section])` every matched node is itself an anchor, so each boundary reopens the range after itself — anchor at one level with `:first` or a unique `:contains()` to keep the span predictable.

`:until()` without `~` is rejected as an invalid selector on every command: the bound has nothing to bound."#,
            },
            HelpSection {
                heading: "Selector scope for mutations",
                body: r#"The selector has two roles:

1. it chooses the nodes to operate on; and
2. its `:change()`, `:property()`, and `:note()` predicates define which text the search sees — the text scope for `set --find` and `split-after`.

Scope composition follows the selector:

- comma-separated arms form a union;
- chained predicates form an intersection;
- an unscoped arm means that arm can see all text;
- a `:note` part makes its scope see private-note prose; a target inside a note is in scope regardless.

Examples: `text:change(current), text:change(deleted)` includes current and deleted text but excludes inserted text; `text:change(current):property(emph)` requires both the current region and active emphasis."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "model/cst",
                hint: "node types and scale",
            },
            FurtherReading {
                page: "concepts/mutations",
                hint: "every-match mutation rules",
            },
            FurtherReading {
                page: "concepts/private-notes",
                hint: "visibility axes",
            },
            FurtherReading {
                page: "commands/read",
                hint: "selector inspection",
            },
            FurtherReading {
                page: "commands/schema",
                hint: "valid tag argument values",
            },
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "region matching",
            },
        ],
    },
    HelpPage {
        id: "commands/init",
        title: "initialize or view configuration",
        sections: &[
            HelpSection {
                heading: "Purpose",
                body: "lq init - Initialize or view local or global configuration.",
            },
            HelpSection {
                heading: "Usage",
                body: r#"  lq init [--global]             Read or create '.lq/config.json' if missing.
  lq init [options] [--global]   Create or update the selected config with the given options."#,
            },
            HelpSection {
                heading: "Options",
                body: r#"  --layouts-dir <path>      User-tier layouts overlay (searched before
                            the LyX user-dir and the install layouts).
                            Default: omitted.
  --refresh <mode>          Configure automatic refresh after mutations.
                            none (default): no refresh; LyX detects changes via polling.
                            reload:         reload and discard unsaved in-LyX edits.
                                            Best-effort: if LyXServer is unreachable,
                                            the file is still written and the skipped
                                            reload is reported as a warning.
                            save-reload:    save unsaved edits first, then reload.
                                            aborts before writing if LyXServer is
                                            genuinely unreachable.
  --track-changes <on|off>  Enable or disable tracked changes for mutation commands.
                            Default: on.
  --author-name <name>      Author name recorded on new tracked changes.
                            Default: "lq user".
  --max-cache-entries <n>   Cap for parse trees (cache/*.cst) and for Magick
                            figure rasters (cache/raster/*.png), each counted
                            separately. 0 disables both. Must be a complete
                            non-negative integer. Default: 50."#,
            },
            HelpSection {
                heading: "State scope",
                body: r#"  Commands use the nearest ancestor containing '.lq' as local state. If no local marker
  exists, they use the global '~/.lq' state. Local config, cache, and undo
  are strictly isolated from global state. '--global' changes only the init
  target; all other options apply to either scope."#,
            },
            HelpSection {
                heading: "Config precedence",
                body: r#"  New config: built-in defaults, then explicit options. 'layoutsDir' is only
  written when --layouts-dir is passed.
  Existing config: existing values, then explicit options; omitted values
  persist, including a previously stored 'layoutsDir' (user-tier overlay)."#,
            },
            HelpSection {
                heading: "Layout search order",
                body: r#"Layout search: optional overlay → LyX user-dir →
install layouts → document LocalLayout. Init JSON reports layoutSearch
(order) and layoutRoots (resolved paths)."#,
            },
            HelpSection {
                heading: "Refresh reachability probe",
                body: r#"Setting a non-'none' refresh mode runs a fast reachability probe; a probe
warning reports if LyXServer is currently unreachable but does not abort init."#,
            },
        ],
        further_reading: &[FurtherReading {
            page: "concepts/state-scope",
            hint: "state selection and artifacts",
        }],
    },
    HelpPage {
        id: "commands/schema",
        title: "valid layouts and properties for a document class",
        sections: &[
            HelpSection {
                heading: "Purpose",
                body: "lq schema - Return the semantically valid layouts and properties for a document's class.",
            },
            HelpSection {
                heading: "Usage",
                body: "  lq schema <file>",
            },
            HelpSection {
                heading: "Arguments",
                body: "  <file>      The path to the .lyx file.",
            },
            HelpSection {
                heading: "Output",
                body: r#"The response's 'data' contains five categories:
  documentLayouts      Styles valid for this document class (e.g. Section, Standard).
  insetLayouts         Layouts valid inside insets (e.g. Plain Layout).
  insets               Valid insets. Use kind to choose the file shape when writing:
                       collapsible  status line, then nested layouts
                       command      CommandInset params (one per line)
                       content      type-specific payload after the header
                       tabular      Tabular metadata block
                       spacing      short spacing inset
                       formatting   short inline inset
                       misc         remaining specialized shapes
  inlineProperties     Valid inline property keys (e.g. family, lang).
  headingHierarchy     Heading layouts with their TocLevel values.

The document's 'textclass' (e.g. article, book) selects the matching .layout
file from the configured layouts directory, or from the highest installed LyX
version auto-detected at runtime."#,
            },
        ],
        further_reading: &[FurtherReading {
            page: "model/cst",
            hint: "valid values for each node tag",
        }],
    },
    HelpPage {
        id: "commands/dump",
        title: "output the document structure",
        sections: &[
            HelpSection {
                heading: "Purpose",
                body: "lq dump - Output the document structure.",
            },
            HelpSection {
                heading: "Usage",
                body: r#"  lq dump <file> [<selector>] [options]
  lq dump <file> [options] --toc   Output a hierarchical heading tree instead
                                   of the raw CST. Heading levels come from the
                                   document class's .layout file (standard LaTeX
                                   hierarchy as fallback)."#,
            },
            HelpSection {
                heading: "Arguments",
                body: r#"  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector.
              Omit or structural selectors: dump the CST from root or matched structural nodes.
              Tracked changes are annotated, private-note nodes are visible.
              Bare text selector: dump the matched text nodes, excluding
              private-note prose unless note-scoped."#,
            },
            HelpSection {
                heading: "Options",
                body: r#"  --depth <n> Limit the output depth. Meaning depends on the mode:
              - Raw CST: parse-tree nesting. 0 = root node only; 1 = direct
                children; N = descend N levels. Omit for full depth.
              - With --toc: absolute LyX TocLevel up to any integer
                (Part=-1, Chapter=0, Section=1, ...). A leading minus is allowed:
                --depth -1 or --depth=-1. Insets are omitted from heading text."#,
            },
            HelpSection {
                heading: "Large output",
                body: r#"Output is several times larger than the .lyx file, and large output is
truncated by the terminal. Check the file size first and zoom in with a
narrower selector or `--depth` for large documents."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "model/cst",
                hint: "CST structure",
            },
            FurtherReading {
                page: "concepts/private-notes",
                hint: "note nodes in CST and TOC views",
            },
        ],
    },
    HelpPage {
        id: "commands/preview",
        title: "render the saved document as the Live reader projection",
        sections: &[
            HelpSection {
                heading: "Purpose",
                body: "lq preview - Render the saved document as the Live reader projection.",
            },
            HelpSection {
                heading: "Usage",
                body: "  lq preview <file>",
            },
            HelpSection {
                heading: "Arguments",
                body: r#"  <file>      The path to the saved .lyx file. The command reads disk
              contents only; it does not accept unsaved editor text."#,
            },
            HelpSection {
                heading: "Output",
                body: r#"One JSON object on stdout:
  contract       Always 'lyx-preview/live-1'.
  projection     Always 'live'.
  html           Escaped reader-facing HTML for the supported Live corpus.
  source         Saved-source identity: absolute path, SHA-256 of raw file
                 bytes (hashAlgorithm 'sha256', hashInput 'raw-file-bytes'),
                 diskHash, lineEnding (lf|crlf|mixed), lineCount, and
                 fresh=true (this command always reads the saved file).
  capabilities   mapping and outline are true; review, editing, and
                 sourceReveal are false. All five fields are present as
                 booleans.
  diagnostics    Structured notes such as unknown insets.
  changes        Ordered tracked-change regions in document order: each
                 entry carries ordinal, type (inserted|deleted), resolved
                 author, raw timestamp ts, anchorId (change-N on the
                 <ins>/<del> wrapper), and a collapsed text snippet.
  tokens         Read-first mapping tokens: each has id (equals the HTML
                 id/data-ref) and bundle {selector, optional
                 file+diskHash+via when the owner is an included
                 child .lyx}. The selector is a read reference for bundle.file
                 when set, else for source.path — not a mutation selector.
  outline        Heading tree for the reader outline (level, number, text, id).
  navigate       Navigation lists: figures, tables, equations, labels,
                 listings, and algorithms.
  warnings       Non-fatal messages from the CLI envelope. May include UTF-8
                 notes for include/listing children, schema layouts, bind maps,
                 and bib files; incomplete-file recovery (Preview shows what it can);
                 and a missing or unknown document class (preview uses article).
                 The document still renders and the command still succeeds.

A parse or file error is the usual {code, message} JSON object and a
non-zero exit. A file LyX would refuse (no \end_document, or not a readable
LyX document) is PARSE_ERROR. Missing layout search paths is LAYOUT_NOT_FOUND.
The command does not mutate the file."#,
            },
            HelpSection {
                heading: "Constraints",
                body: r#"- Tracked changes are all rendered in place: insertions as
  <ins class="change-inserted" id="change-N"> and deletions as
  <del class="change-deleted" id="change-N">, with the changes[] index
  describing each region. The reader decides which view to show.
- ERT appears as an escaped 'ERT' chip; Note/Comment appear as click-disclosable
  private notes; Greyedout is a collapsed chip. These are Live-only (native
  XHTML omits them).
- Formulas use a TeX→MathML subset with escaped fallback; they are not executed.
- Unknown insets become an escaped, marked fallback plus a diagnostic.
- Mapping tokens are emitted on supported owners (HTML id/data-ref).
  There is no source reveal and no send-to-chat command."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "commands/init",
                hint: "layoutSearch / layoutRoots and --layouts-dir overlay",
            },
            FurtherReading {
                page: "model/cst",
                hint: "the tree this projection is built from",
            },
            FurtherReading {
                page: "concepts/private-notes",
                hint: "private notes shown as Live disclosures",
            },
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "change wrappers plus the ordered changes index",
            },
        ],
    },
    HelpPage {
        id: "commands/read",
        title: "output matching nodes and text content",
        sections: &[
            HelpSection {
                heading: "Purpose",
                body: "lq read - Output matching nodes and text content.",
            },
            HelpSection {
                heading: "Usage",
                body: r#"  lq read <file> <selector>             Structural selectors: return the matched
                                        CST nodes with the match count; tracked
                                        text is annotated, private-note nodes are
                                        visible. Bare text selector: return the
                                        matched text nodes, excluding private-note
                                        prose unless note-scoped.
  lq read <file> <selector> [options]   Options alter the output as described
                                        below."#,
            },
            HelpSection {
                heading: "Arguments",
                body: r#"  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector.
              A selector with no matches is an empty result, not an error."#,
            },
            HelpSection {
                heading: "Options",
                body: r#"  --count     Return match counts grouped by node label (tag[args]).
              For text nodes, this counts individual text runs, not paragraphs.
  --text-only Output the text content of each matched node with structural
              annotations, separated by a double newline. Matched block nodes
              get a tag[args] prefix, insets appear as inline markers
              (e.g. inset[Foot]), and tracked changes appear as
              '\change_deleted{...}' / '\change_inserted{...}'."#,
            },
            HelpSection {
                heading: "Large output",
                body: r#"Output is several times larger than the .lyx file, and large output is
truncated by the terminal. Check the file size first and zoom in with a
narrower selector or `--count` for large documents."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "model/cst",
                hint: "CST node types and scale",
            },
            FurtherReading {
                page: "concepts/selectors",
                hint: "selector syntax",
            },
            FurtherReading {
                page: "concepts/private-notes",
                hint: "visible and note content",
            },
        ],
    },
    HelpPage {
        id: "commands/bib",
        title: "extract references from the bibliography",
        sections: &[
            HelpSection {
                heading: "Purpose",
                body: "lq bib - Extract references with key, author, title, and year from the bibliography.",
            },
            HelpSection {
                heading: "Usage",
                body: "  lq bib <file> [options]",
            },
            HelpSection {
                heading: "Arguments",
                body: "  <file>      The path to a .lyx document with linked .bib files or the path to a .bib file.",
            },
            HelpSection {
                heading: "Options",
                body: r#"  --search <text>
              Filter references by a case-insensitive substring match across
              key, author, title, and year. When multiple words are provided, all must match.
              Omit for all references."#,
            },
        ],
        further_reading: &[],
    },
    HelpPage {
        id: "commands/table",
        title: "list and edit tables",
        sections: &[
            HelpSection {
                heading: "Purpose",
                body: "lq table - List tables as a catalog, or edit one table's numbers and size without recreating it.",
            },
            HelpSection {
                heading: "Usage",
                body: r#"  lq table <file>                      Catalog of every table.
  lq table <file> <n>                  The catalog row whose index is n.
  lq table <file> <selector>           Catalog rows for tables that selector finds.
  lq table <file> [<n>|<selector>] set --data <text>
              Replace cell prose while keeping insets. A write wipes that
              cell's properties. Empty fields of a merge must stay empty.
  lq table <file> [<n>|<selector>] add-row [--index N] [--data <text>]
  lq table <file> [<n>|<selector>] add-column [--index N] [--data <text>]
  lq table <file> [<n>|<selector>] delete-row --index N
  lq table <file> [<n>|<selector>] delete-column --index N
              Deletion refuses the last remaining row or column.

Omit n and selector when the file has exactly one table."#,
            },
            HelpSection {
                heading: "Arguments",
                body: r#"  <file>      The path to the .lyx file.
  <n>         File-order index of every Tabular, including unnumbered and
              change-deleted tables.
  <selector>  A CSS-like selector. A cell, caption, float, or host paragraph
              finds the table(s) it belongs to. Listing keeps every match; a
              mutation needs exactly one table. Such a selector can be found
              in the catalog's `at` field.
  --data      The same text as `insert --table`: comma-separated fields, one
              row per line. Quotes wrap a field that contains a comma or a
              quote; `""` inside quotes is a literal quote. Not a file path,
              and not tab- or semicolon-separated.
  --index     On add-row / add-column, the new row or column becomes N
              (omit = append; `--index 1` prepends)."#,
            },
            HelpSection {
                heading: "Catalog",
                body: r#"A JSON catalog of `{ "tables": [ … ] }`. Each row has
`n`, `kind` (float / inline / longtable), `at`, `caption`, `label`, `region`
(current / inserted / deleted), and `data` (the physical rectangle of prose).
Optional `merges` lists each merged range from its top-left cell;
the other cells of the merge are empty fields in `data`.
`kind` is longtable when the Tabular has islongtable=true; else float when an
ancestor is a table float; else inline. Caption and label come from the table
float, or from a longtable's Caption Standard cell (not Caption Unnumbered)."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "commands/insert",
                hint: "create with --table",
            },
            FurtherReading {
                page: "commands/set",
                hint: "one cell",
            },
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "table replay vs cell replay",
            },
            FurtherReading {
                page: "concepts/selectors",
                hint: "at is a normal selector",
            },
        ],
    },
    HelpPage {
        id: "commands/set",
        title: "overwrite targeted nodes with new text",
        sections: &[
            HelpSection {
                heading: "Purpose",
                body: "lq set - Overwrite the targeted nodes with new text content.",
            },
            HelpSection {
                heading: "Usage",
                body: r#"  lq set <file> <selector> <new text>                     Replace each matched node's content and
                                                          inline properties:
                                                          a layout's direct text (insets preserved),
                                                          a text node's whole text, or a property's
                                                          value.
  lq set <file> <selector> <new text> --find <substring>  Replace all case-sensitive occurrences of
                                                          <substring> within the matched nodes' content.
                                                          Can match across text-node boundaries (e.g.
                                                          tracked change or style) but cannot cross
                                                          an inset.
  lq set <file> <selector> <new text> --replace-all       Replace ALL children of the target block,
                                                          not just text nodes."#,
            },
            HelpSection {
                heading: "Arguments",
                body: r#"  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector.
  <new text>  The new text content to apply to the matched nodes."#,
            },
            HelpSection {
                heading: "Safety",
                body: r#"A default `set` on an inset is rejected because it would destroy the inset's
structure (e.g. wiping `LatexCommand` and `name` lines).
With tracking on, editing inset metadata is rejected."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "tracked replacement",
            },
            FurtherReading {
                page: "concepts/selectors",
                hint: "text scope for --find",
            },
            FurtherReading {
                page: "concepts/mutations",
                hint: "every-match mutation rules",
            },
        ],
    },
    HelpPage {
        id: "commands/delete",
        title: "delete targeted nodes",
        sections: &[
            HelpSection {
                heading: "Purpose",
                body: "lq delete - Delete targeted nodes. Each matched node is deleted as a unit — a block's whole subtree goes with it.",
            },
            HelpSection {
                heading: "Usage",
                body: "  lq delete <file> <selector>",
            },
            HelpSection {
                heading: "Arguments",
                body: r#"  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "tracked deletion",
            },
            FurtherReading {
                page: "concepts/mutations",
                hint: "every-match mutation rules",
            },
        ],
    },
    HelpPage {
        id: "commands/insert",
        title: "insert new blocks or properties",
        sections: &[
            HelpSection {
                heading: "Purpose",
                body: "lq insert - Insert new blocks or properties relative to a selector.",
            },
            HelpSection {
                heading: "Usage",
                body: r#"  lq insert <file> <selector> split-after <match> --text <content>
              Insert bare text inline into the target block.
  lq insert <file> <selector> <position> --layout <name> --text <content>
              Insert a layout block with the given name and text.
              Position cannot be 'split-after'.
  lq insert <file> <selector> <position> --cite <key> [--cite-cmd <cmd>]
              Insert a CommandInset citation. --cite-cmd: citet
              (default), cite, citep, citeauthor, citeyear, citeyearpar,
              citebyear, footcite, autocite, citetitle, fullcite, footfullcite,
              nocite, keyonly.
  lq insert <file> <selector> <position> --ref <label> [--ref-cmd <cmd>]
              Insert a CommandInset cross-reference. --ref-cmd:
              ref (default), eqref, pageref, vpageref, vref, nameref, formatted,
              labelonly.
  lq insert <file> <selector> <position> --label <name>
              Insert a CommandInset label with the given name.
  lq insert <file> <selector> <position> --footnote <text>
              Insert a Foot inset containing a Plain Layout with <text>.
  lq insert <file> <selector> before|after --table <text>
              Insert a table float with an empty caption. <text> is comma-
              separated fields, one row per line (quotes wrap a field that
              contains a comma or a quote).
  lq insert <file> <selector> <position> --raw-file <path>
              Read raw LyX syntax from a file, parse it into CST nodes, validate,
              and insert."#,
            },
            HelpSection {
                heading: "Arguments",
                body: r#"  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector.
  <position>  Where to insert relative to each matched target:
              'before' / 'after'    Insert a block as a sibling of the target:
                                    a layout next to a layout, or an inline
                                    inset next to a node inside a layout.
              'prepend' / 'append'  Insert a block as a child of the target block:
                                    an inset inside a layout, or a nested layout
                                    inside an inset.
              'split-after <match>' Split the target block's prose right after the
                                    exact, case-sensitive <match> substring and
                                    insert at that point. The <match> must appear
                                    exactly once in the matched prose; a missing
                                    or repeated match is rejected. Reaches prose
                                    recursively in nested layouts, including
                                    tracked changes but excluding private notes
                                    unless note-scoped; inset metadata stays
                                    opaque."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "concepts/insets",
                hint: "inset structure and helpers",
            },
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "tracked insertion",
            },
        ],
    },
    HelpPage {
        id: "commands/undo",
        title: "revert edits",
        sections: &[
            HelpSection {
                heading: "Purpose",
                body: "lq undo - Revert edits.",
            },
            HelpSection {
                heading: "Usage",
                body: r#"  lq undo <file>                         Snapshot restore (1-level, any mutation).
                                         Consumes the snapshot in the selected local
                                         or global state to revert the last (tracked
                                         or plain) mutation as one unit; restores
                                         the saved document state by path.

  lq undo <file> <selector> [<substring>]
                                         Replay undo (unlimited levels). Removes the
                                         tracked-change blocks made by the current author
                                         as the direct children of the matched block nodes;
                                         with <substring>, only blocks whose text contains it.
                                         This can be applied to tables. With substring,
                                         it reverts the row or column uniquely identified
                                         by the substring, or nothing if ambiguous.
                                         The last remaining row or column is skipped.
                                         Can be reverted by snapshot restore."#,
            },
            HelpSection {
                heading: "Arguments",
                body: r#"  <file>       The path to the .lyx file.
  <selector>   A CSS-like selector.
  <substring>  Text inside the change_deleted or change_inserted block to revert,
               or prose of a tracked table row or column."#,
            },
            HelpSection {
                heading: "Replay targets block nodes",
                body: r#"Replay undo targets block nodes: a selector that matches only text or property
nodes, or a block whose changes sit inside a nested inset, produces a
warning and reverts nothing."#,
            },
        ],
        further_reading: &[
            FurtherReading {
                page: "concepts/state-scope",
                hint: "snapshot storage",
            },
            FurtherReading {
                page: "concepts/tracked-changes",
                hint: "replay semantics",
            },
        ],
    },
];

pub fn home_page() -> &'static HelpPage {
    &HELP_PAGES[0]
}

pub fn find_page(id: &str) -> Option<&'static HelpPage> {
    HELP_PAGES.iter().find(|p| p.id == id)
}

pub fn find_by_reach(reach: &str) -> Option<&'static HelpPage> {
    HELP_PAGES.iter().find(|p| reach_of(p.id) == reach)
}

pub fn find_by_alias(alias: &str) -> Option<&'static HelpPage> {
    HELP_PAGES.iter().find(|p| alias_of(p.id) == Some(alias))
}

pub struct GroupedPages {
    pub group: PageGroup,
    pub pages: Vec<&'static HelpPage>,
}

pub fn grouped_pages() -> Vec<GroupedPages> {
    [PageGroup::Model, PageGroup::Concepts, PageGroup::Commands]
        .into_iter()
        .map(|group| GroupedPages {
            group,
            pages: HELP_PAGES
                .iter()
                .filter(|p| group_of(p.id) == Some(group))
                .collect(),
        })
        .collect()
}
