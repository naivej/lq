---
name: use-lq
description: Use lq to parse, query, and mutate LyX documents (`.lyx` files). Use the LyX CLI to create, import, or export the documents, and open the LyX GUI to establish a LyXServer connection.
allowed-tools: Bash(lq *)
---

Run `lq help` for the authoritative manual of how to parse, query, and mutate LyX documents.

# Mental model

Three ideas carry the whole skill:

- **Source, not LaTeX.** `lq` edits LyX syntax; LyX owns import, export, compilation, and PDF. Formula, ERT, and preamble payloads are opaque strings — target the inset, never parse the LaTeX inside it.
- **Reach, not recursion.** A selector can *match* recursively while a mutation *changes* only what the command can reach. Layouts are flat siblings; text splits at every state boundary; inset metadata stays opaque. Never infer mutation reach from selector reach.
- **Fail closed, reported separately.** A hard error exits non-zero and writes nothing. File outcome, LyXServer dispatch, and confirmation are separate facts; warnings can accompany a committed file.

# Operating loop

Run the same sequence for every task:

1. **Set the task's author name first.** `lq init --author-name "<task>"` before the first mutation, and switch when the task changes. Replay undo is author-scoped, so each task's edits stay separately revertible. Name the task, not the human.
2. **Inspect configuration.** `lq init` shows the selected scope and config — `trackChanges`, `authorName`, `layoutsDir`, `refresh`. Change configuration only with authorization. See the state-scope note below.
3. **Zoom in.** Output is several times larger than the file, so start broad only when the result is small: `ls -l` → outline (`dump --toc`) → count (`--count`) → text-only on the narrowed result. Done when you can see the exact node(s) you will touch.
4. **Check the schema** when the class or insertion context is unfamiliar (`lq schema <file>`) — a Beamer document permits layouts an article does not.
5. **Check the blast radius.** `lq read <file> "<selector>" --count` before mutating; read the type breakdown, not just the total. Done when the count matches the intended composition.
6. **Mutate minimally.** Every match is edited — `insert` duplicates its payload per match, broad `set`/`delete` can rewrite the document. Prefer a unique anchor and the smallest scale that expresses the workflow.
7. **Verify immediately.** Read the same selector back (`--text-only` or `--count`), inspect the JSON warnings, review `git diff`; export with LyX for high-risk changes. Done when the read-back matches the intent and the diff shows only it.

Work inside Git when possible: stage before mutating, review the staged diff. There is no `--dry-run`; counts, schema, Git, and snapshots are the safety workflow. Rollback by intent:

- `git restore` — broad rollback to a committed or staged state.
- `lq undo <file>` — snapshot restore; reverts the last mutation as one unit, restoring deleted nodes.
- `lq undo <file> <selector> [<substring>]` — replay; reverts the current author's tracked changes in matched blocks, so per-task rollback.

**State scope.** The nearest ancestor containing `.lq` supplies local config, cache, and undo; without one, `lq` uses the global `<host-native-home>/.lq`. Local state is isolated from global — use `lq init --global` only to inspect or change profile-wide defaults. After a local init, add the generated `.lq/` to `.gitignore` (config, cache, and undo snapshots are machine and workflow state, not source); version `.lq/config.json` only when the project wants to share configuration.

# Query recipes

| Goal | Command |
| --- | --- |
| See the document outline | `lq dump file.lyx --toc` |
| Get section headings | `lq read file.lyx "layout[Section]" --text-only` |
| Read body under a section | `lq read file.lyx "layout[Section]:contains(Theory):first ~ layout:until(layout[Section])" --text-only` |
| Count a broad section range | `lq read file.lyx "layout[Section]:contains(Theory):first ~ layout:until(layout[Section])" --count` |
| Find a paragraph | `lq read file.lyx "layout:contains(unique phrase)" --text-only` |
| Find by multiple words | `lq read file.lyx "layout:contains(climate):contains(policy)" --text-only` |
| Get the first paragraph in a section | `lq read file.lyx "layout[Section]:contains(Intro):first ~ layout[Standard]:until(layout[Section]):first" --text-only` |
| Traverse multiple heading ranges | `lq read file.lyx "layout[Section] ~ layout[Subsection]:contains(Methods) ~ layout[Standard]:until(layout[Section])" --text-only` |
| Exclude footnotes | `lq read file.lyx "layout[Standard]:not(inset[Foot]):until(layout[Section])" --text-only` |
| Find a paragraph after a quote | `lq read file.lyx "layout[Standard]:until(layout[Section]):adjacent(layout[Quote])" --text-only` |
| Check selector blast radius | `lq read file.lyx "<selector>" --count` |
| Inspect exact CST | `lq read file.lyx "<precise selector>"` |
| Deep-debug a node | `lq dump file.lyx "<selector>"` |
| Find a citation key | `lq bib file.lyx --search "keyword"` |
| Restore the last mutation | `lq undo file.lyx` |
| Replay all direct tracked changes by the current author | `lq undo file.lyx "<block selector>"` |
| Replay one matching tracked change | `lq undo file.lyx "<block selector>" "bad text"` |

