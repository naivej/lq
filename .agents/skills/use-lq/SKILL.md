---
name: use-lq
description: Use lq to parse, query, and mutate LyX documents (`.lyx` files). Use headless LyX to create, import, or export the documents, and open the LyX GUI to establish a LyXServer connection.
allowed-tools: Bash(lq *)
---

Run `lq help` for the authoritative manual of how to parse, query, and mutate LyX documents. The installed help is the floor; this skill is the accelerant — help carries every fact, the skill compresses trial and error into judgment. Deep reference lives in the `references/` files listed in [Reference](#reference), reached when its branch comes up.

# Mental model

Three ideas carry the whole skill:

- **Source, not LaTeX.** `lq` edits LyX syntax; LyX owns import, export, compilation, and PDF. Formula, ERT, and preamble payloads are opaque strings — target the inset, never parse the LaTeX inside it.
- **Reach, not recursion.** A selector can *match* recursively while a mutation *changes* only what the command can reach. Layouts are flat siblings; text splits at every state boundary; inset metadata stays opaque. Never infer mutation reach from selector reach.
- **Fail closed, reported separately.** A hard error exits non-zero and writes nothing. File outcome, LyXServer dispatch, and confirmation are separate facts; warnings can accompany a committed file.

# Operating loop

Run the same sequence for every task:

1. **Set the task's author name first.** `lq init --author-name "<task>"` before the first mutation, and switch when the task changes. Replay undo is author-scoped, so each task's edits stay separately revertible. Name the task, not the human.
2. **Inspect configuration.** `lq init` shows the selected scope and config — `trackChanges`, `authorName`, optional `layoutsDir` overlay, `refresh` — plus `layoutSearch` (order) and `layoutRoots` (paths) when writing config. Change configuration only with authorization. See the state-scope note below.
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
| Exclude footnotes in a section | `lq read file.lyx "layout[Section]:contains(Intro):first ~ layout[Standard]:not(inset[Foot]):until(layout[Section])" --text-only` |
| Find a paragraph after a quote | `lq read file.lyx "layout[Section]:contains(Intro):first ~ layout[Standard]:until(layout[Section]):adjacent(layout[Quote])" --text-only` |
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

Structural work. Set the per-task author name so the whole draft is one review unit, check `lq schema`, and confirm layouts resolve. Build the skeleton first — headings and blocks with `insert --layout` — then fill in with `--text`, `split-after`, and `--raw-file` for citations, references, and math. Verify each section with `read --text-only`; run a LyX export at milestones as the structural acceptance check. The payload recipes behind `--ref`, `--cite`, and `--raw-file` live in `references/Domain_recipes.md`; opaque formula, ERT, and preamble payloads are covered in `references/Inset_data.md`.

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

When every occurrence should change — a terminology or style pass over a section — every-match is the desired behavior, not a hazard; just confirm the scope with `--count` first. Deep reach rules — what `--find` crosses and what stops it — live in `references/Reach.md`.

## Draft review and paragraph-level revision

Review at the paragraph scale: read a section range (`layout[Section]:contains(Intro):first ~ layout[Standard]:until(layout[Section]) --text-only`) so prose, structure, and tracked markers stay together. Rewrite a paragraph with a tracked `set` on the layout — old paragraph in `change_deleted`, new in `change_inserted`, insets preserved — and use `--replace-all` only for deliberate structural rewrites. Because the review pass has its own `--author-name`, `lq undo file.lyx "<section selector>"` later reverts exactly the reviewer's edits and leaves the author's tracked changes intact; `lq read file.lyx "text:change(current), text:change(deleted)" --text-only` shows the diff-style review view. The tracked-change rules this workflow leans on live in `references/Tracked_changes.md`.

# Reference

Deep reference lives in the `references/` folder, read on demand when its branch comes up:

| File | Covers | Reach when |
| --- | --- | --- |
| [`Reach.md`](references/Reach.md) | The four reach questions, per-command reach, the selection-scale table, private notes | a mutation's reach is uncertain, or a mutation does not change what the selector matched |
| [`Tracked_changes.md`](references/Tracked_changes.md) | Tracked-change operational rules: regions, editing rejected text, tracking surfaces, undo modes | tracking is on, or the document is under review |
| [`Domain_recipes.md`](references/Domain_recipes.md) | Cross-references, citations, lists, multi-pass insertion | the task involves those content types or a complex payload |
| [`Inset_data.md`](references/Inset_data.md) | Editing formula, ERT, and preamble payloads | the edit target is an opaque inset payload or preamble |
| [`LyX_inset.md`](references/LyX_inset.md) · [`LyX_preamble.md`](references/LyX_preamble.md) | LyX file-format ground truth: inset and preamble serialization | hand-writing structure, or the CST shape of an unfamiliar structure is uncertain |
| [`LyX_Headless.md`](references/LyX_Headless.md) | Driving the LyX binary: create, import, export, acceptance check, verification | generating ground truth, or verifying a mutated document against LyX |
| [`LyX_GUI.md`](references/LyX_GUI.md) | Opening/closing the LyX GUI that hosts LyXServer: launch with the file, reuse a running instance, close/restart for a fresh server | a LyXServer session is needed, or the server is degraded and needs a restart |
| [`LyXServer.md`](references/LyXServer.md) | LyXServer and refresh: modes, the Windows confirmation fix, can't-connect order | LyX holds unsaved work, or refresh misbehaves |

