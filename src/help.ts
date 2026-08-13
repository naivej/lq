/**
 * help.ts — the single help catalog for the built-in help.
 *
 * One structured object per help page. `group`, `reach`, and `alias` are
 * derived from `id` and never stored, so a page ID cannot be spelled
 * inconsistently between the map, the router, and the links.
 *
 * Phase 0 (dev log 113): types, the 18-page registry, and navigation
 * helpers. Phase 1 (dev log 114): content migration — page `sections` and
 * `furtherReading` transcribed from the help draft.
 */

export type PageGroup = "commands" | "model" | "concepts";

export interface HelpSection {
  /** Section heading, e.g. "Usage". */
  heading: string;
  /** Section body — prose-like text, not a second parser. */
  body: string;
}

export interface FurtherReading {
  /** Stable page ID of the related page. */
  page: string;
  /** One-line hint shown next to the link. */
  hint: string;
}

export interface HelpPage {
  /** Stable prefixed page ID, e.g. "commands/read"; "home" has no prefix. */
  id: string;
  /** Short title shown in the home page map. */
  title: string;
  /** Ordered sections (heading + body). */
  sections: HelpSection[];
  /** Related pages as stable page IDs with hints. */
  furtherReading: FurtherReading[];
}

const sec = (heading: string, body: string): HelpSection => ({ heading, body });
const fr = (page: string, hint: string): FurtherReading => ({ page, hint });

