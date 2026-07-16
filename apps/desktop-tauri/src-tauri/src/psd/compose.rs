//! PSD template operations: list exported PSD triplets and run the native
//! Rust compose / inspect / analyze pipelines. Split out of `psd.rs`; the
//! command names and result shapes are unchanged.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::contracts::VisualContext;
use crate::modified_ms;
use crate::studio::studio_reject_unsafe_basename;

#[derive(Serialize)]
pub(crate) struct PsdOutputFile {
    /// Base name shared by the triplet (e.g. `final` for `final.psd`).
    name: String,
    psd_path: String,
    preview_path: Option<String>,
    metadata_path: Option<String>,
    /// PSD file modification time in milliseconds since the Unix epoch.
    modified_ms: Option<u64>,
    size_bytes: u64,
    /// True when the export's metadata records a true smart-object content
    /// replacement (`smart_object_mode == "replace_content"`).
    smart_object: bool,
}

/// Cheap check for whether a `_metadata.json` records a smart-object content
/// replacement, without pulling in a JSON parser.
fn metadata_has_smart_object(metadata_path: &Option<String>) -> bool {
    let Some(path) = metadata_path else {
        return false;
    };
    match fs::read_to_string(path) {
        Ok(text) => text.contains("\"smart_object_mode\"") && text.contains("\"replace_content\""),
        Err(_) => false,
    }
}

/// Scan a directory (non-recursively) for PSD exports produced by the PSD
/// nodes and group each `<base>.psd` with its `<base>_preview.png` and
/// `<base>_metadata.json` siblings when present.
#[tauri::command]
pub(crate) fn list_psd_outputs(dir: String) -> Result<Vec<PsdOutputFile>, String> {
    let dir = dir.trim();
    if dir.is_empty() {
        return Err("output directory is empty".to_string());
    }
    let path = Path::new(dir);
    if !path.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }

    let mut outputs = Vec::new();
    for entry in
        fs::read_dir(path).map_err(|err| format!("failed to read {}: {err}", path.display()))?
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let psd_path = entry.path();
        let is_psd = psd_path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("psd"))
            .unwrap_or(false);
        if !is_psd {
            continue;
        }
        let base = match psd_path.file_stem().and_then(|s| s.to_str()) {
            Some(stem) => stem.to_string(),
            None => continue,
        };

        let sibling = |suffix: &str| {
            let candidate = path.join(format!("{base}{suffix}"));
            candidate
                .is_file()
                .then(|| candidate.to_string_lossy().to_string())
        };
        let preview_path = sibling("_preview.png");
        let metadata_path = sibling("_metadata.json");
        let smart_object = metadata_has_smart_object(&metadata_path);

        let metadata = entry.metadata().ok();
        outputs.push(PsdOutputFile {
            name: base,
            psd_path: psd_path.to_string_lossy().to_string(),
            preview_path,
            metadata_path,
            modified_ms: metadata.as_ref().and_then(modified_ms),
            size_bytes: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
            smart_object,
        });
    }

    // Newest first, falling back to name for stable ordering.
    outputs.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(outputs)
}

/// Result of a `compose_psd` run.
#[derive(Serialize, Deserialize)]
pub(crate) struct ComposePsdResult {
    pub(crate) status: String,
    pub(crate) psd_path: String,
    /// Empty string when preview generation was disabled.
    pub(crate) preview_path: String,
    pub(crate) metadata_path: String,
    pub(crate) placeholder_kind: Option<String>,
    pub(crate) smart_object_mode: String,
}

/// Compose a generated image into a PSD template's placeholder and export
/// `<filename>.psd` + `<filename>_preview.png` + `<filename>_metadata.json`.
///
/// The default path runs natively in Rust (`super::write`): the generated
/// image is inserted as a new pixel layer inside a `03_GENERATED` group — or,
/// for `replace_content` on an embedded smart object, written inside the
/// object (`super::smart`) — splicing the template's own bytes so everything
/// else round-trips untouched. Jobs the native writer rejects (externally
/// linked smart objects, non-PNG or colour-managed sources, non-8-bit/RGB
/// templates) surface as errors.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn compose_psd(
    dir: Option<String>,
    template: String,
    image: String,
    mask: Option<String>,
    output_dir: String,
    filename: Option<String>,
    placeholder: Option<String>,
    fit_mode: Option<String>,
    z_order: Option<String>,
    smart_object_mode: Option<String>,
    hide_placeholder: Option<String>,
    metadata: Option<String>,
    save_preview: Option<bool>,
) -> Result<ComposePsdResult, String> {
    // Exports are written as `output_dir / f"{base}.psd"`, so a name with path
    // separators or `..` could write outside the chosen folder. Validate it
    // before either path uses the value.
    let filename_value = filename.as_deref().unwrap_or("final");
    studio_reject_unsafe_basename(filename_value)?;

    let _ = dir;
    super::write::compose_psd_native(&super::write::ComposeArgs {
        template: &template,
        image: &image,
        mask: mask.as_deref().unwrap_or(""),
        output_dir: &output_dir,
        filename: filename_value,
        placeholder: placeholder.as_deref().unwrap_or("{}"),
        fit_mode: fit_mode.as_deref().unwrap_or("contain"),
        z_order: z_order.as_deref().unwrap_or("above_background"),
        smart_object_mode: smart_object_mode.as_deref().unwrap_or("disable"),
        hide_placeholder: hide_placeholder.as_deref().unwrap_or("enable") == "enable",
        metadata: metadata.as_deref().unwrap_or("{}"),
        save_preview: save_preview.unwrap_or(true),
    })
    .map_err(|err| format!("native PSD compose failed: {err}"))
}

