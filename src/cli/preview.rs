//! `lq preview` (Deno `cli.ts` preview branch).

use super::common::{CliError, UserConfig, print_json, push_warning};
use crate::ast::Document;
use crate::preview::build_live_response;
use std::path::Path;

pub fn run_preview(
    file_path: &str,
    ast: &Document,
    text: &str,
    text_hash: &str,
    config: &UserConfig,
) -> Result<(), CliError> {
    let overlay = config.layouts_dir.as_deref().map(Path::new);
    match build_live_response(
        Path::new(file_path),
        ast,
        text,
        overlay,
        None,
        Some(text_hash),
    ) {
        Ok(result) => {
            for warning in result.warnings {
                push_warning(warning);
            }
            let value = serde_json::to_value(&result.response)
                .expect("invariant: LivePreviewResponse serializes");
            print_json(value);
            Ok(())
        }
        Err(err) if err.code == "LAYOUT_NOT_FOUND" || err.code == "NO_TEXTCLASS" => {
            Err(CliError::new(err.code, err.message))
        }
        Err(err) => Err(CliError::new("PREVIEW_ERROR", err.message)),
    }
}