/** The part of a page ID after the final "/" — the canonical `lq help <page>` name. */
export function reachOf(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

/** The group prefix of a page ID; `home` has no group. */
export function groupOf(id: string): PageGroup | null {
  if (id === "home") return null;
  const slash = id.indexOf("/");
  return id.slice(0, slash) as PageGroup;
}

/**
 * The command alias for `lq <command> --help`. Command pages alias to their
 * reach; model and concept pages have no `--help` equivalent. `home` is
 * reached by `lq --help` and is special-cased by the router.
 */
export function aliasOf(id: string): string | undefined {
  return groupOf(id) === "commands" ? reachOf(id) : undefined;
}

/** Every help page, including `home`. Order: home, model, concepts, commands. */
export const HELP_PAGES: HelpPage[] = [
  {
    id: "home",
    title: "built-in help home and page map",
    sections: [
      sec(
        "",
        "lq is a standalone CLI for parsing, querying, and mutating LyX documents (`.lyx` files):\n\n" +
          "1. Parse: reads a `.lyx` file into a Concrete Syntax Tree (CST).\n" +
          "2. Query: queries the CST with a CSS-like selector engine to find specific nodes.\n" +
          "3. Mutate: applies `set`, `delete`, `insert`, or `undo` to the matched nodes.\n" +
          "4. Serialize: converts the modified CST back into a `.lyx` file with lossless fidelity.",
      ),
      sec(
        "Help commands",
        "- `lq help` - this page; it is also the page map below.\n" +
          "- `lq help <page>` - open one help page, such as `lq help cst` or `lq help read`.\n" +
          "- `lq <command> --help` - command-specific help alias for the corresponding command page.\n" +
          "- `lq help --rich=auto|always|never` - control ANSI styling; the default is `auto`.",
      ),
      // The "Pages" section (the page map) is generated from this catalog at
      // render time; it is not stored here.
    ],
    furtherReading: [],
  },
  {
    id: "model/guarantees",
    title: "the design guarantees behind lq",
    sections: [
      sec(
        "Concrete fidelity",
        "`lq` is built on a \"Lossless DOM\" architecture. It parses `.lyx` files into a Concrete Syntax Tree (CST) rather than discarding source boundaries in an abstract model. For supported input, `serialize(parse(text))` is lossless after the current platform's line endings are normalized to LF. Text-node boundaries, inline properties, change markers, insets, and header structure are therefore meaningful data. Perfectly valid but idiosyncratic LyX formatting (such as trailing whitespace in specific tags or exact newline placement) is preserved exactly for the content `lq` parses.\n\nAn intentional mutation may reserialize the file, and LyX may later normalize cosmetic conventions that `lq` does not enforce — the 500-char column limit, punctuation newlines, font/change delta optimization. On Windows, LyX writes CRLF, while `lq` always serializes with LF line endings. Those are purely cosmetic: LyX reads the file fine, and the result is a formatting-only diff, not structural corruption.",
      ),
      sec(
        "LyX format authority and lq policy",
        "The LyX writer and reader are authoritative for what a valid `.lyx` file can store: flat change regions, header shape, inset placement, and serialization constraints.\n\n`lq` follows official LyX as closely as possible. A deviation is justified only when it is a better design in `lq`'s CLI context than in the LyX GUI — such as selector scoping, rejected tracked text visibility, JSON responses, and explicit refresh outcomes. LyX GUI preferences are therefore not automatically `lq`'s command contract, as long as the resulting file remains valid LyX syntax.",
      ),
      sec(
        "Ownership of the document pipeline",
        "`lq` owns `.lyx` parsing, selection, mutation, serialization. LyX owns document creation, import/export, LaTeX processing, and PDF generation. Disk is the primary integration surface.\n\n`lq` operates entirely independently of the LaTeX layer: it does not parse or interact with LaTeX syntax, such as LaTeX inside Formula, ERT, or preamble payloads. Any raw LaTeX in the document is treated as opaque string data and preserved flawlessly by the lossless parser.",
      ),
      sec(
        "Commit and outcomes",
        "Document mutations validate flags, selectors, schema context, and tracking boundaries before committing the file. A hard error has a non-zero exit status and does not commit a partial mutation. A successful JSON response may contain warnings: warnings are non-fatal diagnostics, not proof that the operation failed. Refresh confirmation is a separate outcome from dispatch; an unconfirmed refresh can follow a successfully written file.",
      ),
      sec(
        "Validation",
        "Mutations validate before committing the file. Built-in insets (such as `Formula` or `Note`) and inline properties (such as `change_inserted`) are recognized everywhere, regardless of document class.\n" +
          "- Core CST guards: `document`, `body`, and `header` cannot be mutated directly.\n" +
          "- Malformed `--raw-file` syntax that does not parse as valid LyX is rejected entirely.\n" +
          "- Unknown inset types in a raw payload produce a warning but do not block the insertion, because LyX's reader is permissive about inset names. `lq` checks against a hardcoded registry of inset types (sourced from LyX's `InsetCode.h`), because no inset type is defined by a document class.\n\n" +
          "Document-class constructs are validated against the `.layout` file selected by the header's `\\textclass`; these checks are skipped when no layout files can be found. `insert` is the only mutation that creates new structure, so it validates what it adds. Valid values for a document come from `lq schema`.\n" +
          "- Layout name: an unrecognized layout is rejected with the list of valid alternatives.\n" +
          "- Context boundaries: document layouts (e.g. `Section`) cannot be inserted inside insets (e.g. `Foot`); `Plain Layout` is the normal layout inside insets, and insets must sit inside a layout rather than at the body level.\n" +
          "- Cross-class: layouts from another document class (e.g. `Frame` in an `article` document) are rejected.\n" +
          "- Inline properties: unknown property keys are rejected with the list of valid alternatives.",
      ),
    ],
    furtherReading: [
      fr("model/cst", "concrete structure and losslessness"),
      fr("concepts/insets", "format boundaries"),
      fr("commands/schema", "valid values for a document class"),
      fr("concepts/tracked-changes", "flat change regions"),
      fr("concepts/mutations", "validation and commit guarantees"),
      fr("concepts/state-scope", "state and undo snapshots"),
    ],
  },
  {
    id: "model/cst",
    title: "concrete syntax tree: nodes, scale, and losslessness",
    sections: [
      sec(
        "CST nodes",
        "`lq` parses a `.lyx` file into a Concrete Syntax Tree (CST): a tree of concrete nodes rather than a normalized abstract document. The CST preserves LyX-specific structure and text boundaries needed for lossless serialization.\n\n" +
          "`Node` is `lq`'s basic unit of structure and selection. A node is a concrete piece of the parsed LyX source with one owner and one position in its parent's children. A node can be atomic, down to a single property line. So a change region or inline-style span, which is a run of text and other children delimited by property markers, is represented by several nodes. But a node is not necessarily atomic:\n\n" +
          "- a layout block can contain a whole paragraph-sized mixture of text, properties, insets, and tracked regions; and\n" +
          "- an inset block can contain metadata plus nested layout blocks, so selecting the inset and selecting its child layout are deliberately different operations.\n\n" +
          "This is why selecting a node is also choosing the size and kind of the proposed change. Most commands take a selector to select nodes, then apply their operation at that node's scale.\n\n" +
          "A literal line or text fragment is represented by one text node. The parser splits text at every state boundary, so a text node never straddles an inline property or tracked-change transition — text surrounding `emph on`, `emph default`, `change_deleted`, or `change_inserted` is therefore represented as separate text nodes. That gives `lq` a safe, fine-grained unit without inventing arbitrary character-range nodes: formatting and change regions are runs of whole nodes, not character ranges inside one text node.\n\n" +
          "Structure is atomic, but content is not: text-node content can be edited at substring level. `set --find` replaces a substring inside text, and `insert split-after` divides a block at a text occurrence. The resulting rule is: select a node for structure, use an inside-operation for a substring, and use state predicates to select the relevant run of nodes.",
      ),
      sec(
        "Node scale and contents",
        "Each entry below names a node kind by its tag and lists what it contains — together they tell you what the selection represents.\n\nEach CST scale is a different unit of selection:\n\n" +
          "```text\n" +
          "document\n" +
          "  LyX source: \\begin_document ... \\end_document\n" +
          "  Contains:   the complete parsed file, including header and body.\n" +
          "  Use for:    inspect or serialize the whole document; do not mutate it\n" +
          "              directly.\n\n" +
          "Structural container (body, header, or another block container)\n" +
          "  LyX source: \\begin_header ... \\end_header, \\begin_body ... \\end_body\n" +
          "  Contains:   ordered child nodes; body holds layout siblings, header holds\n" +
          "              document properties.\n" +
          "  Use for:    understand ownership or inspect a subtree; core containers\n" +
          "              are protected from direct mutation.\n\n" +
          "layout[Standard], layout[Section]\n" +
          "  LyX source: \\begin_layout Section ... \\end_layout\n" +
          "  Contains:   a paragraph or heading's direct text, inline property markers,\n" +
          "              tracked regions, and inline inset blocks.\n" +
          "  Use for:    replace a paragraph, delete a paragraph, insert paragraph\n" +
          "              content, or anchor a section range.\n\n" +
          "inset[Foot], inset[Formula], inset[CommandInset citation]\n" +
          "  LyX source: \\begin_inset Foot ... \\end_inset\n" +
          "  Contains:   inset metadata and, for text insets, nested layout blocks; an\n" +
          "              inset may be atomic for tracking even when its prose is nested.\n" +
          "  Use for:    inspect, insert, or delete the whole inset; target a child\n" +
          "              layout for tracked prose edits.\n\n" +
          "text (a run such as \"The quick \" between property markers)\n" +
          "  LyX source: plain text with no marker.\n" +
          "  Contains:   literal text, which may be prose, raw inset payload, preamble\n" +
          "              data, file # comments, or metadata text depending on its owner.\n" +
          "  Use for:    inspect a precise run, or use --find / state predicates for\n" +
          "              surgical content work.\n\n" +
          "property[textclass], property[family], property[change_inserted]\n" +
          "  LyX source: \\textclass article, \\family roman, \\change_inserted 1 <ts>,\n" +
          "              \\language english\n" +
          "  Contains:   one LyX state or document property plus its optional value;\n" +
          "              change/style markers delimit neighboring runs.\n" +
          "  Use for:    inspect or edit one property value, or understand the state\n" +
          "              transition around text.\n" +
          "```\n\n" +
          "This classification is produced by the following rule at the line-level:\n\n" +
          "- a line starting with `\\begin_` or `\\end_` opens or closes a structural block;\n" +
          "- a line starting with `\\<word>` is a property — unless the word is `index`, `branch`, or `modules`, which are block forms;\n" +
          "- every other line is a text node;\n" +
          "- inside an opaque block (`preamble`, `Formula`, `ERT`) every line is a text node until its matching `\\end_` line. An embedded `\\SpecialChar` token, for example, stays inside a text node rather than becoming a property.\n\n" +
          "An apparent paragraph is usually not one text node. It is a layout block where ordinary layouts are siblings under the document body, so a `Section` heading and the `Standard` paragraphs that follow it sit side by side at the same depth, not as parent and child. The tree may look like this:\n\n" +
          "```text\n" +
          "document\n" +
          "    block document\n" +
          "        block header\n" +
          "            ...\n" +
          "        block body\n" +
          "            layout[Section]\n" +
          "                text \"Introduction\"\n" +
          "            layout[Standard]\n" +
          "                text \"A paragraph with \"\n" +
          "                property[emph] on\n" +
          "                text \"emphasis\"\n" +
          "                property[emph] default\n" +
          "                property[change_deleted] <author timestamp>\n" +
          "                text \"rejected wording\"\n" +
          "                property[change_inserted] <author timestamp>\n" +
          "                text \"replacement wording\"\n" +
          "                property[change_unchanged]\n" +
          "                inset[Foot]\n" +
          "                    text \"status collapsed\"\n" +
          "                    layout[Plain Layout]\n" +
          "                        text \"footnote prose\"\n" +
          "            layout[Standard]\n" +
          "                text \"A second paragraph\"\n" +
          "```\n\n" +
          "Selecting the layout sees the paragraph as a mixed structural unit; selecting `text` sees only text runs; selecting `property` sees a single state entry; selecting the footnote inset sees the whole inset; and selecting its `Plain Layout` sees the prose unit inside it.",
      ),
    ],
    furtherReading: [
      fr("concepts/selectors", "selecting node scales"),
      fr("concepts/mutations", "every-match mutation rules"),
      fr("concepts/insets", "nested and atomic structures"),
      fr("commands/schema", "valid values for each node tag"),
      fr("commands/read", "inspect CST nodes"),
      fr("model/guarantees", "lossless fidelity"),
      fr("concepts/tracked-changes", "change regions as node runs"),
    ],
  },
  {
    id: "concepts/state-scope",
    title: "local and global state selection",
    sections: [
      sec(
        "State",
        "\"State\" is `lq`'s persistent bookkeeping for a working area: the configuration, the parsed-document cache, and the undo snapshots, all stored together under a `.lq` directory (the state root). Every invocation selects one state, and the selected state contains three artifacts:\n\n" +
          "```text\n" +
          "<state root>/.lq/config.json  # lq configuration\n" +
          "<state root>/.lq/cache/       # the parsed-document cache, keyed by the\n" +
          "                              # file-content SHA-256 hash, so unchanged\n" +
          "                              # documents are not re-parsed.\n" +
          "<state root>/.lq/undo/        # the mutation snapshots used to restore the\n" +
          "                              # last mutation.\n" +
          "```\n\n" +
          "State selection starts at the current working directory: the nearest ancestor containing a `.lq` directory supplies local `config.json`, `cache/`, and `undo/`. A manually created empty local `.lq` is enough to activate local defaults. If no marker exists, `lq` uses the global `<host-native-home>/.lq` directory; the global home directory itself is not treated as a local project marker.\n\n" +
          "Local and global state are completely separated: each scope owns its own `config.json`, `cache/`, and `undo/`, with no merging, sharing, or mixing between them.",
      ),
      sec(
        "Supporting-state behavior",
        "The cache and undo snapshots are conveniences, not the document. Neither can change a command's results:\n\n" +
          "- Cache — the cache is write-through: after a mutation, it is updated with the new CST, so even back-to-back edits hit the cache after the first parse. A miss or failure only means the file is parsed again; the outcome is identical, and there is nothing to fix. A local cache miss never falls back to global state.\n" +
          "- Undo snapshots — `lq undo <file>` restores the last mutation from a snapshot. Saving is best effort: a mutation is committed even when the snapshot cannot be saved, and the later `undo` reports `UNDO_SNAPSHOT_UNAVAILABLE`. It never falls back to replay on its own; replay requires an explicit selector (`lq undo <file> <selector>`). If the file was changed externally since the snapshot, pass a selector to replay tracked changes instead.",
      ),
    ],
    furtherReading: [
      fr("model/guarantees", "state and mutation guarantees"),
      fr("commands/init", "configuration options"),
      fr("commands/undo", "snapshot scope"),
    ],
  },
  {
    id: "concepts/private-notes",
    title: "note visibility on the content/state/structure axes",
    sections: [
      sec(
        "Visibility rule",
        "LyX private notes `Note Note` and `Note Comment` are source content that is retained in the `.lyx` file and CST but omitted from the visible document output, including generated PDF.\n\n" +
          "`lq`'s visibility rule has three axes, with every surface living on exactly one axis:\n\n" +
          "```text\n" +
          "Content  — matching / extracting text\n" +
          "  Surfaces: :contains(), bare text, --find, split-after, --text-only\n" +
          "  Default:  visible-only: private-note prose is excluded unless the\n" +
          "            selector is note-scoped.\n\n" +
          "State  — matching change regions / styles\n" +
          "  Surfaces: :change(), :property()\n" +
          "  Default:  always visible: state predicates see note prose (a deleted\n" +
          "            note's text is still :change(deleted)).\n\n" +
          "Structure  — locating nodes / lossless views\n" +
          "  Surfaces: structural tags, ~, read/dump CST, --toc\n" +
          "  Default:  lossless: note nodes stay present; the TOC never surfaces\n" +
          "            note headings or note text.\n" +
          "```\n\n" +
          "This rule suggests leaving private notes alone unless the operation explicitly concerns them. To opt into note prose on the content axis, make the selector note-scoped using a `:note` part or an explicit `inset[Note …]` path (e.g. `inset[Note Note] layout[Plain Layout]`); note-scope is per `,` group, so `text, text:note` is \"visible text + note text\".\n\n" +
          "`Note Greyedout` is different. It is visible output and is not excluded by the private-note rule, so `:note(Greyedout)` is rejected.",
      ),
    ],
    furtherReading: [
      fr("concepts/selectors", "content, state, and structure axes"),
      fr("concepts/insets", "note structure and metadata"),
      fr("commands/read", "inspect visible and note content"),
      fr("commands/insert", "note-aware split operations"),
      fr("commands/dump", "lossless CST and TOC views"),
      fr("concepts/tracked-changes", "state axis and note prose"),
    ],
  },
  {
    id: "concepts/insets",
    title: "inset structure, atomicity, and data",
    sections: [
      sec(
        "Inset data",
        "Insets are structural blocks. An inset that can hold prose — text under a nested layout — is called a text inset. Text directly under an `inset` block is inset data: it carries no change or style state (`:change()`/`:property()` never match it) and no tracked change markers.\n\nInset data has two kinds:\n\n" +
          "- raw LaTeX inside a `Formula` or `ERT` is opaque string data instead of CST properties or layouts: the LaTeX layer is not parsed while editing the LyX file.\n" +
          "- parameters and structural lines — `CommandInset` parameters such as `LatexCommand`, `key`, `reference`, and `name`, structural lines such as a tabular's column alignment, and Float/Branch/Box metadata — are document data.",
      ),
      sec(
        "Working with insets",
        "- Data: seen by bare `text` and `:contains()`; edited by `--find` on the inset itself. Selectors test presence only, so a `:not()` inner selector also matches data.\n" +
          "- Prose: select it with `inset[Foot] layout[Plain Layout]`, or reach it with `:contains()` and the state predicates. `set`, `set --find`, `split-after`, and `delete` work there, and tracked change markers wrap the layout's prose, not the inset itself.\n" +
          "- Data and prose: both visible in `read`/`dump`. Use `--replace-all` for a full rewrite, or `delete` + `insert --raw-file` for a structural replacement.\n" +
          "- `set --find` from a surrounding layout stops at the whole inset, so it never reaches prose or data inside; `insert split-after` descends into an inset only to reach a nested layout's prose, never the data.\n" +
          "- An inline formula is a whole-inset unit: `\\begin_inset Formula $...$` keeps its payload on the opening line, not in text nodes, so `--find` cannot reach it and `--replace-all` rewrites only the children, not that line. Replace it with `delete` + `insert --raw-file`.\n\n" +
          "- Tracked whole-inset operations stay atomic: deletion and insertion markers wrap the whole inset in the layout that carries it, never inside its metadata.\n" +
          "- An inset nested directly under another inset (for example a `Text` inset inside a `Tabular` cell) has no layout to carry deletion markers, so a tracked deletion of it is rejected.",
      ),
    ],
    furtherReading: [
      fr("model/cst", "block and child structure"),
      fr("concepts/mutations", "every-match mutation rules"),
      fr("commands/insert", "inset generation helpers"),
      fr("commands/set", "tracked versus untracked inset edits"),
      fr("concepts/tracked-changes", "atomic tracking rules"),
      fr("commands/delete", "whole-inset deletion"),
      fr("concepts/private-notes", "note insets"),
      fr("concepts/selectors", "inset selectors"),
    ],
  },
  {
    id: "concepts/mutations",
    title: "every-match mutation rules and safety",
    sections: [
      sec(
        "Every match is edited",
        "The mutation commands are `set`, `delete`, `insert`, and `undo`.\n\n" +
          "A mutation applies to every node matched by its selector. `insert` duplicates its payload for every match. `set` and `delete` can affect the entire document if the selector is too broad. Replay `undo` reverts the current author's tracked changes in every matched block that has them.\n\n" +
          "When a mutation matches more than one node, the command proceeds but includes a blast-radius warning.\n" +
          "A mutation whose selector matches nothing is a hard error: it exits non-zero and writes nothing.\n" +
          "To avoid the surprise, check the selector's blast radius before mutating with `read --count`.",
      ),
    ],
    furtherReading: [
      fr("model/guarantees", "validation and commit guarantees"),
      fr("concepts/selectors", "selector reach and scoping"),
      fr("concepts/tracked-changes", "reviewable mutation behavior"),
      fr("commands/undo", "snapshot and replay reach"),
      fr("commands/set", "tracked replacement"),
      fr("commands/delete", "tracked deletion"),
      fr("commands/insert", "tracked insertion"),
    ],
  },
  {
    id: "concepts/tracked-changes",
    title: "change regions and tracked behavior",
    sections: [
      sec(
        "Tracked changes",
        "Tracked changes record each mutation as a reviewable edit attributed to the configured author:\n\n" +
          "- `set`: marks the old text as `change_deleted` and the new text as `change_inserted`;\n" +
          "- `delete`: marks the selected content as `change_deleted`;\n" +
          "- `insert`: marks the new content as `change_inserted`;\n" +
          "- replay `undo`: removes the configured author's tracked change markers.\n\n" +
          "These markers are LyX properties. They delimit tracked regions — runs of text in one change state. A marker value records an author ID and timestamp: `\\change_<type> <author ID> <timestamp>`.\n\n" +
          "A region closes at the next marker because LyX keeps one active change per position: a region opened by `change_deleted` is closed when the next region, opened by `change_inserted`, begins, with no `change_unchanged` between them. `change_unchanged` ends the open region and returns to current text.\n\n" +
          "A tracked mutation also adds or updates the document header's tracking state and author table. A header-less document cannot safely receive tracked markers and is rejected before mutation.",
      ),
      sec(
        "Locating tracked changes",
        "Tracked changes split text into three regions: `current`, `inserted`, and `deleted`. `:change(current|inserted|deleted)` selects nodes by region. Combining these regions shows:\n\n" +
          "- `current` + `inserted` = the document with the change applied;\n" +
          "- `current` + `deleted` = the document with all changes rejected;\n" +
          "- `deleted` + `inserted` = the change itself.",
      ),
      sec(
        "Reading tracked changes",
        "By default, `read` and `dump` output annotate tracked text with its change status, and `--text-only` emits inline change markers (`\\change_deleted{...}` / `\\change_inserted{...}`) so current and rejected text stay distinguishable. Note prose follows the private-note visibility rule.",
      ),
      sec(
        "Editing tracked changes",
        "Mutations see all text by default, including rejected text. This makes locating and editing consistent: a selector can locate a node by text and `--find` can operate on the same text. `:change()` then narrows the operation when the same phrase occurs in multiple regions: `lq set document.lyx \"text:change(current)\" \"new phrase\" --find \"old phrase\"`.\n\n" +
          "Tracked changes are flat: LyX cannot represent one change region nested inside another. When a replacement targets text inside `change_deleted`, `lq` therefore preserves the rejected text and inserts the replacement as an adjacent new tracked change instead of nesting it inside the deleted region. The rejected region keeps its original author, so another author's replay undo removes only their own adjacent insertion and cannot silently resurrect the rejection.\n\n" +
          "Tracked full-text `set` (plain or `--replace-all`) follows LyX's per-position overwrite model rather than wiping the children: rejected regions survive, same-author pending insertions are consumed, and another author's pending insertions are re-authored as the current author's deletions.\n\n" +
          "A tracked plain `set` keeps the inline properties around the replaced text inside `\\change_deleted`, so rejecting the change restores the original formatting; an untracked one drops them, leaving no dead markup.\n\n" +
          "Change markers are only valid inside a layout's text. Inset metadata is not trackable — a table's column alignment, for example, cannot carry a change marker, so treat a complex inset as an atomic structure. With tracking on, a mutation targeting preamble lines, `#` comments, header text, or inset metadata is rejected; disable tracking for those surfaces or target a layout's text instead.",
      ),
    ],
    furtherReading: [
      fr("model/guarantees", "LyX format constraints"),
      fr("concepts/selectors", "region matching semantics"),
      fr("commands/set", "tracked replacement"),
      fr("commands/delete", "tracked deletion"),
      fr("commands/insert", "tracked insertion"),
      fr("commands/undo", "replay and snapshot restore"),
      fr("concepts/insets", "what cannot be tracked"),
      fr("concepts/private-notes", "note prose visibility"),
    ],
  },
  {
    id: "concepts/selectors",
    title: "selector syntax and reach",
    sections: [
      sec(
        "Tags",
        "Selectors are CSS-like expressions used to locate nodes in the Concrete Syntax Tree (CST) and may select multiple nodes at once. They may deviate from CSS convention to better serve LyX.\n\n" +
          "Structural tags for block and property nodes. Use with an optional bracket argument. Valid argument values can be discovered with `lq schema`.\n\n" +
          "- `layout[...]` takes a document layout from `documentLayouts` or an inset layout from `insetLayouts`\n" +
          "- `inset[...]` takes an inset type from `insets`\n" +
          "- `inset[CommandInset ...]` takes a CommandInset subtype from `commandInsetSubtypes`\n" +
          "- `property[...]` takes an inline property key from `inlineProperties`\n\n" +
          "Content tag for text nodes:\n\n" +
          "- `text`: prose, raw inset payload, preamble data, file `#` comments, or metadata text depending on the owner.",
      ),
      sec(
        "Combinators",
        "- A space selects descendants: `layout[Standard] inset[Formula]` finds a Formula inside a Standard paragraph. Because normal document layouts are flat siblings, a descendant query is usually useful for insets or text inside a layout, not for finding later paragraphs in a section.\n" +
          "- A tilde `~` selects matching siblings after an anchor, including nodes nested in their subtrees: `layout[Section] ~ layout[Standard]` matches all Standard layouts after a Section, running to the end of the document.\n" +
          "- A comma `,` selects the union of multiple selector arms: `layout[Section], inset[Foot]` matches all Section and Foot layouts.",
      ),
      sec(
        "Pseudo-classes",
        "Pseudo-classes are node predicates and must follow a tag. Each is a true/false filter that keeps only nodes matching its condition. Chain several pseudo-classes to narrow selection further.\n\n" +
          "Pseudo-classes fall into two kinds.\n\n" +
          "- `:contains()`, `:not()`, `:change()`, `:property()`, and `:note()` match each node independently, so their order in a chain does not matter.\n" +
          "- Positional filters `:first`, `:last`, `:nth-match()`, `:adjacent()`, and `:until()` filter the matched sequence and apply in the order written, so chaining order matters.\n\n" +
          "`:contains(text)`\n\n" +
          "`:contains()` searches recursively and case-sensitively through descendant text, including inset metadata and tracked changes, to locate a layout by text. A private note's content is found only when the selector is note-scoped.\n\n" +
          "Example: `layout[Standard]:contains(some phrase)` selects the Standard paragraphs whose text contains the phrase.\n\n" +
          "`text:contains(...)` never matches: text nodes are not returned for `:contains` (lq would otherwise mutate each matched text node twice), so that selector form always yields an empty match. lq warns when a selector contains this dead arm.\n\n" +
          "The text may be given bare, or quoted with either single (`'...'`) or double (`\"...\"`) quotes. The quotes are stripped by the parser and exist only to allow a literal `'`, `\"`, `(`, or `)` inside the phrase. Prefer double quotes when the phrase itself contains an apostrophe.\n\n" +
          "`:not(selector)`\n\n" +
          "`:not()` excludes a block whose subtree contains a match of the inner selector. A `:contains()` inner also matches the block's own text, so `:contains(x)` and `:not(:contains(x))` partition the document.\n\n" +
          "Example: `layout[Standard]:not(inset[Formula])` selects the Standard paragraphs that do not contain a Formula inset.\n\n" +
          "Text and property nodes have no descendants, so they always pass.\n\n" +
          "`:change(region)`\n\n" +
          "`:change(current|inserted|deleted)` filters nodes by tracked-change region: text nodes match their own region, and layouts and insets match when they sit in the parent's region or contain text in the requested region, including prose inside nested layouts of an atomically tracked inset.\n" +
          "Private-note prose is visible.\n" +
          "Property nodes and inset metadata do not match.\n\n" +
          "Example: `layout:change(deleted), inset:change(deleted)` selects the layouts and insets that sit in the deleted region or contain deleted text.\n\n" +
          "`:change()` also scopes `set --find` and `split-after`, so a phrase present in multiple regions can be disambiguated. Example: `set \"text:change(current)\" \"new phrase\" --find \"old phrase\"` replaces `old phrase` only in current text; `insert \"layout:change(deleted)\" split-after \"some phrase\" --text \"!\"` splits a paragraph inside its deleted region.\n\n" +
          "`:property(key[=value])`\n\n" +
          "`:property(key[=value])` filters nodes under an inline style state: text nodes match by their own style, and layouts and insets match when they sit in the parent's style span or contain styled text, including prose inside nested layouts.\n" +
          "Without `=value`, any non-default value for the key matches; with `=value`, the comparison is case-insensitive and exact.\n" +
          "Private-note prose is visible.\n" +
          "Change markers and inset metadata do not match.\n\n" +
          "Example: `text:property(emph)` filters the text that is currently emphasized.\n" +
          "`:property()` also scopes `set --find` and `split-after`, so a phrase in a specific style span can be targeted.\n\n" +
          "`:note([Note|Comment])`\n\n" +
          "`:note()` matches nodes inside a private note (`Note Note` / `Note Comment`) or the note inset itself. Bare `:note` = any private note; `:note(Note)` / `:note(Comment)` = a specific type.\n\n" +
          "Example: `text:note` selects the text nodes inside a private note, and `layout:note:contains(some phrase)` selects the note-scoped layouts whose text contains the phrase.\n\n" +
          "A `:note` part also makes its `,` group note-scoped on the content axis: content matching — `set --find` and `split-after` included — sees note prose, so `text, text:note` is \"visible text + note text\". An explicit `inset[Note …]` path (e.g. `inset[Note Note] layout[Plain Layout]`) is equally note-scoped.\n\n" +
          "`:first` and `:last`\n\n" +
          "These filter the matches in query traversal order.\n\n" +
          "Example: `layout[Section]:first` selects the first Section heading, and `layout[Standard]:last` selects the last Standard paragraph.\n\n" +
          "`:nth-match(an+b)`\n\n" +
          "This filters the matches in query traversal order. Use CSS-style formulas such as `:nth-match(2)`, `:nth-match(odd)`, `:nth-match(even)`, or `:nth-match(2n+1)`.\n\n" +
          "Example: `layout[Section]:nth-match(2)` selects the second Section heading — the second match.\n\n" +
          "`:adjacent(selector)`\n\n" +
          "`:adjacent()` matches a node whose immediately preceding meaningful sibling matches the inner selector.\n\n" +
          "Example: `layout[Standard]:adjacent(layout[Quote])` selects the Standard paragraphs that directly follow a Quote layout.\n\n" +
          "Text and property nodes between the siblings are skipped: the CST interleaves blank-line text nodes between sibling layouts, so adjacency is judged between blocks, not literal child positions.\n\n" +
          "`:until(selector)`\n\n" +
          "`:until()` bounds a `~` sibling range. It rejects a candidate when any node matching the inner selector appears in document order between the anchor and the candidate, inclusive. So the range stops before the next matching node, and that boundary node, its subtree, and everything after it are excluded.\n\n" +
          "Example: `layout[Section]:contains(some phrase):first ~ layout[Standard]:until(layout[Section])` selects the Standard paragraphs between the first section that contains `some phrase` and the next section, stopping before the next section's heading.\n\n" +
          "The check also covers descendant candidates: a bare arm such as `layout[Section]:contains(some phrase):first ~ layout:until(layout[Section])` stops the whole subtree before the next heading, so the next section's heading and its content are not pulled in.\n\n" +
          "`:until()` is a no-op without `~`: Read-only commands (`read` / `dump`) still run and warn that the bound is ignored; mutations (`set` / `delete` / `insert` / replay `undo`) reject the selector and make no change.",
      ),
      sec(
        "Selector scope for mutations",
        "The selector has two roles:\n\n" +
          "1. it chooses the nodes to operate on; and\n" +
          "2. its `:change()`, `:property()`, and `:note()` predicates define which text the search sees — the text scope for `set --find` and `split-after`.\n\n" +
          "Scope composition follows the selector:\n\n" +
          "- comma-separated arms form a union;\n" +
          "- chained predicates form an intersection;\n" +
          "- an unscoped arm means that arm can see all text;\n" +
          "- a `:note` part makes its scope see private-note prose; a target inside a note is in scope regardless.\n\n" +
          "Examples: `text:change(current), text:change(deleted)` includes current and deleted text but excludes inserted text; `text:change(current):property(emph)` requires both the current region and active emphasis.",
      ),
    ],
    furtherReading: [
      fr("model/cst", "node types and scale"),
      fr("concepts/mutations", "every-match mutation rules"),
      fr("concepts/private-notes", "visibility axes"),
      fr("commands/read", "selector inspection"),
      fr("commands/schema", "valid tag argument values"),
      fr("concepts/tracked-changes", "region matching"),
    ],
  },
  {
    id: "commands/init",
    title: "initialize or view configuration",
    sections: [
      sec(
        "Purpose",
        "lq init - Initialize or view local or global configuration.",
      ),
      sec(
        "Usage",
        "  lq init [--global]             Read or create '.lq/config.json' if missing.\n" +
          "  lq init [options] [--global]   Create or update the selected config with the given options.",
      ),
      sec(
        "Options",
        "  --layouts-dir <path>      Set the LyX layouts directory.\n" +
          "                            Default: auto-detect the highest installed version.\n" +
          "  --refresh <mode>          Configure automatic refresh after mutations.\n" +
          "                            none (default): no refresh; LyX detects changes via polling.\n" +
          "                            reload:         reload and discard unsaved in-LyX edits.\n" +
          "                                            Best effort: if LyXServer is unreachable,\n" +
          "                                            the file is still written and the skipped\n" +
          "                                            reload is reported as a warning.\n" +
          "                            save-reload:    save unsaved edits first, then reload.\n" +
          "                                            aborts before writing if LyXServer is\n" +
          "                                            genuinely unreachable.\n" +
          "  --track-changes <on|off>  Enable or disable tracked changes for mutation commands.\n" +
          "                            Default: on.\n" +
          "  --author-name <name>      Author name recorded on new tracked changes.\n" +
          "                            Default: \"lq user\".\n" +
          "  --max-cache-entries <n>   Maximum cached parse results kept in the selected\n" +
          "                            state's cache/ directory. Must be a complete\n" +
          "                            non-negative integer.\n" +
          "                            Default: 50.",
      ),
      sec(
        "State scope",
        "  Commands use the nearest ancestor containing '.lq' as local state. If no local marker\n" +
          "  exists, they use the global '<host-native-home>/.lq' state. Local config, cache, and undo\n" +
          "  are strictly isolated from global state. '--global' changes only the init\n" +
          "  target; all other options apply to either scope.",
      ),
      sec(
        "Config precedence",
        "  New config: built-in defaults, then explicit options.\n" +
          "  Existing config: existing values, then explicit options; omitted values\n" +
          "  persist, including 'layoutsDir'.\n\n" +
          "Setting a non-'none' refresh mode runs a fast reachability probe; a probe\n" +
          "warning does not abort init. On Windows, LyXServer can lose a response even\n" +
          "after dispatch, so an unconfirmed save proceeds with a warning rather than\n" +
          "aborting.",
      ),
    ],
    furtherReading: [
      fr("concepts/state-scope", "state selection and artifacts"),
    ],
  },
  {
    id: "commands/schema",
    title: "valid layouts and properties for a document class",
    sections: [
      sec(
        "Purpose",
        "lq schema - Return the semantically valid layouts and properties for a document's class.",
      ),
      sec(
        "Usage",
        "  lq schema <file>",
      ),
      sec(
        "Arguments",
        "  <file>      The path to the .lyx file.",
      ),
      sec(
        "Output",
        "The response's 'data' contains six categories:\n" +
          "  documentLayouts      Styles valid for this document class (e.g. Section, Standard).\n" +
          "  insetLayouts         Layouts valid inside insets (e.g. Plain Layout).\n" +
          "  insets               Valid inset types (e.g. Formula, Foot, CommandInset).\n" +
          "  commandInsetSubtypes Valid CommandInset subtypes (e.g. citation, ref, label).\n" +
          "  inlineProperties     Valid inline property keys (e.g. family, lang).\n" +
          "  headingHierarchy     Heading layouts with their TocLevel values.\n\n" +
          "The document's 'textclass' (e.g. article, book) selects the matching .layout\n" +
          "file from the configured layouts directory, or from the highest installed LyX\n" +
          "version auto-detected at runtime.",
      ),
    ],
    furtherReading: [
      fr("model/cst", "valid values for each node tag"),
    ],
  },
  {
    id: "commands/dump",
    title: "output the document structure",
    sections: [
      sec(
        "Purpose",
        "lq dump - Output the document structure.",
      ),
      sec(
        "Usage",
        "  lq dump <file> [<selector>] [options]\n" +
          "  lq dump <file> [options] --toc   Output a hierarchical heading tree instead\n" +
          "                                   of the raw CST. Heading levels come from the\n" +
          "                                   document class's .layout file (standard LaTeX\n" +
          "                                   hierarchy as fallback).",
      ),
      sec(
        "Arguments",
        "  <file>      The path to the .lyx file.\n" +
          "  <selector>  A CSS-like selector.\n" +
          "              Omit or structural selectors: dump the CST from root or matched structural nodes.\n" +
          "              Tracked changes are annotated, private-note nodes are visible.\n" +
          "              Bare text selector: dump the matched text nodes, excluding\n" +
          "              private-note prose unless note-scoped.",
      ),
      sec(
        "Options",
        "  --depth <n> Limit the output depth. Meaning depends on the mode:\n" +
          "              - Raw CST: parse-tree nesting. 0 = root node only; 1 = direct\n" +
          "                children; N = descend N levels. Omit for full depth.\n" +
          "              - With --toc: absolute LyX TocLevel up to any integer\n" +
          "                (Section is typically 1). Use an equal sign to pass a negative\n" +
          "                value for shell safety (e.g. --depth=-1). Insets are omitted\n" +
          "                from heading text.",
      ),
      sec(
        "Large output",
        "Output is several times larger than the .lyx file, and large output is\n" +
          "truncated by the terminal. Check the file size first and zoom in with a\n" +
          "narrower selector or `--depth` for large documents.",
      ),
    ],
    furtherReading: [
      fr("model/cst", "CST structure"),
      fr("concepts/private-notes", "note nodes in CST and TOC views"),
    ],
  },
  {
    id: "commands/read",
    title: "output matching nodes and text content",
    sections: [
      sec(
        "Purpose",
        "lq read - Output matching nodes and text content.",
      ),
      sec(
        "Usage",
        "  lq read <file> <selector>             Structural selectors: return the matched\n" +
          "                                        CST nodes with the match count; tracked\n" +
          "                                        text is annotated, private-note nodes are\n" +
          "                                        visible. Bare text selector: return the\n" +
          "                                        matched text nodes, excluding private-note\n" +
          "                                        prose unless note-scoped.\n" +
          "  lq read <file> <selector> [options]   Options alter the output as described\n" +
          "                                        below.",
      ),
      sec(
        "Arguments",
        "  <file>      The path to the .lyx file.\n" +
          "  <selector>  A CSS-like selector.\n" +
          "              A selector with no matches is an empty result, not an error.",
      ),
      sec(
        "Options",
        "  --count     Return match counts grouped by node label (tag[args]).\n" +
          "              A text count counts runs, not paragraphs.\n" +
          "  --text-only Output the text content of each matched node with structural\n" +
          "              annotations, separated by a double newline. Matched block nodes\n" +
          "              get a tag[args] prefix, insets appear as inline markers\n" +
          "              (e.g. inset[Foot]), and tracked changes appear as\n" +
          "              '\\change_deleted{...}' / '\\change_inserted{...}'.",
      ),
      sec(
        "Large output",
        "Output is several times larger than the .lyx file, and large output is\n" +
          "truncated by the terminal. Check the file size first and zoom in with a\n" +
          "narrower selector or `--count` for large documents.",
      ),
    ],
    furtherReading: [
      fr("model/cst", "CST node types and scale"),
      fr("concepts/selectors", "selector syntax"),
      fr("concepts/private-notes", "visible and note content"),
    ],
  },
  {
    id: "commands/bib",
    title: "extract references from the bibliography",
    sections: [
      sec(
        "Purpose",
        "lq bib - Extract references with key, author, title, and year from the bibliography.",
      ),
      sec(
        "Usage",
        "  lq bib <file> [options]",
      ),
      sec(
        "Arguments",
        "  <file>      The path to a .lyx document with linked .bib files or the path to a .bib file.",
      ),
      sec(
        "Options",
        "  --search <text>\n" +
          "              Filter references by a case-insensitive substring match across\n" +
          "              key, author, title, and year. Multiple words are ANDed.\n" +
          "              Omit for all references.",
      ),
    ],
    furtherReading: [],
  },
  {
    id: "commands/set",
    title: "overwrite targeted nodes with new text",
    sections: [
      sec(
        "Purpose",
        "lq set - Overwrite the targeted nodes with new text content.",
      ),
      sec(
        "Usage",
        "  lq set <file> <selector> <new text>                     Replaces each matched node's content and\n" +
          "                                                          inline properties:\n" +
          "                                                          a layout's direct text (insets preserved),\n" +
          "                                                          a text node's whole text, or a property's\n" +
          "                                                          value.\n" +
          "  lq set <file> <selector> <new text> --find <substring>  Replace all case-sensitive occurrences of\n" +
          "                                                          <substring> within the matched nodes' content.\n" +
          "                                                          Can match across text-node boundaries (e.g.\n" +
          "                                                          tracked change or style) but cannot cross\n" +
          "                                                          an inset.\n" +
          "  lq set <file> <selector> <new text> --replace-all       Replace ALL children of the target block,\n" +
          "                                                          not just text nodes.",
      ),
      sec(
        "Arguments",
        "  <file>      The path to the .lyx file.\n" +
          "  <selector>  A CSS-like selector.\n" +
          "  <new text>  The new text content to apply to the matched nodes.",
      ),
      sec(
        "Safety",
        "A default `set` on an inset is rejected because it would destroy the inset's\n" +
          "structure (e.g. wiping `LatexCommand` and `name` lines).\n" +
          "With tracking on, editing inset metadata is rejected.",
      ),
    ],
    furtherReading: [
      fr("concepts/tracked-changes", "tracked replacement"),
      fr("concepts/selectors", "text scope for --find"),
      fr("concepts/mutations", "every-match mutation rules"),
    ],
  },
  {
    id: "commands/delete",
    title: "delete targeted nodes",
    sections: [
      sec(
        "Purpose",
        "lq delete - Delete targeted nodes. Each matched node is deleted as a unit — a block's whole subtree goes with it.",
      ),
      sec(
        "Usage",
        "  lq delete <file> <selector>",
      ),
      sec(
        "Arguments",
        "  <file>      The path to the .lyx file.\n" +
          "  <selector>  A CSS-like selector.",
      ),
    ],
    furtherReading: [
      fr("concepts/tracked-changes", "tracked deletion"),
      fr("concepts/mutations", "every-match mutation rules"),
    ],
  },
  {
    id: "commands/insert",
    title: "insert new blocks or properties",
    sections: [
      sec(
        "Purpose",
        "lq insert - Insert new blocks or properties relative to a selector.",
      ),
      sec(
        "Usage",
        "  lq insert <file> <selector> split-after <match> --text <content>\n" +
          "              Splices bare text inline into the target block\n" +
          "  lq insert <file> <selector> <position> --layout <name> --text <content>\n" +
          "              Insert a layout block with the given name and text.\n" +
          "              Position cannot be 'split-after'.\n" +
          "  lq insert <file> <selector> <position> --cite <key> [--cite-cmd <cmd>]\n" +
          "              Insert a CommandInset citation. --cite-cmd: citet\n" +
          "              (default), cite, citep, citeauthor, citeyear, citeyearpar,\n" +
          "              citebyear, footcite, autocite, citetitle, fullcite, footfullcite,\n" +
          "              nocite, keyonly.\n" +
          "  lq insert <file> <selector> <position> --ref <label> [--ref-cmd <cmd>]\n" +
          "              Insert a CommandInset cross-reference. --ref-cmd:\n" +
          "              ref (default), eqref, pageref, vpageref, vref, nameref, formatted,\n" +
          "              labelonly.\n" +
          "  lq insert <file> <selector> <position> --label <name>\n" +
          "              Insert a CommandInset label with the given name.\n" +
          "  lq insert <file> <selector> <position> --footnote <text>\n" +
          "              Insert a Foot inset containing a Plain Layout with <text>.\n" +
          "  lq insert <file> <selector> <position> --raw-file <path>\n" +
          "              Read raw LyX syntax from a file, parse it into CST nodes, validate,\n" +
          "              and insert.",
      ),
      sec(
        "Arguments",
        "  <file>      The path to the .lyx file.\n" +
          "  <selector>  A CSS-like selector.\n" +
          "  <position>  Where to insert relative to each matched target:\n" +
          "              'before' / 'after'    Insert a block as a sibling of the target:\n" +
          "                                    a layout next to a layout, or an inline\n" +
          "                                    inset next to a node inside a layout.\n" +
          "              'prepend' / 'append'  Insert a block as a child of the target block:\n" +
          "                                    an inset inside a layout, or a nested layout\n" +
          "                                    inside an inset.\n" +
          "              'split-after <match>' Split the target block's prose right after the\n" +
          "                                    exact, case-sensitive <match> substring and\n" +
          "                                    insert at that point. The <match> must appear\n" +
          "                                    exactly once in the matched prose; a missing\n" +
          "                                    or repeated match is rejected. Reaches prose\n" +
          "                                    recursively in nested layouts, including\n" +
          "                                    tracked changes but excluding private notes\n" +
          "                                    unless note-scoped; inset metadata stays\n" +
          "                                    opaque.",
      ),
    ],
    furtherReading: [
      fr("concepts/insets", "inset structure and helpers"),
      fr("concepts/tracked-changes", "tracked insertion"),
    ],
  },
  {
    id: "commands/undo",
    title: "revert edits",
    sections: [
      sec(
        "Purpose",
        "lq undo - Revert edits.",
      ),
      sec(
        "Usage",
        "  lq undo <file>                         Snapshot restore (1-level, any mutation).\n" +
          "                                         Consumes the snapshot in the selected local\n" +
          "                                         or global state to revert the last (tracked\n" +
          "                                         or plain) mutation as one unit; restores\n" +
          "                                         the saved document state by path.\n\n" +
          "  lq undo <file> <selector> [<substring>]\n" +
          "                                         Replay undo (unlimited levels). Removes the\n" +
          "                                         tracked-change blocks made by the current author\n" +
          "                                         as the direct children of the matched block nodes;\n" +
          "                                         with <substring>, only blocks whose text contains it.\n" +
          "                                         Can be reverted by snapshot restore.",
      ),
      sec(
        "Arguments",
        "  <file>       The path to the .lyx file.\n" +
          "  <selector>   A CSS-like selector.\n" +
          "  <substring>  Text inside the change_deleted or change_inserted block to revert.",
      ),
      sec(
        "Replay targets block nodes",
        "Replay undo targets block nodes: a selector that matches only text or property\n" +
          "nodes, or a block whose changes sit inside a nested inset, is corrected with a\n" +
          "warning and reverts nothing.",
      ),
    ],
    furtherReading: [
      fr("concepts/state-scope", "snapshot storage"),
      fr("concepts/tracked-changes", "replay semantics"),
    ],
  },
];

/** The home page (id "home"), reached by `lq help` and `lq --help`. */
export const HOME_PAGE: HelpPage = HELP_PAGES[0];

const PAGES_BY_ID = new Map(HELP_PAGES.map((p) => [p.id, p]));

/** Look up a page by its full prefixed ID, e.g. "commands/read". */
export function findPage(id: string): HelpPage | undefined {
  return PAGES_BY_ID.get(id);
}

/** Resolve a `lq help <page>` reach (e.g. "read", "cst") to its page. */
export function findByReach(reach: string): HelpPage | undefined {
  return HELP_PAGES.find((p) => reachOf(p.id) === reach);
}

/** Resolve `lq <command> --help` (e.g. "read") to its command page. */
export function findByAlias(alias: string): HelpPage | undefined {
  return HELP_PAGES.find((p) => aliasOf(p.id) === alias);
}

/** The non-home pages, grouped for the home page map. */
export function groupedPages(): { group: PageGroup; pages: HelpPage[] }[] {
  const order: PageGroup[] = ["model", "concepts", "commands"];
  return order.map((group) => ({
    group,
    pages: HELP_PAGES.filter((p) => groupOf(p.id) === group),
  }));
}
