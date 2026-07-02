// Golden-vector runner: every case in `goldens/*.json` is executed against
// the kernel and asserted within its tolerance. The studio-ui mirror runs
// the exact same files (`gradeKernel.golden.test.ts`), so the two
// implementations are pinned to one spec instead of hand-mirrored.
//
// Three file kinds: `composite` cases exercise the blend/composite primitive
// directly; `doc` cases run a whole `GradeDoc` over an input surface;
// `scopes` cases run the read-only analysers and assert exact integer counts.

use hgripe_grade::{
    apply, composite_over, histogram, vectorscope, waveform, BlendMode, GradeDoc, GradeSpace,
    GradeSurface, Histogram, Vectorscope, Waveform,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum GoldenFile {
    Composite { cases: Vec<CompositeCase> },
    Doc { cases: Vec<DocCase> },
    Scopes { cases: Vec<ScopeCase> },
}

#[derive(Deserialize)]
struct CompositeCase {
    name: String,
    mode: BlendMode,
    opacity: f32,
    mask: Option<Vec<f32>>,
    backdrop: GoldenSurface,
    source: GoldenSurface,
    expected: Vec<f32>,
    tolerance: f32,
}

#[derive(Deserialize)]
struct DocCase {
    name: String,
    doc: GradeDoc,
    input: GoldenSurface,
    expected: Vec<f32>,
    tolerance: f32,
}

#[derive(Deserialize)]
struct ScopeCase {
    name: String,
    scope: ScopeSpec,
    input: GoldenSurface,
    expected: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ScopeSpec {
    Histogram { bins: u32 },
    Waveform { cols: u32, rows: u32 },
    Vectorscope { size: u32 },
}

#[derive(Deserialize)]
struct GoldenSurface {
    w: u32,
    h: u32,
    space: GradeSpace,
    data: Vec<f32>,
}

impl GoldenSurface {
    fn surface(&self) -> GradeSurface {
        GradeSurface {
            w: self.w,
            h: self.h,
            data: self.data.clone(),
            space: self.space,
        }
    }
}

fn assert_close(name: &str, got: &[f32], want: &[f32], tolerance: f32) {
    assert_eq!(got.len(), want.len(), "{name}: length");
    for (i, (&g, &w)) in got.iter().zip(want).enumerate() {
        assert!(
            (g - w).abs() <= tolerance,
            "{name}: sample {i}: got {g}, want {w} (±{tolerance})"
        );
    }
}

#[test]
fn golden_vectors() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("goldens");
    let mut ran = 0;
    for entry in std::fs::read_dir(&dir).expect("goldens dir") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let file: GoldenFile =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read golden"))
                .expect("parse golden");
        match file {
            GoldenFile::Composite { cases } => {
                for case in cases {
                    let mut dst = case.backdrop.surface();
                    composite_over(
                        &mut dst,
                        &case.source.surface(),
                        case.mode,
                        case.opacity,
                        case.mask.as_deref(),
                    );
                    assert_close(&case.name, &dst.data, &case.expected, case.tolerance);
                    ran += 1;
                }
            }
            GoldenFile::Doc { cases } => {
                for case in cases {
                    let mut surface = case.input.surface();
                    apply(&case.doc, &mut surface);
                    assert_close(&case.name, &surface.data, &case.expected, case.tolerance);
                    ran += 1;
                }
            }
            GoldenFile::Scopes { cases } => {
                for case in cases {
                    let surface = case.input.surface();
                    let name = &case.name;
                    match case.scope {
                        ScopeSpec::Histogram { bins } => {
                            let want: Histogram =
                                serde_json::from_value(case.expected).expect("histogram expected");
                            assert_eq!(histogram(&surface, bins), want, "{name}");
                        }
                        ScopeSpec::Waveform { cols, rows } => {
                            let want: Waveform =
                                serde_json::from_value(case.expected).expect("waveform expected");
                            assert_eq!(waveform(&surface, cols, rows), want, "{name}");
                        }
                        ScopeSpec::Vectorscope { size } => {
                            let want: Vectorscope = serde_json::from_value(case.expected)
                                .expect("vectorscope expected");
                            assert_eq!(vectorscope(&surface, size), want, "{name}");
                        }
                    }
                    ran += 1;
                }
            }
        }
    }
    assert!(ran > 0, "no golden cases found in {}", dir.display());
}
