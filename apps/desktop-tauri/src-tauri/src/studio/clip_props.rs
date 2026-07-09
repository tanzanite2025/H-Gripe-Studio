//! Per-clip property document (Properties panel): transform / crop values
//! plus optional per-property keyframe tracks. This is the backend's single
//! source of truth for evaluating a clip's properties at a timeline time —
//! the render/export path resolves documents here, and the TS panel mirrors
//! the exact same evaluation semantics (`studio-ui/src/production/keyframes.ts`,
//! contract pinned by the shared fixtures in
//! `studio-ui/src/production/clipPropsKeyframeFixtures.json`):
//! - a property without keyframes takes its static document value;
//! - keyframes are evaluated sorted by time, held before the first and after
//!   the last key, and linearly interpolated in between;
//! - resolved values pass through the same clamps as the static document
//!   (scale 0..=10000%, opacity/crop edges 0..=100%, opposite crop edges
//!   summing to at most 100%).

#![allow(dead_code)] // consumed by the export/preview application step next

use std::collections::BTreeMap;

use serde::Deserialize;

pub(crate) const MIN_SCALE_PCT: f64 = 0.0;
pub(crate) const MAX_SCALE_PCT: f64 = 10000.0;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub(crate) struct Vec2 {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipTransform {
    pub(crate) position: Vec2,
    pub(crate) anchor: Vec2,
    pub(crate) scale_pct: f64,
    pub(crate) rotation_deg: f64,
    pub(crate) opacity_pct: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipCrop {
    pub(crate) left_pct: f64,
    pub(crate) top_pct: f64,
    pub(crate) right_pct: f64,
    pub(crate) bottom_pct: f64,
}

/// One keyframe on a property track: value `v` at clip-local time `t` seconds.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub(crate) struct Keyframe {
    pub(crate) t: f64,
    pub(crate) v: f64,
}

/// The serialized document as the TS store keeps it (`ClipProperties`),
/// tracks keyed by property path (e.g. `transform.scalePct`, `crop.leftPct`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ClipPropsDoc {
    pub(crate) transform: ClipTransform,
    pub(crate) crop: ClipCrop,
    #[serde(default)]
    pub(crate) tracks: BTreeMap<String, Vec<Keyframe>>,
}

/// A document resolved at a single time: plain values, no tracks.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ResolvedClipProps {
    pub(crate) transform: ClipTransform,
    pub(crate) crop: ClipCrop,
}

impl ResolvedClipProps {
    /// True when the resolved values equal the document defaults, i.e. the
    /// frame passes through untouched.
    pub(crate) fn is_identity(&self) -> bool {
        let t = &self.transform;
        let c = &self.crop;
        t.position.x == 0.0
            && t.position.y == 0.0
            && t.anchor.x == 0.0
            && t.anchor.y == 0.0
            && t.scale_pct == 100.0
            && t.rotation_deg == 0.0
            && t.opacity_pct == 100.0
            && c.left_pct == 0.0
            && c.top_pct == 0.0
            && c.right_pct == 0.0
            && c.bottom_pct == 0.0
    }
}

pub(crate) fn parse_clip_props_doc(json: &str) -> Result<ClipPropsDoc, String> {
    serde_json::from_str(json).map_err(|err| format!("invalid clip props doc: {err}"))
}

/// Evaluate one track at `t`: keys sorted by time, endpoint hold outside the
/// span, linear interpolation inside. Empty tracks yield the static value.
fn evaluate_track(keys: &[Keyframe], static_value: f64, t: f64) -> f64 {
    let mut sorted: Vec<Keyframe> = keys
        .iter()
        .copied()
        .filter(|k| k.t.is_finite() && k.v.is_finite())
        .collect();
    if sorted.is_empty() {
        return static_value;
    }
    sorted.sort_by(|a, b| a.t.total_cmp(&b.t));
    let first = sorted[0];
    let last = sorted[sorted.len() - 1];
    if t <= first.t {
        return first.v;
    }
    if t >= last.t {
        return last.v;
    }
    for pair in sorted.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if t <= b.t {
            if b.t <= a.t {
                return b.v;
            }
            let alpha = (t - a.t) / (b.t - a.t);
            return a.v + (b.v - a.v) * alpha;
        }
    }
    last.v
}

