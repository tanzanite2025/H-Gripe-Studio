//! PSD tooling for the desktop app: the per-domain command submodules split
//! out of this file (PSD compose/inspect/analyze, the local card processors,
//! the engine capability probe, and the detail-repaint pipeline). Every
//! submodule command is re-exported here so `crate::psd::<command>` and the
//! Tauri `invoke_handler` registrations stay unchanged.

use crate::studio::studio_reject_unsafe_basename;

mod analyze;
mod cards;
mod compose;
mod engines;
mod inspect;
mod model_paths;
mod repaint;
mod smart;
mod write;

pub(crate) use cards::*;
pub(crate) use compose::*;
pub(crate) use engines::*;
pub(crate) use model_paths::*;
pub(crate) use repaint::*;

/// Validate a user-supplied `output_name` before handing it to a pipeline
/// that joins it onto the output directory. An empty name is allowed (the
/// pipeline picks its own `<image>_<suffix>` default); a non-empty name must
/// be a plain basename so an untrusted workflow cannot use `..` or a path
/// separator to redirect the write outside the chosen folder.
pub(crate) fn reject_unsafe_output_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Ok(());
    }
    studio_reject_unsafe_basename(name)
}

#[cfg(test)]
mod tests {
    use super::{reject_unsafe_output_name, EngineProbeReport};

    #[test]
    fn output_name_allows_empty_so_cli_picks_default() {
        assert!(reject_unsafe_output_name("").is_ok());
        assert!(reject_unsafe_output_name("   ").is_ok());
    }

    #[test]
    fn output_name_allows_plain_basenames() {
        assert!(reject_unsafe_output_name("matched").is_ok());
        assert!(reject_unsafe_output_name("  result  ").is_ok());
        assert!(reject_unsafe_output_name("my.output").is_ok());
    }

    #[test]
    fn engine_probe_report_round_trips() {
        // The cross-card report serialises to the shape the UI bridge expects.
        let raw = r#"{
            "cards": [
                {"node_kind": "imageEnhance", "cli": "",
                 "engines": {"cpu": {"available": true, "reason": "built-in native Rust path"}}},
                {"node_kind": "detailWatchdog", "cli": "",
                 "engines": {}, "error": "probe failed"}
            ],
            "model_cache_dir": null
        }"#;
        let report: EngineProbeReport = serde_json::from_str(raw).unwrap();
        assert_eq!(report.cards.len(), 2);
        assert_eq!(report.cards[0].node_kind, "imageEnhance");
        assert!(report.cards[0].engines["cpu"].available);
        assert!(report.cards[0].error.is_none());
        assert_eq!(report.cards[1].error.as_deref(), Some("probe failed"));
        assert!(report.cards[1].engines.is_empty());
    }

    #[test]
    fn local_repaint_result_parses_backend_and_fallback() {
        // A successful local run: a backend ran and returned one repainted crop.
        let raw = r#"{
            "repainted": [{"index": 0, "path": "/out/hero_region0_repainted.png"}],
            "skipped": [],
            "engine": "sd_inpaint",
            "engine_requested": "sd_inpaint",
            "engine_fallback_reason": null,
            "backend_model": "sd-inpaint",
            "requested_count": 1,
            "repainted_count": 1
        }"#;
        let res: super::LocalRepaintResult = serde_json::from_str(raw).unwrap();
        assert_eq!(res.engine, "sd_inpaint");
        assert_eq!(res.repainted.len(), 1);
        assert_eq!(res.repainted[0].index, 0);
        assert!(res.engine_fallback_reason.is_none());
        assert_eq!(res.backend_model.as_deref(), Some("sd-inpaint"));

        // The provider-fallback shape: no local repaint, a recorded reason.
        let fallback = r#"{
            "repainted": [],
            "engine": "provider",
            "engine_requested": "sd_inpaint",
            "engine_fallback_reason": "missing optional dependency: torch",
            "requested_count": 2,
            "repainted_count": 0
        }"#;
        let res: super::LocalRepaintResult = serde_json::from_str(fallback).unwrap();
        assert_eq!(res.engine, "provider");
        assert!(res.repainted.is_empty());
        assert_eq!(
            res.engine_fallback_reason.as_deref(),
            Some("missing optional dependency: torch")
        );
        assert!(res.backend_model.is_none());
    }

    #[test]
    fn output_name_rejects_traversal_and_separators() {
        assert!(reject_unsafe_output_name(".").is_err());
        assert!(reject_unsafe_output_name("..").is_err());
        assert!(reject_unsafe_output_name("../evil").is_err());
        assert!(reject_unsafe_output_name("..\\evil").is_err());
        assert!(reject_unsafe_output_name("sub/dir").is_err());
        assert!(reject_unsafe_output_name("/etc/passwd").is_err());
    }
}
