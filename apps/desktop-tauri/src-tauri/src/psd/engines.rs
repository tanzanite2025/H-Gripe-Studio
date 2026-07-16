//! Cross-card capability probe for deterministic local kernels, API-backed
//! cards, and shared media/GPU infrastructure.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EngineAvailability {
    #[serde(default)]
    pub(crate) available: bool,
    #[serde(default)]
    pub(crate) reason: String,
    #[serde(default)]
    pub(crate) accelerated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct CardEngineProbe {
    pub(crate) node_kind: String,
    pub(crate) engines: BTreeMap<String, EngineAvailability>,
    #[serde(default)]
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct BackendProbe {
    #[serde(default)]
    pub(crate) available: bool,
    #[serde(default)]
    pub(crate) detail: String,
}

impl BackendProbe {
    fn from_capability(capability: Result<String, String>) -> Self {
        match capability {
            Ok(detail) => Self {
                available: true,
                detail,
            },
            Err(reason) => Self {
                available: false,
                detail: reason,
            },
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EngineProbeReport {
    pub(crate) cards: Vec<CardEngineProbe>,
    #[serde(default)]
    pub(crate) wgpu: Option<BackendProbe>,
    #[serde(default)]
    pub(crate) ffmpeg: Option<BackendProbe>,
    #[serde(default)]
    pub(crate) ffmpeg_hw: Option<BackendProbe>,
    #[serde(default)]
    pub(crate) ffmpeg_hw_decode: Option<BackendProbe>,
    #[serde(default)]
    pub(crate) display_adapters: Option<BackendProbe>,
}

#[tauri::command]
pub(crate) fn probe_engines(dir: Option<String>) -> Result<EngineProbeReport, String> {
    let _ = dir;
    const CARDS: [(&str, &str, &str); 5] = [
        ("matchLightColor", "cpu", "built-in deterministic Rust path"),
        ("imageEnhance", "cpu", "built-in deterministic Rust path"),
        (
            "detailWatchdog",
            "rules",
            "built-in deterministic Rust rules",
        ),
        ("detailRepaint", "provider", "configured API provider"),
        ("refineMaskEdge", "cpu", "built-in deterministic Rust path"),
    ];

    let cards = CARDS
        .iter()
        .map(|(node_kind, engine, reason)| {
            let mut engines = BTreeMap::new();
            engines.insert(
                (*engine).to_string(),
                EngineAvailability {
                    available: true,
                    reason: (*reason).to_string(),
                    accelerated: false,
                },
            );
            CardEngineProbe {
                node_kind: (*node_kind).to_string(),
                engines,
                error: None,
            }
        })
        .collect();

    Ok(EngineProbeReport {
        cards,
        wgpu: Some(BackendProbe::from_capability(
            crate::studio::grade::wgpu_capability(),
        )),
        ffmpeg: Some(BackendProbe::from_capability(
            crate::studio::video_engine::ffmpeg_capability(),
        )),
        ffmpeg_hw: Some(BackendProbe::from_capability(
            crate::studio::video_engine::ffmpeg_hw_capability(),
        )),
        ffmpeg_hw_decode: Some(BackendProbe::from_capability(
            crate::studio::video_engine::ffmpeg_hw_decode_capability(),
        )),
        display_adapters: Some(BackendProbe::from_capability(
            crate::studio::wgpu_device::display_adapters(),
        )),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_reports_only_executable_builtin_and_api_engines() {
        let report = probe_engines(None).unwrap();
        let expected = [
            ("matchLightColor", "cpu"),
            ("imageEnhance", "cpu"),
            ("detailWatchdog", "rules"),
            ("detailRepaint", "provider"),
            ("refineMaskEdge", "cpu"),
        ];
        for (kind, engine) in expected {
            let card = report
                .cards
                .iter()
                .find(|card| card.node_kind == kind)
                .unwrap();
            assert_eq!(card.engines.len(), 1);
            assert!(card.engines[engine].available);
        }
    }
}