`Section` and `Standard` layouts are siblings under the body, not parent-child. For a section range, anchor on unique heading text and put `:first` before the `~`: `:contains()` is recursive, so a common heading word can anchor on an unintended node and expand the range. `:until()` is exclusive of its boundary, so the bare `~ layout:until(layout[Section])` form is safe once the anchor is unique; prefer the scoped `layout[Standard]:until(...)` form for paragraph ranges.

Bare `text` takes no bracket argument (`text[...]` is rejected) and excludes private-note prose; `text:change(...)` and `text:property(...)` are the state-oriented views and can see note prose. An inset's content: `inset[...]` is the full raw content (parameters, `status`, prose); `inset[...] layout[...] --text-only` is the prose alone; a note's prose is `inset[Note Note] layout[Plain Layout] --text-only`.

Token discipline for large documents: prefer `--count` over `--text-only` when a selector may match many nodes; use `dump --toc` instead of a full CST dump; use a unique anchor and `:first` rather than post-processing a large result in context; narrow a large `.bib` with `lq bib --search`, not a full dump.

# Workflows by task

Pick the workflow up front — it chooses the author name, the selection scale, and the mutation style.

## Ground-up writing and autonomous drafting

Structural work. Set the per-task author name so the whole draft is one review unit, check `lq schema`, and confirm the layouts directory resolves. Build the skeleton first — headings and blocks with `insert --layout` — then fill in with `--text`, `split-after`, and `--raw-file` for citations, references, and math. Verify each section with `read --text-only`; run a LyX export at milestones as the structural acceptance check.

## Proofreading and surgical typo fixes

The goal is the minimum footprint: read the exact phrase first, then replace only the changed substring. Two facts decide whether a surgical edit is practical:

- `set --find` replaces the substring **everywhere it appears in the matched scope** — there is no "second occurrence" targeting. The minimal-touch trick works when the changed substring is unique in scope; a common word such as `the` is not.
- The location is pinned by the selector scope and the match string together. The practical question is always: can I make the changed substring unique in scope, or do I accept a longer match?

Pinning the location:

1. **Pin the paragraph first with a unique phrase.** `lq read file.lyx "layout:contains(<unique phrase>)" --text-only`, adding `:first` or `:nth-match(n)` when the phrase repeats. `--find` then operates inside that paragraph only — never inside its nested insets.
2. **A short substring is usually unique once the scope is one paragraph.** `12345` → `12435` by replacing just `34` with `43`:

   ```bash
   lq set file.lyx "layout:contains(12345)" "43" --find "34"
   ```

   With tracking on the diff is exactly `\change_inserted{43}\change_deleted{34}` — two digits, not a whole rewritten number.
3. **When the word is common even inside the paragraph**, lengthen the match with context and replace the whole phrase (`--find "the quick brown" "the lazy brown"`); the changed unit is the phrase, not the word. Case-sensitivity is a free disambiguator (`the` ≠ `The`); scope with `:change(...)` / `:property(...)` when the ambiguity is between regions or style spans.
4. **Read the occurrence count.** `--find` reports how many occurrences it matched in its result warning; a count larger than expected means the scope is too broad, and `lq undo file.lyx` reverts the over-match as one unit.
5. **Respect the limits.** `--find` swaps one contiguous substring; a non-contiguous change needs two passes or a full `set` — which rewrites the whole matched node, never for a one-token fix. If the match stays ambiguous even with context, split the operation or edit the whole node.

When every occurrence should change — a terminology or style pass over a section — every-match is the desired behavior, not a hazard; just confirm the scope with `--count` first.

## Draft review and paragraph-level revision

Review at the paragraph scale: read a section range (`layout[Section]:contains(Intro):first ~ layout[Standard]:until(layout[Section]) --text-only`) so prose, structure, and tracked markers stay together. Rewrite a paragraph with a tracked `set` on the layout — old paragraph in `change_deleted`, new in `change_inserted`, insets preserved — and use `--replace-all` only for deliberate structural rewrites. Because the review pass has its own `--author-name`, `lq undo file.lyx "<section selector>"` later reverts exactly the reviewer's edits and leaves the author's tracked changes intact; `lq read file.lyx "text:change(current), text:change(deleted)" --text-only` shows the diff-style review view.

# Reference: reach and selection

Ask four separate questions before an operation — the answers differ:

1. What nodes can the selector match recursively?
2. What text can the command search across node boundaries?
3. What descendants can the mutation actually change?
4. Which inset metadata or private-note boundaries stop it?