/// A single PSD layer.
#[derive(Serialize, Deserialize)]
pub(crate) struct PsdLayerInfo {
    name: String,
    /// "group" | "smartobject" | "pixel".
    kind: String,
}

/// Result of an `inspect_psd` run.
#[derive(Serialize, Deserialize)]
pub(crate) struct InspectPsdResult {
    status: String,
    /// `false` when the template path does not point at a file on disk.
    exists: bool,
    width: u32,
    height: u32,
    /// Flat list of every layer (groups and their children), newest-first as
    /// PSD stores them.
    layers: Vec<PsdLayerInfo>,
    /// Subset of the requested `names` that were not found in the PSD.
    missing: Vec<String>,
}

/// Inspect a PSD template: report whether it exists on disk, its canvas size,
/// and the names/kinds of its layers, plus which of the requested placeholder
/// `names` are missing. This lets the editor validate a real PSD before a run
/// (file present, placeholder layer name actually exists) instead of only
/// surfacing the problem mid-compose.
///
/// Runs natively in Rust (`super::inspect`), reading only the header + layer
/// records entirely in-process.
#[tauri::command]
pub(crate) fn inspect_psd(
    dir: Option<String>,
    template: String,
    names: Option<Vec<String>>,
) -> Result<InspectPsdResult, String> {
    let _ = dir;
    let requested = names.unwrap_or_default();
    let template_trimmed = template.trim();
    let template_path = Path::new(template_trimmed);
    if template_trimmed.is_empty() || !template_path.is_file() {
        // Not an error: callers distinguish "no file on disk" from a crash.
        return Ok(InspectPsdResult {
            status: "succeeded".to_string(),
            exists: false,
            width: 0,
            height: 0,
            layers: Vec::new(),
            missing: requested,
        });
    }

    match super::inspect::inspect_psd_file(template_path) {
        Ok(parsed) => {
            let layers: Vec<PsdLayerInfo> = parsed
                .layers
                .into_iter()
                .map(|layer| PsdLayerInfo {
                    name: layer.name,
                    kind: layer.kind.to_string(),
                })
                .collect();
            let missing = requested
                .into_iter()
                .filter(|name| !name.is_empty() && !layers.iter().any(|row| &row.name == name))
                .collect();
            Ok(InspectPsdResult {
                status: "succeeded".to_string(),
                exists: true,
                width: parsed.width,
                height: parsed.height,
                layers,
                missing,
            })
        }
        Err(err) => Err(format!("native PSD inspect failed: {err}")),
    }
}

/// Analyze a PSD template into a machine-usable [`VisualContext`]: background
/// colour/lighting heuristics, the target placeholder's geometry, and a
/// ready-to-append prompt suffix. This is the **PSD Context Analyze** node's
/// backend (the first PSD production node): downstream nodes (Light & Color
/// Match, etc.) consume the returned context so the user never hand-describes
/// the template's lighting/colour.
///
/// Runs natively in Rust (`super::analyze`), decoding only the pixels it
/// needs from the template. Files the native analyzer rejects (non-RGB/8-bit
/// modes, zip-compressed channels, a group/masked background layer that needs
/// real re-compositing) surface as errors.
/// `background_layer` / `target_placeholder` may be empty (auto: whole-canvas
/// placeholder, full composite background); `output_dir` is where the
/// placeholder mask and background preview PNGs are written.
/// `reference_layers` is currently advisory (Phase 1 is heuristic).
#[tauri::command]
pub(crate) fn analyze_psd_context(
    dir: Option<String>,
    template: String,
    background_layer: Option<String>,
    target_placeholder: Option<String>,
    reference_layers: Option<Vec<String>>,
    output_dir: Option<String>,
) -> Result<VisualContext, String> {
    let _ = (dir, reference_layers);
    super::analyze::analyze_psd_native(
        template.trim(),
        background_layer.as_deref().unwrap_or(""),
        target_placeholder.as_deref().unwrap_or(""),
        output_dir.as_deref().unwrap_or(""),
    )
    .map_err(|err| format!("native PSD analyze failed: {err}"))
}
