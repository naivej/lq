# Tracked changes

See `lq help tracked-changes` for the marker model, regions, and the per-position overwrite model. Operational rules that prevent mistakes:

- **Inspect the regions before editing a reviewed document.** `text:change(current)`, `text:change(inserted)`, and `text:change(deleted)` name the three regions; scope the next operation instead of treating visually similar text as one region. Diff view: `lq read file.lyx "text:change(current), text:change(deleted)" --text-only`; add `text:change(inserted)` for pending insertions. `read`/`dump` annotate tracked text by default.
- **Editing rejected text does not accept it.** The deleted text is preserved and the replacement becomes an adjacent new tracked change; the rejected region keeps its original author, so another author's replay-undo cannot resurrect it.
- **Tracked markers live only inside a layout's text.** With tracking on, edits to preamble lines, `#` comments, header text, or inset metadata are rejected with `TRACKING_ERROR`; disable tracking for those surfaces or target layout text instead.
- **Tracking off vs on for a plain `set`.** Off: the inline properties around the replaced text are dropped (no dead markup). On: they are kept inside `\change_deleted`, so rejecting the change restores the original formatting.
- **Do not assume `--replace-all` always wipes.** A node with review history follows the per-position preservation path and keeps insets outside the new change pair.
- **Undo has two modes by syntax.** `lq undo file.lyx` is snapshot restore (one level); `lq undo file.lyx "<block selector>" ["substring"]` is author-scoped replay over a block's direct children. Use replay for per-task rollback, snapshot for the whole last mutation. See `lq help undo`.