Per-command reach:

- `:contains()` and `:change()`/`:property()` inspect descendant prose; inset metadata stays opaque.
- `set --find` crosses ordinary text-node boundaries but not inset boundaries, and does not edit nested inset prose. When `--find` reports a phrase that spans an inset, use a full `set` on the containing block (insets preserved as current content) or break it into per-node operations.
- `insert split-after` reaches nested prose where supported, never inset metadata.
- `delete` removes a selected structural subtree; tracked deletion has atomic-inset restrictions.
- `lq undo <file>` restores the last snapshot by saved paths; selector replay scans only direct children of matched blocks.

Choose the selection scale deliberately — the smallest scale that expresses the workflow without crossing a structure boundary. Too small loses the context needed for a valid mutation; too large changes unrelated descendants. The count is scale-dependent too: text counts runs, layouts count paragraphs, insets count objects. Always inspect one representative node at the selected scale before mutating many matches.

| Workflow | Prefer | Why |
|---|---|---|
| Understand a paragraph's mixed content | `layout[Standard]` with `read --text-only` or `dump` | Shows text, tracked markers, properties, and inset markers together |
| Fix a phrase in one paragraph | A unique layout selector plus `set --find` | Keeps the operation inside the paragraph while allowing substring replacement |
| Fix only one tracked/style region | A containing block with `:change(...)` or `:property(...)`, or a `text:change(...)` selector for direct text work | Selects the state run without treating the marker itself as prose |
| Change one document or inline property | `property[key]` | The property is the unit being changed; do not replace the containing paragraph |
| Add or remove a whole footnote, citation, formula, or private note | `inset[...]` | The inset is the structural unit and its metadata must travel with it |
| Edit prose inside a footnote or other text inset with tracking | `inset[Foot] layout[Plain Layout]` | Markers belong around layout prose, not inside inset metadata |
| Replace a whole paragraph including its structure | `layout[...]` with explicit `--replace-all` | Deliberately operates on the block's direct children; broader than a text-only edit |
| Read a whole section, heading through body | Union the heading anchor with its `layout[Standard]` sibling range: `layout[Section]:contains(Intro):first, layout[Section]:contains(Intro):first ~ layout[Standard]:until(layout[Section])` | Reads the heading and the paragraphs under it, stopping before the next heading |
| Read or edit a section body | A unique heading anchor plus a sibling range using `~` and `:until()` | Layouts are siblings, not children of the heading |
| Inspect a private note without touching visible content | `inset[Note Note] layout[Plain Layout]` or a `:note` selector | Explicitly opts into source content omitted from PDF output |

Private notes: leave `Note Note` and `Note Comment` alone unless the task concerns them. Content matching hides their prose by default; state predicates and structural selectors can still see them; `Note Greyedout` is visible output and is not private. Opt in with `:note` or an explicit note path. See `lq help private-notes`.

# Reference: tracked changes

See `lq help tracked-changes` for the marker model, regions, and the per-position overwrite model. Operational rules that prevent mistakes:

- **Inspect the regions before editing a reviewed document.** `text:change(current)`, `text:change(inserted)`, and `text:change(deleted)` name the three regions; scope the next operation instead of treating visually similar text as one region. Diff view: `lq read file.lyx "text:change(current), text:change(deleted)" --text-only`; add `text:change(inserted)` for pending insertions. `read`/`dump` annotate tracked text by default.
- **Editing rejected text does not accept it.** The deleted text is preserved and the replacement becomes an adjacent new tracked change; the rejected region keeps its original author, so another author's replay-undo cannot resurrect it.
- **Tracked markers live only inside a layout's text.** With tracking on, edits to preamble lines, `#` comments, header text, or inset metadata are rejected with `TRACKING_ERROR`; disable tracking for those surfaces or target layout text instead.
- **Tracking off vs on for a plain `set`.** Off: the inline properties around the replaced text are dropped (no dead markup). On: they are kept inside `\change_deleted`, so rejecting the change restores the original formatting.
- **Do not assume `--replace-all` always wipes.** A node with review history follows the per-position preservation path and keeps insets outside the new change pair.
- **Undo has two modes by syntax.** `lq undo file.lyx` is snapshot restore (one level); `lq undo file.lyx "<block selector>" ["substring"]` is author-scoped replay over a block's direct children. Use replay for per-task rollback, snapshot for the whole last mutation. See `lq help undo`.

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

# Reference: editing inset and preamble data

Formula, ERT, and preamble payloads are opaque text nodes, not CST structure — except inline formulas, whose payload sits on the `\begin_inset` line itself.

