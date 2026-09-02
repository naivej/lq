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
                body: "lq is a standalone CLI for parsing, querying, and mutating LyX documents (`.lyx` files):\n\n1. Parse: reads a `.lyx` file into a Concrete Syntax Tree (CST).\n2. Query: queries the CST with a CSS-like selector engine to find specific nodes.\n3. Mutate: applies `set`, `delete`, `insert`, or `undo` to the matched nodes.\n4. Serialize: converts the modified CST back into a `.lyx` file with lossless fidelity.",
            },
            HelpSection {
                heading: "Help commands",
                body: "- `lq help` - this page; it is also the page map below.\n- `lq help <page>` - open one help page, such as `lq help cst` or `lq help read`.\n- `lq <command> --help` - command-specific help alias for the corresponding command page.\n- `lq help --rich=auto|always|never` - control ANSI styling; the default is `auto`.\n- Flags are typed: a boolean flag takes no value; unknown flags and extra arguments are errors.",
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
                body: "`lq` is built on a \"Lossless DOM\" architecture. It parses `.lyx` files into a Concrete Syntax Tree (CST) rather than discarding source boundaries in an abstract model. For supported input, `serialize(parse(text))` is lossless after the current platform's line endings are normalized to LF. Text-node boundaries, inline properties, change markers, insets, and header structure are therefore meaningful data. Perfectly valid but idiosyncratic LyX formatting (such as trailing whitespace in specific tags or exact newline placement) is preserved exactly for the content `lq` parses.\n\nAn intentional mutation may reserialize the file, and LyX may later normalize cosmetic conventions that `lq` does not enforce — the 500-char column limit, punctuation newlines, font/change delta optimization. On Windows, LyX writes CRLF, while `lq` always serializes with LF line endings. Those are purely cosmetic: LyX reads the file fine, and the result is a formatting-only diff, not structural corruption.",
            },
            HelpSection {
                heading: "LyX format authority and lq policy",
                body: "The LyX writer and reader are authoritative for what a valid `.lyx` file can store: flat change regions, header shape, inset placement, and serialization constraints.\n\n`lq` follows official LyX as closely as possible. A deviation is justified only when it is a better design in `lq`'s CLI context than in the LyX GUI — such as selector scoping, rejected tracked text visibility, JSON responses, and explicit refresh outcomes. LyX GUI preferences are therefore not automatically `lq`'s command contract, as long as the resulting file remains valid LyX syntax.",
            },
            HelpSection {
                heading: "Ownership of the document pipeline",
                body: "`lq` owns `.lyx` parsing, selection, mutation, serialization. LyX owns document creation, import/export, LaTeX processing, and PDF generation. Disk is the primary integration surface.\n\n`lq` operates entirely independently of the LaTeX layer: it does not parse or interact with LaTeX syntax, such as LaTeX inside Formula, ERT, or preamble payloads. Any raw LaTeX in the document is treated as opaque string data and preserved flawlessly by the lossless parser.",
            },
            HelpSection {
                heading: "Commit and outcomes",
                body: "Document mutations validate flags, selectors, schema context, and tracking boundaries before committing the file. A hard error has a non-zero exit status and does not commit a partial mutation. A successful JSON response may contain warnings: warnings are non-fatal diagnostics, not proof that the operation failed. Refresh confirmation is a separate outcome from dispatch; an unconfirmed refresh can follow a successfully written file.",
            },
            HelpSection {
                heading: "Validation",
                body: "Mutations validate before committing the file. Built-in insets (such as `Formula` or `Note`) and inline properties (such as `change_inserted`) are recognized everywhere, regardless of document class.\n- Core CST guards: `document`, `body`, and `header` cannot be mutated directly.\n- Malformed `--raw-file` syntax that does not parse as valid LyX is rejected entirely.\n- Unknown inset types in a raw payload produce a warning but do not block the insertion, because LyX's reader is permissive about inset names. `lq` checks against a hardcoded registry of inset types (sourced from LyX's `InsetCode.h`), because no inset type is defined by a document class.\n\nDocument-class constructs are validated against the `.layout` file selected by the header's `\\textclass`; these checks are skipped when no layout files can be found. `insert` is the only mutation that creates new structure, so it validates what it adds. Valid values for a document come from `lq schema`.\n- Layout name: an unrecognized layout is rejected with the list of valid alternatives.\n- Context boundaries: document layouts (e.g. `Section`) cannot be inserted inside insets (e.g. `Foot`); `Plain Layout` is the normal layout inside insets, and insets must sit inside a layout rather than at the body level.\n- Cross-class: layouts from another document class (e.g. `Frame` in an `article` document) are rejected.\n- Inline properties: unknown property keys are rejected with the list of valid alternatives.",
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
                body: "`lq` parses a `.lyx` file into a Concrete Syntax Tree (CST): a tree of concrete nodes rather than a normalized abstract document. The CST preserves LyX-specific structure and text boundaries needed for lossless serialization.\n\n`Node` is `lq`'s basic unit of structure and selection. A node is a concrete piece of the parsed LyX source with one owner and one position in its parent's children. A node can be atomic, down to a single property line. So a change region or inline-style span, which is a run of text and other children delimited by property markers, is represented by several nodes. But a node is not necessarily atomic:\n\n- a layout block can contain a whole paragraph-sized mixture of text, properties, insets, and tracked regions; and\n- an inset block can contain metadata plus nested layout blocks, so selecting the inset and selecting its child layout are deliberately different operations.\n\nThis is why selecting a node is also choosing the size and kind of the proposed change. Most commands take a selector to select nodes, then apply their operation at that node's scale.\n\nA literal line or text fragment is represented by one text node. The parser splits text at every state boundary, so a text node never straddles an inline property or tracked-change transition — text surrounding `emph on`, `emph default`, `change_deleted`, or `change_inserted` is therefore represented as separate text nodes. That gives `lq` a safe, fine-grained unit without inventing arbitrary character-range nodes: formatting and change regions are runs of whole nodes, not character ranges inside one text node.\n\nStructure is atomic, but content is not: text-node content can be edited at substring level. `set --find` replaces a substring inside text, and `insert split-after` divides a block at a text occurrence. The resulting rule is: select a node for structure, use an inside-operation for a substring, and use state predicates to select the relevant run of nodes.",
            },
            HelpSection {
                heading: "Node scale and contents",
                body: "Each entry below names a node kind by its tag and lists what it contains — together they tell you what the selection represents.\n\nEach CST scale is a different unit of selection:\n\n```text\ndocument\n  LyX source: \\begin_document ... \\end_document\n  Contains:   the complete parsed file, including header and body.\n  Use for:    inspect or serialize the whole document; do not mutate it\n              directly.\n\nStructural container (body, header, or another block container)\n  LyX source: \\begin_header ... \\end_header, \\begin_body ... \\end_body\n  Contains:   ordered child nodes; body holds layout siblings, header holds\n              document properties.\n  Use for:    understand ownership or inspect a subtree; core containers\n              are protected from direct mutation.\n\nlayout[Standard], layout[Section]\n  LyX source: \\begin_layout Section ... \\end_layout\n  Contains:   a paragraph or heading's direct text, inline property markers,\n              tracked regions, and inline inset blocks.\n  Use for:    replace a paragraph, delete a paragraph, insert paragraph\n              content, or anchor a section range.\n\ninset[Foot], inset[Formula], inset[CommandInset citation]\n  LyX source: \\begin_inset Foot ... \\end_inset\n  Contains:   inset metadata and, for text insets, nested layout blocks; an\n              inset may be atomic for tracking even when its prose is nested.\n  Use for:    inspect, insert, or delete the whole inset; target a child\n              layout for tracked prose edits.\n\ntext (a run such as \"The quick \" between property markers)\n  LyX source: plain text with no marker.\n  Contains:   literal text, which may be prose, raw inset payload, preamble\n              data, file # comments, or metadata text depending on its owner.\n  Use for:    inspect a precise run, or use --find / state predicates for\n              surgical content work.\n\nproperty[textclass], property[family], property[change_inserted]\n  LyX source: \\textclass article, \\family roman, \\change_inserted 1 <ts>,\n              \\language english\n  Contains:   one LyX state or document property plus its optional value;\n              change/style markers delimit neighboring runs.\n  Use for:    inspect or edit one property value, or understand the state\n              transition around text.\n```\n\nThis classification is produced by the following rule at the line-level:\n\n- a line starting with `\\begin_` or `\\end_` opens or closes a structural block;\n- a line starting with `\\<word>` is a property — unless the word is `index`, `branch`, or `modules`, which are block forms;\n- every other line is a text node;\n- inside an opaque block (`preamble`, `Formula`, `ERT`) every line is a text node until its matching `\\end_` line. An embedded `\\SpecialChar` token, for example, stays inside a text node rather than becoming a property.\n\nAn apparent paragraph is usually not one text node. It is a layout block where ordinary layouts are siblings under the document body, so a `Section` heading and the `Standard` paragraphs that follow it sit side by side at the same depth, not as parent and child. The tree may look like this:\n\n```text\ndocument\n    block document\n        block header\n            ...\n        block body\n            layout[Section]\n                text \"Introduction\"\n            layout[Standard]\n                text \"A paragraph with \"\n                property[emph] on\n                text \"emphasis\"\n                property[emph] default\n                property[change_deleted] <author timestamp>\n                text \"rejected wording\"\n                property[change_inserted] <author timestamp>\n                text \"replacement wording\"\n                property[change_unchanged]\n                inset[Foot]\n                    text \"status collapsed\"\n                    layout[Plain Layout]\n                        text \"footnote prose\"\n            layout[Standard]\n                text \"A second paragraph\"\n```\n\nSelecting the layout sees the paragraph as a mixed structural unit; selecting `text` sees only text runs; selecting `property` sees a single state entry; selecting the footnote inset sees the whole inset; and selecting its `Plain Layout` sees the prose unit inside it.",
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
                body: "\"State\" is `lq`'s persistent bookkeeping for a working area: the configuration, the parsed-document cache, and the undo snapshots, all stored together under a `.lq` directory (the state root). Every invocation selects one state, and the selected state contains three artifacts:\n\n```text\n<state root>/.lq/config.json  # lq configuration\n<state root>/.lq/cache/       # the parsed-document cache, keyed by the\n                              # file-content SHA-256 hash, so unchanged\n                              # documents are not re-parsed.\n<state root>/.lq/undo/        # the mutation snapshots used to restore the\n                              # last mutation.\n```\n\nState selection starts at the current working directory: the nearest ancestor containing a `.lq` directory supplies local `config.json`, `cache/`, and `undo/`. A manually created empty local `.lq` is enough to activate local defaults. If no marker exists, `lq` uses the global `<host-native-home>/.lq` directory; the global home directory itself is not treated as a local project marker.\n\nLocal and global state are completely separated: each scope owns its own `config.json`, `cache/`, and `undo/`, with no merging, sharing, or mixing between them.",
            },
            HelpSection {
                heading: "Supporting-state behavior",
                body: "The cache and undo snapshots are conveniences, not the document. Neither can change a command's results:\n\n- Cache — the cache is write-through: after a mutation, it is updated with the new CST, so even back-to-back edits hit the cache after the first parse. A miss or failure only means the file is parsed again; the outcome is identical, and there is nothing to fix. A local cache miss never falls back to global state.\n- Undo snapshots — `lq undo <file>` restores the last mutation from a snapshot. Saving is best effort: a mutation is committed even when the snapshot cannot be saved, and the later `undo` reports `UNDO_SNAPSHOT_UNAVAILABLE`. When the snapshot cannot be saved, that mutation's JSON includes a warning. It never falls back to replay on its own; replay requires an explicit selector (`lq undo <file> <selector>`). If the file was changed externally since the snapshot, pass a selector to replay tracked changes instead.",
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
        sections: &[HelpSection {
            heading: "Visibility rule",
            body: "LyX private notes `Note Note` and `Note Comment` are source content that is retained in the `.lyx` file and CST but omitted from the visible document output, including generated PDF.\n\n`lq`'s visibility rule has three axes, with every surface living on exactly one axis:\n\n```text\nContent  — matching / extracting text\n  Surfaces: :contains(), bare text, --find, split-after, --text-only\n  Default:  visible-only: private-note prose is excluded unless the\n            selector is note-scoped.\n\nState  — matching change regions / styles\n  Surfaces: :change(), :property()\n  Default:  always visible: state predicates see note prose (a deleted\n            note's text is still :change(deleted)).\n\nStructure  — locating nodes / lossless views\n  Surfaces: structural tags, ~, read/dump CST, --toc\n  Default:  lossless: note nodes stay present; the TOC never surfaces\n            note headings or note text.\n```\n\nThis rule suggests leaving private notes alone unless the operation explicitly concerns them. To opt into note prose on the content axis, make the selector note-scoped using a `:note` part or an explicit `inset[Note …]` path (e.g. `inset[Note Note] layout[Plain Layout]`); note-scope is per `,` group, so `text, text:note` is \"visible text + note text\".\n\n`Note Greyedout` is different. It is visible output and is not excluded by the private-note rule, so `:note(Greyedout)` is rejected.",
        }],
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
                body: "Insets are structural blocks. An inset that can hold prose — text under a nested layout — is called a text inset. Text directly under an `inset` block is inset data: it carries no change or style state (`:change()`/`:property()` never match it) and no tracked change markers.\n\nInset data has two kinds:\n\n- raw LaTeX inside a `Formula` or `ERT` is opaque string data instead of CST properties or layouts: the LaTeX layer is not parsed while editing the LyX file.\n- parameters and structural lines — `CommandInset` parameters such as `LatexCommand`, `key`, `reference`, and `name`, structural lines such as a tabular's column alignment, and Float/Branch/Box metadata — are document data.",
            },
            HelpSection {
                heading: "Working with insets",
                body: "- Data: seen by bare `text` and `:contains()`; edited by `--find` on the inset itself. Selectors test presence only, so a `:not()` inner selector also matches data.\n- Prose: select it with `inset[Foot] layout[Plain Layout]`, or reach it with `:contains()` and the state predicates. `set`, `set --find`, `split-after`, and `delete` work there, and tracked change markers wrap the layout's prose, not the inset itself.\n- Data and prose: both visible in `read`/`dump`. Use `--replace-all` for a full rewrite, or `delete` + `insert --raw-file` for a structural replacement.\n- `set --find` from a surrounding layout stops at the whole inset, so it never reaches prose or data inside; `insert split-after` descends into an inset only to reach a nested layout's prose, never the data.\n- An inline formula is a whole-inset unit: `\\begin_inset Formula $...$` keeps its payload on the opening line, not in text nodes, so `--find` cannot reach it and `--replace-all` rewrites only the children, not that line. Replace it with `delete` + `insert --raw-file`.\n\n- Tracked whole-inset operations stay atomic: deletion and insertion markers wrap the whole inset in the layout that carries it, never inside its metadata.\n- An inset nested directly under another inset (for example a `Text` inset inside a `Tabular` cell) has no layout to carry deletion markers, so a tracked deletion of it is rejected.",
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
            body: "The mutation commands are `set`, `delete`, `insert`, and `undo`.\n\nA mutation applies to every node matched by its selector. `insert` duplicates its payload for every match. `set` and `delete` can affect the entire document if the selector is too broad. Replay `undo` reverts the current author's tracked changes in every matched block that has them.\n\nWhen a mutation matches more than one node, the command proceeds but includes a blast-radius warning.\nA mutation whose selector matches nothing is a hard error: it exits non-zero and writes nothing.\nTo avoid the surprise, check the selector's blast radius before mutating with `read --count`.",
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
        ],
    },
    HelpPage {
        id: "concepts/tracked-changes",
        title: "change regions and tracked behavior",
        sections: &[
            HelpSection {
                heading: "Tracked changes",
                body: "Tracked changes record each mutation as a reviewable edit attributed to the configured author:\n\n- `set`: marks the old text as `change_deleted` and the new text as `change_inserted`;\n- `delete`: marks the selected content as `change_deleted`;\n- `insert`: marks the new content as `change_inserted`;\n- replay `undo`: removes the configured author's tracked change markers.\n\nThese markers are LyX properties. They delimit tracked regions — runs of text in one change state. A marker value records an author ID and timestamp: `\\change_<type> <author ID> <timestamp>`.\n\nA region closes at the next marker because LyX keeps one active change per position: a region opened by `change_deleted` is closed when the next region, opened by `change_inserted`, begins, with no `change_unchanged` between them. `change_unchanged` ends the open region and returns to current text.\n\nA tracked mutation also adds or updates the document header's tracking state and author table. A header-less document cannot safely receive tracked markers and is rejected before mutation.\n\nAuthors are matched by name: an existing `\\author <id> \"<name>\"` line with an optional trailing email, or a negative LyX hash ID, is still recognized and reused, so a mutation never adds a duplicate `\\author` entry or mis-attributes markers to a fresh ID. A new name gets the next sequential ID above the largest positive ID already present.",
            },
            HelpSection {
                heading: "Locating tracked changes",
                body: "Tracked changes split text into three regions: `current`, `inserted`, and `deleted`. `:change(current|inserted|deleted)` selects nodes by region. Combining these regions shows:\n\n- `current` + `inserted` = the document with the change applied;\n- `current` + `deleted` = the document with all changes rejected;\n- `deleted` + `inserted` = the change itself.",
            },
            HelpSection {
                heading: "Reading tracked changes",
                body: "By default, `read` and `dump` output annotate tracked text with its change status, and `--text-only` emits inline change markers (`\\change_deleted{...}` / `\\change_inserted{...}`) so current and rejected text stay distinguishable. Note prose follows the private-note visibility rule.",
            },
            HelpSection {
                heading: "Editing tracked changes",
                body: "Mutations see all text by default, including rejected text. This makes locating and editing consistent: a selector can locate a node by text and `--find` can operate on the same text. `:change()` then narrows the operation when the same phrase occurs in multiple regions: `lq set document.lyx \"text:change(current)\" \"new phrase\" --find \"old phrase\"`.\n\nTracked changes are flat: LyX cannot represent one change region nested inside another. When a replacement targets text inside `change_deleted`, `lq` therefore preserves the rejected text and inserts the replacement as an adjacent new tracked change instead of nesting it inside the deleted region. The rejected region keeps its original author, so another author's replay undo removes only their own adjacent insertion and cannot silently resurrect the rejection. When a replacement instead targets text inside another author's `change_inserted` region, the consumed insert becomes the editor's deletion — matching LyX, which overwrites the insert's attribution at edit time. Replaying that deletion restores the consumed text as plain current text, so the original author's later replay in the same span can re-add text.\n\nTracked full-text `set` (plain or `--replace-all`) follows LyX's per-position overwrite model rather than wiping the children: rejected regions survive, same-author pending insertions are consumed, and another author's pending insertions are re-authored as the current author's deletions.\n\nA tracked plain `set` keeps the inline properties around the replaced text inside `\\change_deleted`, so rejecting the change restores the original formatting; an untracked one drops them, leaving no dead markup.\n\nChange markers are only valid inside a layout's text. Inset metadata is not trackable — a table's column alignment, for example, cannot carry a change marker, so treat a complex inset as an atomic structure. With tracking on, a mutation targeting preamble lines, `#` comments, header text, or inset metadata is rejected; disable tracking for those surfaces or target a layout's text instead.\n\nA tracked whole-layout `delete` follows the same per-position model as text: adjacent same-author deletions merge into one region, already-deleted content keeps its original author (never re-attributed), and inline properties are folded inside the deleted region so rejecting the change restores the original formatting. A paragraph deleted through its last position ends inside the region with no trailing closer — the byte-exact form LyX itself writes. A layout with no trackable content (only font properties or an empty change region) is refused — there is nothing for a marker to wrap, and LyX discards a change region without text on read; disable tracking to remove such a layout.\n\nProperty nodes are not trackable as standalone targets: LyX tracks changes on character positions, not on inline properties or header values, and a change region containing no text is discarded on read. With tracking on, `delete` of a property node is refused — target the text the property formats (`layout[Standard] text:property(emph)`) instead. `set` on a property value is a plain untracked edit (LyX does not track formatting or header edits) and stays available.",
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
                body: "Selectors are CSS-like expressions used to locate nodes in the Concrete Syntax Tree (CST) and may select multiple nodes at once. They may deviate from CSS convention to better serve LyX.\n\nStructural tags for block and property nodes. Use with an optional bracket argument. Valid argument values can be discovered with `lq schema`.\n\n- `layout[...]` takes a document layout from `documentLayouts` or an inset layout from `insetLayouts`\n- `inset[...]` takes an inset type from `insets`\n- `inset[CommandInset ...]` takes a CommandInset subtype from that entry's `subtypes`\n- `property[...]` takes an inline property key from `inlineProperties`\n\nContent tag for text nodes:\n\n- `text`: prose, raw inset payload, preamble data, file `#` comments, or metadata text depending on the owner.",
            },
            HelpSection {
                heading: "Combinators",
                body: "- A space selects descendants: `layout[Standard] inset[Formula]` finds a Formula inside a Standard paragraph. Because normal document layouts are flat siblings, a descendant query is usually useful for insets or text inside a layout, not for finding later paragraphs in a section.\n- A tilde `~` selects matching siblings after an anchor, including nodes nested in their subtrees: `layout[Section] ~ layout[Standard]` matches all Standard layouts after a Section, running to the end of the document.\n- A comma `,` selects the union of multiple selector arms: `layout[Section], inset[Foot]` matches all Section and Foot layouts.",
            },
            HelpSection {
                heading: "Pseudo-classes",
                body: "Pseudo-classes are node predicates and must follow a tag. Each is a true/false filter that keeps only nodes matching its condition. Chain several pseudo-classes to narrow selection further.\n\nPseudo-classes fall into two kinds.\n\n- `:contains()`, `:not()`, `:change()`, `:property()`, and `:note()` match each node independently, so their order in a chain does not matter.\n- Positional filters `:first`, `:last`, `:nth-match()`, `:adjacent()`, and `:until()` filter the matched sequence and apply in the order written, so chaining order matters.\n\n`:contains(text)`\n\n`:contains()` searches recursively and case-sensitively through descendant text, including inset metadata and tracked changes, to locate a layout by text. A private note's content is found only when the selector is note-scoped.\n\nExample: `layout[Standard]:contains(some phrase)` selects the Standard paragraphs whose text contains the phrase.\n\n`text:contains(...)` never matches: text nodes are not returned for `:contains` (lq would otherwise mutate each matched text node twice), so that selector form always yields an empty match. lq rejects any selector containing this dead arm as an invalid selector.\n\nThe text may be given bare, or quoted with either single (`'...'`) or double (`\"...\"`) quotes. The quotes are stripped by the parser and exist only to allow a literal `'`, `\"`, `(`, or `)` inside the phrase. Prefer double quotes when the phrase itself contains an apostrophe.\n\n`:not(selector)`\n\n`:not()` excludes a block whose subtree contains a match of the inner selector. A `:contains()` inner also matches the block's own text, so `:contains(x)` and `:not(:contains(x))` partition the document.\n\nExample: `layout[Standard]:not(inset[Formula])` selects the Standard paragraphs that do not contain a Formula inset.\n\nText and property nodes have no descendants, so they always pass.\n\n`:change(region)`\n\n`:change(current|inserted|deleted)` filters nodes by tracked-change region: text nodes match their own region, and layouts and insets match when they sit in the parent's region or contain text in the requested region, including prose inside nested layouts of an atomically tracked inset.\nPrivate-note prose is visible.\nProperty nodes and inset metadata do not match.\n\nExample: `layout:change(deleted), inset:change(deleted)` selects the layouts and insets that sit in the deleted region or contain deleted text.\n\n`:change()` also scopes `set --find` and `split-after`, so a phrase present in multiple regions can be disambiguated. Example: `set \"text:change(current)\" \"new phrase\" --find \"old phrase\"` replaces `old phrase` only in current text; `insert \"layout:change(deleted)\" split-after \"some phrase\" --text \"!\"` splits a paragraph inside its deleted region.\n\n`:property(key[=value])`\n\n`:property(key[=value])` filters nodes under an inline style state: text nodes match by their own style, and layouts and insets match when they sit in the parent's style span or contain styled text, including prose inside nested layouts.\nWithout `=value`, any non-default value for the key matches; with `=value`, the comparison is case-insensitive and exact.\nPrivate-note prose is visible.\nChange markers and inset metadata do not match.\n\nExample: `text:property(emph)` filters the text that is currently emphasized.\n`:property()` also scopes `set --find` and `split-after`, so a phrase in a specific style span can be targeted.\n\n`:note([Note|Comment])`\n\n`:note()` matches nodes inside a private note (`Note Note` / `Note Comment`) or the note inset itself. Bare `:note` = any private note; `:note(Note)` / `:note(Comment)` = a specific type.\n\nExample: `text:note` selects the text nodes inside a private note, and `layout:note:contains(some phrase)` selects the note-scoped layouts whose text contains the phrase.\n\nA `:note` part also makes its `,` group note-scoped on the content axis: content matching — `set --find` and `split-after` included — sees note prose, so `text, text:note` is \"visible text + note text\". An explicit `inset[Note …]` path (e.g. `inset[Note Note] layout[Plain Layout]`) is equally note-scoped.\n\n`:first` and `:last`\n\nThese filter the matches in query traversal order.\n\nExample: `layout[Section]:first` selects the first Section heading, and `layout[Standard]:last` selects the last Standard paragraph.\n\n`:nth-match(an+b)`\n\nThis filters the matches in query traversal order. Use CSS-style formulas such as `:nth-match(2)`, `:nth-match(odd)`, `:nth-match(even)`, or `:nth-match(2n+1)`. An invalid formula is rejected as an invalid selector (it would match nothing).\n\nExample: `layout[Section]:nth-match(2)` selects the second Section heading — the second match.\n\n`:adjacent(selector)`\n\n`:adjacent()` matches a node whose immediately preceding meaningful sibling matches the inner selector.\n\nExample: `layout[Standard]:adjacent(layout[Quote])` selects the Standard paragraphs that directly follow a Quote layout.\n\nText and property nodes between the siblings are skipped: the CST interleaves blank-line text nodes between sibling layouts, so adjacency is judged between blocks, not literal child positions.\n\n`:until(selector)`\n\n`:until()` bounds a `~` sibling range. It rejects a candidate when any node matching the inner selector appears in document order between the anchor and the candidate, inclusive. So the range stops before the next matching node, and that boundary node, its subtree, and everything after it are excluded.\n\nExample: `layout[Section]:contains(some phrase):first ~ layout[Standard]:until(layout[Section])` selects the Standard paragraphs between the first section that contains `some phrase` and the next section, stopping before the next section's heading.\n\nThe check also covers descendant candidates: a bare arm such as `layout[Section]:contains(some phrase):first ~ layout:until(layout[Section])` stops the whole subtree before the next heading, so the next section's heading and its content are not pulled in.\n\nWith several anchors (the left side matched more than one node), each candidate is bounded by its nearest preceding anchor: the range from one anchor is never cut by a boundary that belongs to a later anchor's range. With a bare left arm such as `layout ~ layout:until(layout[Section])` every matched node is itself an anchor, so each boundary re-opens the range after itself — anchor at one level with `:first` or a unique `:contains()` to keep the span predictable.\n\n`:until()` without `~` is rejected as an invalid selector on every command: the bound has nothing to bound.",
            },
            HelpSection {
                heading: "Selector scope for mutations",
                body: "The selector has two roles:\n\n1. it chooses the nodes to operate on; and\n2. its `:change()`, `:property()`, and `:note()` predicates define which text the search sees — the text scope for `set --find` and `split-after`.\n\nScope composition follows the selector:\n\n- comma-separated arms form a union;\n- chained predicates form an intersection;\n- an unscoped arm means that arm can see all text;\n- a `:note` part makes its scope see private-note prose; a target inside a note is in scope regardless.\n\nExamples: `text:change(current), text:change(deleted)` includes current and deleted text but excludes inserted text; `text:change(current):property(emph)` requires both the current region and active emphasis.",
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
                body: "  lq init [--global]             Read or create '.lq/config.json' if missing.\n  lq init [options] [--global]   Create or update the selected config with the given options.",
            },
            HelpSection {
                heading: "Options",
                body: "  --layouts-dir <path>      User-tier layouts overlay (searched before\n                            the LyX user-dir and the install layouts).\n                            Default: omitted.\n  --refresh <mode>          Configure automatic refresh after mutations.\n                            none (default): no refresh; LyX detects changes via polling.\n                            reload:         reload and discard unsaved in-LyX edits.\n                                            Best effort: if LyXServer is unreachable,\n                                            the file is still written and the skipped\n                                            reload is reported as a warning.\n                            save-reload:    save unsaved edits first, then reload.\n                                            aborts before writing if LyXServer is\n                                            genuinely unreachable.\n  --track-changes <on|off>  Enable or disable tracked changes for mutation commands.\n                            Default: on.\n  --author-name <name>      Author name recorded on new tracked changes.\n                            Default: \"lq user\".\n  --max-cache-entries <n>   Maximum cached parse results kept in the selected\n                            state's cache/ directory. Must be a complete\n                            non-negative integer.\n                            Default: 50.",
            },
            HelpSection {
                heading: "State scope",
                body: "  Commands use the nearest ancestor containing '.lq' as local state. If no local marker\n  exists, they use the global '<host-native-home>/.lq' state. Local config, cache, and undo\n  are strictly isolated from global state. '--global' changes only the init\n  target; all other options apply to either scope.",
            },
            HelpSection {
                heading: "Config precedence",
                body: "  New config: built-in defaults, then explicit options. 'layoutsDir' is only\n  written when --layouts-dir is passed.\n  Existing config: existing values, then explicit options; omitted values\n  persist, including a previously stored 'layoutsDir' (user-tier overlay).\n\nLayout search: optional overlay → LyX user-dir →\ninstall layouts → document LocalLayout. Init JSON reports layoutSearch\n(order) and layoutRoots (resolved paths).\n\nSetting a non-'none' refresh mode runs a fast reachability probe; a probe\nwarning does not abort init. A refresh that is dispatched but not confirmed\nproceeds with a warning rather than aborting.",
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
                body: "The response's 'data' contains five categories:\n  documentLayouts      Styles valid for this document class (e.g. Section, Standard).\n  insetLayouts         Layouts valid inside insets (e.g. Plain Layout).\n  insets               Valid insets. Use kind to choose the file shape when writing:\n                       collapsible  status line, then nested layouts\n                       command      CommandInset params (one per line)\n                       content      type-specific payload after the header\n                       tabular      Tabular metadata block\n                       spacing      short spacing inset\n                       formatting   short inline inset\n                       misc         remaining specialized shapes\n  inlineProperties     Valid inline property keys (e.g. family, lang).\n  headingHierarchy     Heading layouts with their TocLevel values.\n\nThe document's 'textclass' (e.g. article, book) selects the matching .layout\nfile from the configured layouts directory, or from the highest installed LyX\nversion auto-detected at runtime.",
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
                body: "  lq dump <file> [<selector>] [options]\n  lq dump <file> [options] --toc   Output a hierarchical heading tree instead\n                                   of the raw CST. Heading levels come from the\n                                   document class's .layout file (standard LaTeX\n                                   hierarchy as fallback).",
            },
            HelpSection {
                heading: "Arguments",
                body: "  <file>      The path to the .lyx file.\n  <selector>  A CSS-like selector.\n              Omit or structural selectors: dump the CST from root or matched structural nodes.\n              Tracked changes are annotated, private-note nodes are visible.\n              Bare text selector: dump the matched text nodes, excluding\n              private-note prose unless note-scoped.",
            },
            HelpSection {
                heading: "Options",
                body: "  --depth <n> Limit the output depth. Meaning depends on the mode:\n              - Raw CST: parse-tree nesting. 0 = root node only; 1 = direct\n                children; N = descend N levels. Omit for full depth.\n              - With --toc: absolute LyX TocLevel up to any integer\n                (Part=-1, Chapter=0, Section=1, …). A leading minus is allowed:\n                --depth -1 or --depth=-1. Insets are omitted from heading text.",
            },
            HelpSection {
                heading: "Large output",
                body: "Output is several times larger than the .lyx file, and large output is\ntruncated by the terminal. Check the file size first and zoom in with a\nnarrower selector or `--depth` for large documents.",
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
                body: "  <file>      The path to the saved .lyx file. The command reads disk\n              contents only; it does not accept unsaved editor text.",
            },
            HelpSection {
                heading: "Output",
                body: "One JSON object on stdout:\n  contract       Always 'lyx-preview/live-1'.\n  projection     Always 'live'.\n  html           Escaped reader-facing HTML for the supported Live corpus.\n  source         Saved-source identity: absolute path, SHA-256 of raw file\n                 bytes (hashAlgorithm 'sha256', hashInput 'raw-file-bytes'),\n                 diskHash, lineEnding (lf|crlf|mixed), lineCount, and\n                 fresh=true (this command always reads the saved file).\n  capabilities   mapping and outline are true; review, editing, and\n                 sourceReveal are false. All five fields are present as\n                 booleans.\n  diagnostics    Structured notes such as unknown insets.\n  changes        Ordered tracked-change regions in document order: each\n                 entry carries ordinal, type (inserted|deleted), resolved\n                 author, raw timestamp ts, anchorId (change-N on the\n                 <ins>/<del> wrapper), and a collapsed text snippet.\n  tokens         Read-first mapping tokens: each has id (equals the HTML\n                 id/data-ref) and bundle {selector, optional\n                 file+diskHash+via when the owner is an included\n                 child .lyx}. The selector is a read reference for bundle.file\n                 when set, else for source.path — not a mutation selector.\n  outline        Heading tree for the reader outline (level, number, text, id).\n  navigate       Navigation lists: figures, tables, equations, labels,\n                 listings, and algorithms.\n  warnings       Non-fatal messages from the CLI envelope. May include UTF-8\n                 notes for include/listing children, schema layouts, bind maps,\n                 and bib files; the document still renders and the command\n                 still succeeds.\n\nA parse or file error is the usual {code, message} JSON object and a\nnon-zero exit. A missing or unresolvable textclass layout is reported as\nLAYOUT_NOT_FOUND or NO_TEXTCLASS. The command does not mutate the file.",
            },
            HelpSection {
                heading: "Constraints",
                body: "- Tracked changes are all rendered in place: insertions as\n  <ins class=\"change-inserted\" id=\"change-N\"> and deletions as\n  <del class=\"change-deleted\" id=\"change-N\">, with the changes[] index\n  describing each region. The reader decides which view to show.\n- ERT appears as an escaped 'ERT' chip; Note/Comment appear as click-disclosable\n  private notes; Greyedout is a collapsed chip. These are Live-only (native\n  XHTML omits them).\n- Formulas use a TeX→MathML subset with escaped fallback; they are not executed.\n- Unknown insets become an escaped, marked fallback plus a diagnostic.\n- Mapping tokens are emitted on supported owners (HTML id/data-ref).\n  There is no source reveal and no send-to-chat command.",
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
                body: "  lq read <file> <selector>             Structural selectors: return the matched\n                                        CST nodes with the match count; tracked\n                                        text is annotated, private-note nodes are\n                                        visible. Bare text selector: return the\n                                        matched text nodes, excluding private-note\n                                        prose unless note-scoped.\n  lq read <file> <selector> [options]   Options alter the output as described\n                                        below.",
            },
            HelpSection {
                heading: "Arguments",
                body: "  <file>      The path to the .lyx file.\n  <selector>  A CSS-like selector.\n              A selector with no matches is an empty result, not an error.",
            },
            HelpSection {
                heading: "Options",
                body: "  --count     Return match counts grouped by node label (tag[args]).\n              A text count counts runs, not paragraphs.\n  --text-only Output the text content of each matched node with structural\n              annotations, separated by a double newline. Matched block nodes\n              get a tag[args] prefix, insets appear as inline markers\n              (e.g. inset[Foot]), and tracked changes appear as\n              '\\change_deleted{...}' / '\\change_inserted{...}'.",
            },
            HelpSection {
                heading: "Large output",
                body: "Output is several times larger than the .lyx file, and large output is\ntruncated by the terminal. Check the file size first and zoom in with a\nnarrower selector or `--count` for large documents.",
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
                body: "  --search <text>\n              Filter references by a case-insensitive substring match across\n              key, author, title, and year. Multiple words are ANDed.\n              Omit for all references.",
            },
        ],
        further_reading: &[],
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
                body: "  lq set <file> <selector> <new text>                     Replaces each matched node's content and\n                                                          inline properties:\n                                                          a layout's direct text (insets preserved),\n                                                          a text node's whole text, or a property's\n                                                          value.\n  lq set <file> <selector> <new text> --find <substring>  Replace all case-sensitive occurrences of\n                                                          <substring> within the matched nodes' content.\n                                                          Can match across text-node boundaries (e.g.\n                                                          tracked change or style) but cannot cross\n                                                          an inset.\n  lq set <file> <selector> <new text> --replace-all       Replace ALL children of the target block,\n                                                          not just text nodes.",
            },
            HelpSection {
                heading: "Arguments",
                body: "  <file>      The path to the .lyx file.\n  <selector>  A CSS-like selector.\n  <new text>  The new text content to apply to the matched nodes.",
            },
            HelpSection {
                heading: "Safety",
                body: "A default `set` on an inset is rejected because it would destroy the inset's\nstructure (e.g. wiping `LatexCommand` and `name` lines).\nWith tracking on, editing inset metadata is rejected.",
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
                body: "  <file>      The path to the .lyx file.\n  <selector>  A CSS-like selector.",
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
                body: "  lq insert <file> <selector> split-after <match> --text <content>\n              Splices bare text inline into the target block\n  lq insert <file> <selector> <position> --layout <name> --text <content>\n              Insert a layout block with the given name and text.\n              Position cannot be 'split-after'.\n  lq insert <file> <selector> <position> --cite <key> [--cite-cmd <cmd>]\n              Insert a CommandInset citation. --cite-cmd: citet\n              (default), cite, citep, citeauthor, citeyear, citeyearpar,\n              citebyear, footcite, autocite, citetitle, fullcite, footfullcite,\n              nocite, keyonly.\n  lq insert <file> <selector> <position> --ref <label> [--ref-cmd <cmd>]\n              Insert a CommandInset cross-reference. --ref-cmd:\n              ref (default), eqref, pageref, vpageref, vref, nameref, formatted,\n              labelonly.\n  lq insert <file> <selector> <position> --label <name>\n              Insert a CommandInset label with the given name.\n  lq insert <file> <selector> <position> --footnote <text>\n              Insert a Foot inset containing a Plain Layout with <text>.\n  lq insert <file> <selector> <position> --raw-file <path>\n              Read raw LyX syntax from a file, parse it into CST nodes, validate,\n              and insert.",
            },
            HelpSection {
                heading: "Arguments",
                body: "  <file>      The path to the .lyx file.\n  <selector>  A CSS-like selector.\n  <position>  Where to insert relative to each matched target:\n              'before' / 'after'    Insert a block as a sibling of the target:\n                                    a layout next to a layout, or an inline\n                                    inset next to a node inside a layout.\n              'prepend' / 'append'  Insert a block as a child of the target block:\n                                    an inset inside a layout, or a nested layout\n                                    inside an inset.\n              'split-after <match>' Split the target block's prose right after the\n                                    exact, case-sensitive <match> substring and\n                                    insert at that point. The <match> must appear\n                                    exactly once in the matched prose; a missing\n                                    or repeated match is rejected. Reaches prose\n                                    recursively in nested layouts, including\n                                    tracked changes but excluding private notes\n                                    unless note-scoped; inset metadata stays\n                                    opaque.",
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
                body: "  lq undo <file>                         Snapshot restore (1-level, any mutation).\n                                         Consumes the snapshot in the selected local\n                                         or global state to revert the last (tracked\n                                         or plain) mutation as one unit; restores\n                                         the saved document state by path.\n\n  lq undo <file> <selector> [<substring>]\n                                         Replay undo (unlimited levels). Removes the\n                                         tracked-change blocks made by the current author\n                                         as the direct children of the matched block nodes;\n                                         with <substring>, only blocks whose text contains it.\n                                         Can be reverted by snapshot restore.",
            },
            HelpSection {
                heading: "Arguments",
                body: "  <file>       The path to the .lyx file.\n  <selector>   A CSS-like selector.\n  <substring>  Text inside the change_deleted or change_inserted block to revert.",
            },
            HelpSection {
                heading: "Replay targets block nodes",
                body: "Replay undo targets block nodes: a selector that matches only text or property\nnodes, or a block whose changes sit inside a nested inset, is corrected with a\nwarning and reverts nothing.",
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
