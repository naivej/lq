//! LyX document toolkit library (Rust rewrite of the former Deno `lq` sources).

mod ast;
mod bib;
mod bind;
mod cache;
mod cli;
mod help;
mod help_render;
mod html_escape;
mod latex_math;
mod lyxserver;
mod math_alphanum;
mod parser;
mod paths;
mod preview;
mod query;
mod registry;
mod schema;
mod serializer;
mod text_utils;
mod tracked_changes;
mod undo;

pub use ast::{Document, NodeData, NodeId, NodeKind};
pub use bib::{Citation, format_bibliography_entry, parse_bibtex};
pub use bind::{ShortcutMap, format_bind_sequence, lookup_shortcut};
pub use cache::{hash_text, set_max_cache_entries};
pub use help::{
    FurtherReading, HELP_PAGES, HelpPage, HelpSection, PageGroup, alias_of, find_by_alias,
    find_by_reach, find_page, group_of, grouped_pages, home_page, reach_of,
};
pub use help_render::{RichMode, render_page, render_page_rich, render_page_text, render_page_tty};
pub use html_escape::escape_live_html;
pub use latex_math::{
    MathMacro, MathMacroMap, UnwrappedLatex, latex_to_mathml, parse_newcommands,
    render_formula_html, unwrap_latex_source,
};
pub use lyxserver::{
    RefreshMode, RefreshPreStep, SendResult, build_pipe_command, filter_responses, refresh_pre_step,
};
pub use math_alphanum::{MathAlphanumRow, MathAlphanumVariant, math_alphanum};
pub use parser::{ParseError, RecoveredParse, parse, parse_recovering};
pub use paths::{
    EnvMap, StatePaths, StateScope, find_local_state_root, get_global_state_paths,
    get_user_home_dir, resolve_init_state_paths, resolve_state_paths,
};
pub use preview::{
    DIAG_PREVIEW_RECOVERED, DIAG_TEXTCLASS_FALLBACK, LIVE_CAPABILITIES, LIVE_CONTRACT,
    LIVE_DEFERRED_FIELDS, LIVE_HASH_ALGORITHM, LIVE_HASH_INPUT, LIVE_PROJECTION, LineEnding,
    LiveCapabilities, LiveChangeEntry, LiveChangeType, LiveContractError, LiveDiagnostic,
    LiveNavEntry, LiveNavigate, LiveOutlineEntry, LivePreviewResponse, LiveRenderOptions,
    LiveRenderResult, LiveSourceIdentity, LiveToken, LiveTokenBundle, LiveTokenVia,
    PREVIEW_INCOMPLETE_WARNING, PREVIEW_NO_TEXTCLASS_WARNING, PreviewError, SemNode,
    build_live_response, count_lines, decode_entities, detect_line_ending, find_magick, format_sem,
    normalize_reader_html, preview_missing_class_warning, raster_magick_args, render_live_html,
    semantic_equal, validate_live_response,
};
pub use query::{
    Combinator, PseudoClass, PseudoName, QueryError, ScopePredicate, ScopeState, Selector,
    SelectorPart, build_scope_predicate, build_traversal_state_index, is_valid_nth_match_formula,
    parse_change_arg, parse_selector, property_state_at, query, selector_note_scope,
};
pub use registry::{
    CHANGE_AXIS_KEYS, INLINE_PROPERTIES, INSET_CATALOG, InsetKind, InsetMeta,
    KNOWN_COMMAND_INSET_TYPES, get_inset_type, is_inline_style_key, validate_inset_type,
};
pub use schema::{
    DocumentLayoutContext, HeadingLevel, INSET_LAYOUTS, LayoutFont, LayoutHtml,
    LayoutSearchOptions, LayoutSearchResolved, LocalLayoutTexts, LyxSchema, SchemaError,
    SchemaInset, extract_document_layout_context, find_layout_file, get_default_layouts_dir,
    get_layout_html_for_class, get_lyx_user_layouts_dir, get_schema_for_class,
    resolve_layout_search_paths,
};
pub use serializer::serialize;
pub use text_utils::{
    ConcatOpts, TextRegion, TextSegment, TraversalState, advance_change_depths,
    concatenate_text_nodes, invisible_inset_type, is_invisible_inset, map_pos_to_segment,
};
pub use tracked_changes::{
    ChangeKind, ChangeMarker, CrossNodeReplace, RegionEnd, annotate_changes,
    annotate_changes_in_place, annotate_changes_many, apply_cross_node_replace,
    apply_tracked_delete_to_children, ensure_tracking_changes_in_header, extract_all_text,
    flatten_nested_changes, get_header, has_direct_tracked_changes, has_layout_ancestor,
    has_tracked_changes, is_change_closer, is_change_opener, is_content_node, parse_change_marker,
    resolve_author_id, scan_region_end, wrap_with_tracking,
};
pub use undo::{
    CommitResult, SnapshotEntry, SnapshotFile, SnapshotMode, clear_snapshot, collect_snapshots,
    commit_mutation, find_node_path, load_snapshot, node_at_path, save_snapshot,
};

pub fn run_cli(args: &[String]) {
    cli::run_cli(args);
}
