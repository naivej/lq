# Live pointer

Read this record when the user gives a preview selection this turn (`#lyxSelection` or `@live-selection.json` next to the previewed `.lyx`). It names the owner of the highlight. Use it as the zoom.

| Field | How to read it |
|---|---|
| `file` | The target `.lyx`, or its child when the highlight is inside an Include. |
| `diskHash` | SHA-256 of `file`'s saved bytes. Snapshot identity. |
| `stale` | `true` → inspect only until `file` is saved. A child pointer does not stale with the master. |
| `mode` | `original` (before changes) / `tracked` (with tracked changes) / `clean` (after accepting all changes) shown in preview. |
| `selector` | Owner for `lq read <file> "<selector>"`. Nested when the highlight is inside an inset. |
| `selectedText` | Non-empty ⇒ treat as `--text-only` spelling. Empty ⇒ object selection (chips, caret, cite/href/ref). |
| `changeId` | `change-N` if the owner is a tracked region, else `null`. `N` is that region's 1-based document-order ordinal in this Live render. |
| `multi` | Drag crossed owners. `selector` is the **anchor** (start owner); `selectedText` is clipped to that owner only. |
| `via` | Present when `file` is an included child shown in another document's preview. Use for Context only. |
| `capturedAt` | When the record was last written. |

Done when `file` and `selector` are the zoom, `stale` is handled, and `selectedText` is applied as above.
