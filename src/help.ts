/**
 * help.ts — the single help catalog for the built-in help.
 *
 * One structured object per help page. `group`, `reach`, and `alias` are
 * derived from `id` and never stored, so a page ID cannot be spelled
 * inconsistently between the map, the router, and the links.
 *
 * Phase 0 (dev log 113): types, the 18-page registry, and navigation
 * helpers. Page `sections` and `furtherReading` content land in Phase 1
 * (content migration from the help draft).
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
  /** Ordered sections (heading + body). Filled in Phase 1. */
  sections: HelpSection[];
  /** Related pages as stable page IDs with hints. Filled in Phase 1. */
  furtherReading: FurtherReading[];
}

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
    sections: [],
    furtherReading: [],
  },
  {
    id: "model/cst",
    title: "concrete syntax tree: nodes, scale, and losslessness",
    sections: [],
    furtherReading: [],
  },
  {
    id: "model/guarantees",
    title: "the design guarantees behind lq",
    sections: [],
    furtherReading: [],
  },
  {
    id: "concepts/state-scope",
    title: "local and global state selection",
    sections: [],
    furtherReading: [],
  },
  {
    id: "concepts/private-notes",
    title: "note visibility on the content/state/structure axes",
    sections: [],
    furtherReading: [],
  },
  {
    id: "concepts/insets",
    title: "inset structure, atomicity, and data",
    sections: [],
    furtherReading: [],
  },
  {
    id: "concepts/selectors",
    title: "selector syntax and reach",
    sections: [],
    furtherReading: [],
  },
  {
    id: "concepts/mutations",
    title: "every-match mutation rules and safety",
    sections: [],
    furtherReading: [],
  },
  {
    id: "concepts/tracked-changes",
    title: "change regions and tracked behavior",
    sections: [],
    furtherReading: [],
  },
  {
    id: "commands/init",
    title: "initialize or view configuration",
    sections: [],
    furtherReading: [],
  },
  {
    id: "commands/schema",
    title: "valid layouts and properties for a document class",
    sections: [],
    furtherReading: [],
  },
  {
    id: "commands/dump",
    title: "output the document structure",
    sections: [],
    furtherReading: [],
  },
  {
    id: "commands/read",
    title: "output matching nodes and text content",
    sections: [],
    furtherReading: [],
  },
  {
    id: "commands/bib",
    title: "extract references from the bibliography",
    sections: [],
    furtherReading: [],
  },
  {
    id: "commands/set",
    title: "overwrite targeted nodes with new text",
    sections: [],
    furtherReading: [],
  },
  {
    id: "commands/delete",
    title: "delete targeted nodes",
    sections: [],
    furtherReading: [],
  },
  {
    id: "commands/insert",
    title: "insert new blocks or properties",
    sections: [],
    furtherReading: [],
  },
  {
    id: "commands/undo",
    title: "revert edits",
    sections: [],
    furtherReading: [],
  },
];

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
