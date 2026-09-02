//! `lq schema` (Deno `cli.ts` schema branch).

use super::common::{
    CliError, UserConfig, print_json, push_warning, resolve_document_layout_roots,
};
use crate::Document;
use crate::schema::{extract_document_layout_context, fallback_schema, get_schema_for_class};
use serde_json::json;

pub fn run_schema(ast: &Document, config: &UserConfig) -> Result<(), CliError> {
    let roots = resolve_document_layout_roots(config);
    let ctx = extract_document_layout_context(ast);
    let Some(textclass) = ctx.textclass.as_deref().filter(|s| !s.is_empty()) else {
        return Err(CliError::new(
            "NO_TEXTCLASS",
            "Could not determine textclass from the document.",
        ));
    };
    let modules: Vec<&str> = ctx.modules.iter().map(String::as_str).collect();
    match get_schema_for_class(textclass, &roots.search_paths, &modules, Some(&ctx.local)) {
        Ok(schema) => print_json(json!({ "data": schema })),
        Err(error) => {
            push_warning(format!(
                "Could not read layout file for textclass '{textclass}': {}",
                error.message
            ));
            print_json(json!({ "data": fallback_schema(textclass) }));
        }
    }
    Ok(())
}
