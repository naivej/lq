# Reach and selection

How far a mutation reaches. Ask four separate questions before an operation — the answers differ:

1. What nodes can the selector match recursively?
2. What text can the command search across node boundaries?
3. What descendants can the mutation actually change?
4. Which inset metadata or private-note boundaries stop it?

## Per-command reach

- `:contains()` and `:change()`/`:property()` inspect descendant prose; inset metadata stays opaque.
- `set --find` crosses ordinary text-node boundaries but not inset boundaries, and does not edit nested inset prose. When `--find` reports a phrase that spans an inset, use a full `set` on the containing block (insets preserved as current content) or break it into per-node operations.
- `insert split-after` reaches nested prose where supported, never inset metadata.
- `delete` removes a selected structural subtree; tracked deletion has atomic-inset restrictions.
- `lq undo <file>` restores the last snapshot by saved paths; selector replay scans only direct children of matched blocks.

## Selection scale

Choose the selection scale deliberately — the smallest scale that expresses the workflow without crossing a structure boundary. Too small loses the context needed for a valid mutation; too large changes unrelated descendants. The count is scale-dependent too: text counts runs, layouts count paragraphs, insets count objects. Always inspect one representative node at the selected scale before mutating many matches.

| Workflow | Prefer | Why |
|---|---|---|
| Understand a paragraph's mixed content | `layout[Standard]` with `read` | CST children: text runs, property keys, tracked markers, insets |
| Fix a phrase in one paragraph | A unique layout selector plus `set --find` | Keeps the operation inside the paragraph while allowing substring replacement |
| Fix only one tracked/style region | A containing block with `:change(...)` or `:property(...)`, or a `text:change(...)` selector for direct text work | Selects the state run without treating the marker itself as prose |
| Change one document or inline property | `property[key]` | The property is the unit being changed; do not replace the containing paragraph |
| Add or remove a whole footnote, citation, formula, or private note | `inset[...]` | The inset is the structural unit and its metadata must travel with it |
| Edit prose inside a footnote or other text inset with tracking | `inset[Foot] layout[Plain Layout]` | Markers belong around layout prose, not inside inset metadata |
| Replace a whole paragraph including its structure | `layout[...]` with explicit `--replace-all` | Deliberately operates on the block's direct children; broader than a text-only edit |
| Read a whole section, heading through body | Union the heading anchor with its `layout[Standard]` sibling range: `layout[Section]:contains(Intro):first, layout[Section]:contains(Intro):first ~ layout[Standard]:until(layout[Section])` | Reads the heading and the paragraphs under it, stopping before the next heading |
| Read or edit a section body | A unique heading anchor plus a sibling range using `~` and `:until()` | Layouts are siblings, not children of the heading |
| Inspect a private note without touching visible content | `inset[Note Note] layout[Plain Layout]` or a `:note` selector | Explicitly opts into source content omitted from PDF output |

## Private notes

Leave `Note Note` and `Note Comment` alone unless the task concerns them. Content matching hides their prose by default; state predicates and structural selectors can still see them; `Note Greyedout` is visible output and is not private. Opt in with `:note` or an explicit note path. See `lq help private-notes`.