fn track_value(doc: &ClipPropsDoc, path: &str, static_value: f64, t: f64) -> f64 {
    match doc.tracks.get(path) {
        Some(keys) => evaluate_track(keys, static_value, t),
        None => static_value,
    }
}

fn clamp_pct(value: f64) -> f64 {
    value.clamp(0.0, 100.0)
}

fn finite(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

/// Resolve the document at clip-local time `t` (seconds): every property is
/// evaluated through its track (static value when trackless) and the result
/// clamped with the same rules as the static document.
pub(crate) fn resolve_clip_props_at(doc: &ClipPropsDoc, t: f64) -> ResolvedClipProps {
    let tr = &doc.transform;
    let cr = &doc.crop;
    let left_pct = clamp_pct(finite(
        track_value(doc, "crop.leftPct", cr.left_pct, t),
        0.0,
    ));
    let top_pct = clamp_pct(finite(track_value(doc, "crop.topPct", cr.top_pct, t), 0.0));
    ResolvedClipProps {
        transform: ClipTransform {
            position: Vec2 {
                x: finite(
                    track_value(doc, "transform.position.x", tr.position.x, t),
                    0.0,
                ),
                y: finite(
                    track_value(doc, "transform.position.y", tr.position.y, t),
                    0.0,
                ),
            },
            anchor: Vec2 {
                x: finite(track_value(doc, "transform.anchor.x", tr.anchor.x, t), 0.0),
                y: finite(track_value(doc, "transform.anchor.y", tr.anchor.y, t), 0.0),
            },
            scale_pct: finite(
                track_value(doc, "transform.scalePct", tr.scale_pct, t),
                100.0,
            )
            .clamp(MIN_SCALE_PCT, MAX_SCALE_PCT),
            rotation_deg: finite(
                track_value(doc, "transform.rotationDeg", tr.rotation_deg, t),
                0.0,
            ),
            opacity_pct: clamp_pct(finite(
                track_value(doc, "transform.opacityPct", tr.opacity_pct, t),
                100.0,
            )),
        },
        crop: ClipCrop {
            left_pct,
            top_pct,
            right_pct: clamp_pct(finite(
                track_value(doc, "crop.rightPct", cr.right_pct, t),
                0.0,
            ))
            .min(100.0 - left_pct),
            bottom_pct: clamp_pct(finite(
                track_value(doc, "crop.bottomPct", cr.bottom_pct, t),
                0.0,
            ))
            .min(100.0 - top_pct),
        },
    }
}

/// Resolve a single property path at `t` (fixture-test seam; the export path
/// uses [`resolve_clip_props_at`]).
pub(crate) fn resolve_clip_prop_at(doc: &ClipPropsDoc, path: &str, t: f64) -> Option<f64> {
    let resolved = resolve_clip_props_at(doc, t);
    let tr = &resolved.transform;
    let cr = &resolved.crop;
    Some(match path {
        "transform.position.x" => tr.position.x,
        "transform.position.y" => tr.position.y,
        "transform.anchor.x" => tr.anchor.x,
        "transform.anchor.y" => tr.anchor.y,
        "transform.scalePct" => tr.scale_pct,
        "transform.rotationDeg" => tr.rotation_deg,
        "transform.opacityPct" => tr.opacity_pct,
        "crop.leftPct" => cr.left_pct,
        "crop.topPct" => cr.top_pct,
        "crop.rightPct" => cr.right_pct,
        "crop.bottomPct" => cr.bottom_pct,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(json: &str) -> ClipPropsDoc {
        parse_clip_props_doc(json).expect("doc parses")
    }

    const STATIC_DOC: &str = r#"{
        "transform": {
            "position": {"x": 12, "y": -8},
            "anchor": {"x": 0, "y": 0},
            "scalePct": 80,
            "rotationDeg": 15,
            "opacityPct": 90
        },
        "crop": {"leftPct": 5, "topPct": 0, "rightPct": 0, "bottomPct": 10}
    }"#;

    #[test]
    fn static_doc_resolves_to_its_values_at_any_time() {
        let d = doc(STATIC_DOC);
        for t in [0.0, 1.5, 100.0] {
            let r = resolve_clip_props_at(&d, t);
            assert_eq!(r.transform.position.x, 12.0);
            assert_eq!(r.transform.scale_pct, 80.0);
            assert_eq!(r.crop.bottom_pct, 10.0);
        }
    }

    #[test]
    fn interpolates_between_keys_and_holds_at_the_ends() {
        let d = doc(r#"{
            "transform": {
                "position": {"x": 0, "y": 0}, "anchor": {"x": 0, "y": 0},
                "scalePct": 100, "rotationDeg": 0, "opacityPct": 100
            },
            "crop": {"leftPct": 0, "topPct": 0, "rightPct": 0, "bottomPct": 0},
            "tracks": {"transform.scalePct": [{"t": 1, "v": 100}, {"t": 3, "v": 50}]}
        }"#);
        assert_eq!(
            resolve_clip_prop_at(&d, "transform.scalePct", 0.0),
            Some(100.0)
        );
        assert_eq!(
            resolve_clip_prop_at(&d, "transform.scalePct", 2.0),
            Some(75.0)
        );
        assert_eq!(
            resolve_clip_prop_at(&d, "transform.scalePct", 99.0),
            Some(50.0)
        );
    }

    #[test]
    fn resolved_values_are_clamped() {
        let d = doc(r#"{
            "transform": {
                "position": {"x": 0, "y": 0}, "anchor": {"x": 0, "y": 0},
                "scalePct": 100, "rotationDeg": 0, "opacityPct": 100
            },
            "crop": {"leftPct": 0, "topPct": 0, "rightPct": 0, "bottomPct": 0},
            "tracks": {
                "transform.opacityPct": [{"t": 0, "v": 100}, {"t": 1, "v": 300}],
                "crop.leftPct": [{"t": 0, "v": 70}],
                "crop.rightPct": [{"t": 0, "v": 60}]
            }
        }"#);
        let r = resolve_clip_props_at(&d, 1.0);
        assert_eq!(r.transform.opacity_pct, 100.0);
        assert_eq!(r.crop.left_pct, 70.0);
        assert_eq!(r.crop.right_pct, 30.0);
    }

    #[test]
    fn identity_detection() {
        let d = doc(r#"{
            "transform": {
                "position": {"x": 0, "y": 0}, "anchor": {"x": 0, "y": 0},
                "scalePct": 100, "rotationDeg": 0, "opacityPct": 100
            },
            "crop": {"leftPct": 0, "topPct": 0, "rightPct": 0, "bottomPct": 0}
        }"#);
        assert!(resolve_clip_props_at(&d, 0.0).is_identity());
        assert!(!resolve_clip_props_at(&doc(STATIC_DOC), 0.0).is_identity());
    }

    #[test]
    fn rejects_malformed_documents() {
        assert!(parse_clip_props_doc("not json").is_err());
        assert!(parse_clip_props_doc("{}").is_err());
    }

    /// The shared contract with the TS evaluator: both sides must reproduce
    /// the samples in `clipPropsKeyframeFixtures.json` exactly.
    #[test]
    fn matches_the_shared_keyframe_fixtures() {
        #[derive(Deserialize)]
        struct Sample {
            path: String,
            t: f64,
            expected: f64,
        }
        #[derive(Deserialize)]
        struct Case {
            name: String,
            doc: ClipPropsDoc,
            samples: Vec<Sample>,
        }
        #[derive(Deserialize)]
        struct Fixtures {
            cases: Vec<Case>,
        }
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../studio-ui/src/production/clipPropsKeyframeFixtures.json"
        );
        let raw = std::fs::read_to_string(path).expect("fixtures readable");
        let fixtures: Fixtures = serde_json::from_str(&raw).expect("fixtures parse");
        assert!(!fixtures.cases.is_empty());
        for case in &fixtures.cases {
            for sample in &case.samples {
                let got = resolve_clip_prop_at(&case.doc, &sample.path, sample.t)
                    .unwrap_or_else(|| panic!("{}: unknown path {}", case.name, sample.path));
                assert!(
                    (got - sample.expected).abs() < 1e-9,
                    "{}: {} at t={} — expected {}, got {}",
                    case.name,
                    sample.path,
                    sample.t,
                    sample.expected,
                    got
                );
            }
        }
    }
}
