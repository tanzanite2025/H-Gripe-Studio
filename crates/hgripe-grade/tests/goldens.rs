// Golden-vector runner: every case in `goldens/*.json` is executed against
// the kernel and asserted within its tolerance. The studio-ui mirror runs
// the exact same files (`gradeKernel.golden.test.ts`), so the two
// implementations are pinned to one spec instead of hand-mirrored.

use hgripe_grade::{composite_over, BlendMode, GradeSpace, GradeSurface};
use serde::Deserialize;

#[derive(Deserialize)]
struct GoldenFile {
    cases: Vec<GoldenCase>,
}

#[derive(Deserialize)]
struct GoldenCase {
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
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read golden")).expect("parse golden");
        for case in file.cases {
            let mut dst = case.backdrop.surface();
            composite_over(&mut dst, &case.source.surface(), case.mode, case.opacity, case.mask.as_deref());
            assert_eq!(dst.data.len(), case.expected.len(), "{}: length", case.name);
            for (i, (&got, &want)) in dst.data.iter().zip(&case.expected).enumerate() {
                assert!(
                    (got - want).abs() <= case.tolerance,
                    "{}: sample {i}: got {got}, want {want} (±{})",
                    case.name,
                    case.tolerance
                );
            }
            ran += 1;
        }
    }
    assert!(ran > 0, "no golden cases found in {}", dir.display());
}
