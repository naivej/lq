# Editing inset and preamble data

Formula, ERT, and preamble payloads are opaque text nodes, not CST structure — except inline formulas, whose payload sits on the `\begin_inset` line itself.

- **Inspect first.** `lq read file.lyx "inset[Formula] text"` shows a display formula's raw LaTeX lines; `lq read file.lyx "preamble"` shows the preamble. That is the ground truth for what a later `--find` can match.
- **Display formulas and multi-line data are text.** With tracking off, `set --find` edits them surgically — one line is one text node, so keep the match within a line: `lq set file.lyx "inset[Formula]" "p_2" --find "p_{2}"`. The preamble works the same: `lq set file.lyx "preamble" "new@mail.org" --find "a@b.c"` touches only the address, not the surrounding `\newcommand`.
- **Inline formulas are a whole-inset unit.** `\begin_inset Formula $...$` keeps its payload on the opening line, not in text nodes, so `--find` cannot reach it and `--replace-all` rewrites only the children, not that line. Change it by `delete` + `insert --raw-file` with the new formula line.
- **Tracking is the constraint.** LyX does not track changes inside inset parameters or preamble lines. With tracking on, `set` on inset *parameters* is rejected with `TRACKING_ERROR`. A default `set` on an inset block (no `--find`) is rejected with `INVALID_CONTEXT` even when tracking is off — it would destroy inset structure. Preamble and `#`-comment lines are not a trackable surface. Two reviewable-safe paths: disable tracking (`lq init --track-changes off`) then `set --find` for surgical data edits, or keep tracking on and `delete` the old inset + `insert` the new one.
- **Inserting math has no generation helper.** Build the inset with `--raw-file`:

  ```lyx
  \begin_inset Formula $x^2 + y^2 = z^2$
  \end_inset
  ```

  With tracking on the change markers wrap the whole inset, never inside its line. Generate ground-truth formula syntax with `tex2lyx` for complex math.
- **Do not fabricate structural blocks with `insert`.** A `\begin_preamble ... \end_preamble` payload is not placed into the header; it lands in the body with markers LyX would read literally. Edit the existing preamble with `set --find` (tracking off) or add preamble content in LyX.
- **ERT is a text inset.** Its payload lives in a nested `Plain Layout`, so tracked edits target `inset[ERT] layout[Plain Layout]`, and the raw `\backslash`-style content is that layout's prose.