- **Inspect first.** `lq read file.lyx "inset[Formula] text"` shows a display formula's raw LaTeX lines; `lq read file.lyx "preamble"` shows the preamble. That is the ground truth for what a later `--find` can match.
- **Display formulas and multi-line data are text.** With tracking off, `set --find` edits them surgically — one line is one text node, so keep the match within a line: `lq set file.lyx "inset[Formula]" "p_2" --find "p_{2}"`. The preamble works the same: `lq set file.lyx "preamble" "new@mail.org" --find "a@b.c"` touches only the address, not the surrounding `\newcommand`.
- **Inline formulas are a whole-inset unit.** `\begin_inset Formula $...$` keeps its payload on the opening line, not in text nodes, so `--find` cannot reach it and `--replace-all` rewrites only the children, not that line. Change it by `delete` + `insert --raw-file` with the new formula line.
- **Tracking is the constraint.** LyX does not track changes inside inset parameters or preamble lines. With tracking on, any `set` on an inset block is rejected with `TRACKING_ERROR`, and preamble and `#`-comment lines are not a trackable surface. Two reviewable-safe paths: disable tracking (`lq init --track-changes off`) for plain surgical data edits, or keep tracking on and `delete` the old inset + `insert` the new one.
- **Inserting math has no generation helper.** Build the inset with `--raw-file`:

  ```lyx
  \begin_inset Formula $x^2 + y^2 = z^2$
  \end_inset
  ```

  With tracking on the change markers wrap the whole inset, never inside its line. Generate ground-truth formula syntax with `tex2lyx` for complex math.
- **Do not fabricate structural blocks with `insert`.** A `\begin_preamble ... \end_preamble` payload is not placed into the header; it lands in the body with markers LyX would read literally. Edit the existing preamble with `set --find` (tracking off) or add preamble content in LyX.
- **ERT is a text inset.** Its payload lives in a nested `Plain Layout`, so tracked edits target `inset[ERT] layout[Plain Layout]`, and the raw `\backslash`-style content is that layout's prose.

# LyX reference

## LyX source syntax

LyX's own source and serialization are the authoritative reference for edge cases — citation and cross-reference parameters, inset status lines, nested layouts and list depth, formula and ERT content, and exact CommandInset defaults. The LyX writer is more authoritative than a permissive reader: a lossless round trip should satisfy `serialize(parse(file_text)) === file_text`. Some conventions are cosmetic, but structural markers, inset status lines, header entries, and change regions must stay valid for LyX to open the file. Use `lq dump` on a LyX-generated fixture when the CST shape is uncertain; what looks like markup inside an ERT inset may be literal text.

Raw LyX syntax references: [`LyX_inset.md`](LyX_inset.md) (insets), [`LyX_preamble.md`](LyX_preamble.md) (preamble).

## LyX CLI

See [`LyX_CLI.md`](LyX_CLI.md) for creating, importing, exporting, and opening documents through the LyX binary.

The acceptance check for a mutated document is a headless export, run with a timeout:

```text
"<LyX>/bin/lyx.exe" -e latex document.lyx
```

Exit 0 with an output file means LyX parsed the document; a non-zero exit or a lingering process usually means LyX opened a modal parse-error dialog. `lyx.exe` is normally not on `PATH` — find the installation root through `lq init`. Generate ground-truth syntax with `"<LyX>/bin/tex2lyx.exe" -f input.tex output.lyx`; prefer LyX-generated examples over hand-written syntax for unfamiliar structures.

## LyXServer and refresh

LyXServer is optional; disk is the primary integration point. For automatic refresh: `lq init --refresh reload` (fast, but discards unsaved in-LyX edits) or `lq init --refresh save-reload` (preserves unsaved edits; requires LyXServer and is slower). Use `save-reload` when LyX has unsaved work that must be preserved; use `none` for ordinary fast, Git-backed edits when LyX can reload externally changed files.

On Windows, LyXServer's response delivery is unreliable: a lost confirmation does not mean the command failed — lq reports dispatched, confirmed, and errored separately and treats an unconfirmed refresh as a warning when it is safe to proceed. Connection checks: verify LyX is running and LyXServer enabled; check that the LyX user directory and pipe discovery path exist; use `lq init --refresh save-reload` as the fast reachability check; restart LyX if confirmations repeatedly disappear; keep only the intended `.lyx` buffer open on Windows. Do not diagnose repeated confirmation loss by adding more blocking reads — the server shares an output buffer and can execute a command while losing its response.

## Real-LyX verification

`deno test` verifies lq's parser, query engine, serializer, and mutation logic; only LyX confirms that a file is acceptable. For high-risk changes: copy the fixture or document to a temporary path, apply the mutation to the copy, export with LyX under a bounded process timeout, inspect the generated output, and record the result in the relevant development log. Never use a repository fixture as a scratch file for manual mutation tests; restore or delete temporary files after verification.

