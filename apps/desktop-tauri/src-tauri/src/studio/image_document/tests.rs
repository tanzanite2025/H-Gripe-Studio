use super::*;
use image::Rgba;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageDocumentFixtures {
    rgba_composite_cases: Vec<RgbaCompositeCase>,
    transform_compose_cases: Vec<TransformComposeCase>,
    transform_inverse_sample_cases: Vec<TransformInverseSampleCase>,
}

#[derive(Deserialize)]
struct TransformCaseParams {
    dx: f32,
    dy: f32,
    scale: f32,
    rotate: f32,
}

impl From<&TransformCaseParams> for LayerTransform {
    fn from(params: &TransformCaseParams) -> Self {
        LayerTransform {
            dx: params.dx,
            dy: params.dy,
            scale: params.scale,
            rotate: params.rotate,
        }
    }
}

#[derive(Deserialize)]
struct TransformComposeCase {
    name: String,
    a: TransformCaseParams,
    b: TransformCaseParams,
    expected: TransformCaseParams,
}

#[derive(Deserialize)]
struct TransformInverseSampleCase {
    name: String,
    width: u32,
    height: u32,
    transform: TransformCaseParams,
    x: u32,
    y: u32,
    expected: Option<[f32; 2]>,
}

#[derive(Deserialize)]
struct RgbaCompositeCase {
    name: String,
    mode: String,
    backdrop: [u8; 4],
    source: [u8; 4],
    opacity: f64,
    expected: [u8; 4],
}

fn contract_fixtures() -> ImageDocumentFixtures {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../studio-ui/src/editor/imageDocumentContractFixtures.json"
    );
    let raw = std::fs::read_to_string(path).expect("image-document fixtures readable");
    serde_json::from_str::<ImageDocumentFixtures>(&raw).expect("image-document fixtures parse")
}

#[test]
fn compose_matches_the_shared_transform_contract() {
    let cases = contract_fixtures().transform_compose_cases;
    assert!(!cases.is_empty());
    for case in cases {
        let composed =
            compose_layer_transform(LayerTransform::from(&case.a), LayerTransform::from(&case.b));
        let expected = LayerTransform::from(&case.expected);
        assert!(
            (composed.dx - expected.dx).abs() < 1e-4,
            "{}: dx",
            case.name
        );
        assert!(
            (composed.dy - expected.dy).abs() < 1e-4,
            "{}: dy",
            case.name
        );
        assert!(
            (composed.scale - expected.scale).abs() < 1e-4,
            "{}: scale",
            case.name
        );
        assert!(
            (composed.rotate - expected.rotate).abs() < 1e-4,
            "{}: rotate",
            case.name
        );
    }
}

#[test]
fn inverse_sample_matches_the_shared_transform_contract() {
    let cases = contract_fixtures().transform_inverse_sample_cases;
    assert!(!cases.is_empty());
    for case in cases {
        let sample = inverse_layer_sample(
            case.x,
            case.y,
            case.width,
            case.height,
            LayerTransform::from(&case.transform),
        );
        match (sample, case.expected) {
            (Some((sx, sy)), Some([ex, ey])) => {
                assert!((sx - ex).abs() < 1e-4, "{}: sx", case.name);
                assert!((sy - ey).abs() < 1e-4, "{}: sy", case.name);
            }
            (None, None) => {}
            (sample, expected) => panic!(
                "{}: sample {:?} does not match expected {:?}",
                case.name, sample, expected
            ),
        }
    }
}

#[test]
fn composite_matches_the_shared_rgba_contract() {
    let cases = contract_fixtures().rgba_composite_cases;
    assert!(!cases.is_empty());
    for case in cases {
        let mut source = RgbaImage::new(2, 1);
        source.put_pixel(0, 0, Rgba(case.source));
        source.put_pixel(1, 0, Rgba(case.backdrop));
        let document = json!({
            "layers": [
                {
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [{ "type": "source_image", "placement": [0.0, 0.0, 2.0, 1.0] }]
                },
                {
                    "kind": "mask",
                    "visible": true,
                    "opacity": case.opacity,
                    "blend": case.mode,
                    "ops": [
                        { "type": "source_image", "placement": [0.0, 0.0, 2.0, 1.0] },
                        { "type": "transform", "dx": 1.0 }
                    ]
                }
            ]
        });
        let output = composite_image_document(&source, &document, 2, 1).expect("composite image");
        assert_eq!(output.get_pixel(1, 0).0, case.expected, "{}", case.name);
    }
}

#[test]
fn placed_layer_draws_its_own_image_without_clipping_others() {
    let source = RgbaImage::from_pixel(4, 4, Rgba([255, 0, 0, 255]));
    let document = json!({
        "layers": [
            {
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [{ "type": "source_image", "placement": [0.0, 0.0, 4.0, 4.0] }]
            },
            {
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [
                    {
                        "type": "source_image",
                        "source": { "path": "green.png", "width": 2, "height": 2 },
                        "placement": [1.0, 1.0, 3.0, 3.0]
                    }
                ]
            }
        ]
    });
    let mut load = |path: &str| {
        assert_eq!(path, "green.png");
        Ok(RgbaImage::from_pixel(2, 2, Rgba([0, 255, 0, 255])))
    };
    let output = composite_image_document_with_sources(&source, &document, 4, 4, 4, &mut load)
        .expect("composite placed layer");
    // Outside the placement the base layer still shows (not clipped).
    assert_eq!(output.get_pixel(0, 0).0, [255, 0, 0, 255]);
    assert_eq!(output.get_pixel(3, 3).0, [255, 0, 0, 255]);
    // Inside the placement the layer's own image draws.
    assert_eq!(output.get_pixel(1, 1).0, [0, 255, 0, 255]);
    assert_eq!(output.get_pixel(2, 2).0, [0, 255, 0, 255]);
}

#[test]
fn source_image_clip_rasterizes_exact_selection_alpha() {
    let source = RgbaImage::from_pixel(4, 2, Rgba([255, 0, 0, 255]));
    let document = json!({
        "layers": [
            {
                "kind": "mask",
                "visible": false,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [{ "type": "source_image", "placement": [0.0, 0.0, 4.0, 2.0] }]
            },
            {
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [
                    {
                        "type": "source_image",
                        "source": { "path": "green.png", "width": 4, "height": 2 },
                        "placement": [0.0, 0.0, 4.0, 2.0],
                        "clip": {
                            "region": [0.0, 0.0, 4.0, 2.0],
                            "selectionAlpha": { "width": 4, "height": 2, "startsWith": 0, "runs": [1, 2, 2, 3] }
                        }
                    }
                ]
            }
        ]
    });
    let mut load = |path: &str| {
        assert_eq!(path, "green.png");
        Ok(RgbaImage::from_pixel(4, 2, Rgba([0, 255, 0, 255])))
    };

    let output = composite_image_document_with_sources(&source, &document, 4, 2, 4, &mut load)
        .expect("composite selection-alpha clip");

    assert_eq!(output.dimensions(), (4, 2));
    assert_eq!(output.get_pixel(0, 0).0, [0, 0, 0, 0]);
    assert_eq!(output.get_pixel(1, 0).0, [0, 255, 0, 255]);
    assert_eq!(output.get_pixel(2, 0).0, [0, 255, 0, 255]);
    assert_eq!(output.get_pixel(3, 0).0, [0, 0, 0, 0]);
    assert_eq!(output.get_pixel(0, 1).0, [0, 0, 0, 0]);
    assert_eq!(output.get_pixel(1, 1).0, [0, 255, 0, 255]);
    assert_eq!(output.get_pixel(2, 1).0, [0, 255, 0, 255]);
    assert_eq!(output.get_pixel(3, 1).0, [0, 255, 0, 255]);
}

#[test]
fn source_image_clip_rejects_malformed_selection_alpha_runs() {
    let source = RgbaImage::from_pixel(2, 2, Rgba([255, 0, 0, 255]));
    let document = json!({
        "layers": [
            {
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [
                    {
                        "type": "source_image",
                        "placement": [0.0, 0.0, 2.0, 2.0],
                        "clip": {
                            "region": [0.0, 0.0, 2.0, 2.0],
                            "selectionAlpha": { "width": 2, "height": 2, "startsWith": 0, "runs": [1, 1] }
                        }
                    }
                ]
            }
        ]
    });

    let err = composite_image_document_with_sources(&source, &document, 2, 2, 2, &mut |_| {
        Err("unused".into())
    })
    .expect_err("malformed selection-alpha clips must not fall back to a rect");

    assert!(err.contains("runs do not cover dimensions"));
}

#[test]
fn scene_frame_renders_placed_layers_outside_the_document_rect() {
    let source = RgbaImage::from_pixel(4, 4, Rgba([255, 0, 0, 255]));
    let document = json!({
        "layers": [
            {
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [{ "type": "source_image", "placement": [0.0, 0.0, 4.0, 4.0] }]
            },
            {
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [
                    {
                        "type": "source_image",
                        "source": { "path": "green.png", "width": 4, "height": 4 },
                        "placement": [1.0, 5.0, 3.0, 7.0]
                    }
                ]
            }
        ]
    });
    let mut load = |path: &str| {
        assert_eq!(path, "green.png");
        Ok(RgbaImage::from_pixel(4, 4, Rgba([0, 255, 0, 255])))
    };
    let output = composite_image_document_with_sources_in_frame(
        &source, &document, 4, 4, 0.0, 0.0, 4, 8, 8, &mut load,
    )
    .expect("composite scene frame");
    assert_eq!(output.dimensions(), (4, 8));
    assert_eq!(output.get_pixel(2, 2).0, [255, 0, 0, 255]);
    assert_eq!(output.get_pixel(1, 5).0, [0, 255, 0, 255]);
    // The base image belongs to the document rect only; the pasteboard
    // below it is not filled unless a layer is actually placed there.
    assert_eq!(output.get_pixel(0, 7).0, [0, 0, 0, 0]);
}

#[test]
fn scene_frame_sanitizes_non_finite_origin() {
    let source = RgbaImage::from_pixel(4, 4, Rgba([255, 0, 0, 255]));
    let document = json!({
        "layers": [
            {
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [{ "type": "source_image", "placement": [0.0, 0.0, 4.0, 4.0] }]
            }
        ]
    });
    let output = composite_image_document_with_sources_in_frame(
        &source,
        &document,
        4,
        4,
        f32::NAN,
        f32::INFINITY,
        4,
        4,
        4,
        &mut |_| Err("unused".into()),
    )
    .expect("composite with non-finite frame origin");
    assert_eq!(output.dimensions(), (4, 4));
    assert_eq!(output.get_pixel(0, 0).0, [255, 0, 0, 255]);
}

#[test]
fn extreme_layer_transform_is_rejected_before_sampling() {
    let source = RgbaImage::from_pixel(4, 4, Rgba([255, 0, 0, 255]));
    let document = json!({
        "layers": [
            {
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [
                    { "type": "source_image", "placement": [0.0, 0.0, 4.0, 4.0] },
                    { "type": "transform", "dx": 1.0e300, "dy": -1.0e300, "scale": 1.0e300, "rotate": 1.0e300 }
                ]
            }
        ]
    });
    let error = composite_image_document_with_sources(&source, &document, 4, 4, 4, &mut |_| {
        Err("unused".into())
    })
    .expect_err("extreme transform must be rejected before sampling");
    assert!(error.contains("exceeds the world limit"), "{error}");
}

#[test]
fn output_follows_the_document_size_not_the_shared_proxy() {
    // A small opened image must not drop a larger canvas's resolution:
    // the composite output is document-proportioned within the limit.
    let source = RgbaImage::from_pixel(2, 2, Rgba([255, 0, 0, 255]));
    let document = json!({
        "layers": [
            {
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [{ "type": "source_image", "placement": [0.0, 0.0, 8.0, 4.0] }]
            }
        ]
    });
    let output = composite_image_document_with_sources(&source, &document, 8, 4, 8, &mut |_| {
        Err("unused".into())
    })
    .expect("composite at document size");
    assert_eq!(output.dimensions(), (8, 4));
    assert_eq!(output.get_pixel(0, 0).0, [255, 0, 0, 255]);
    assert_eq!(output.get_pixel(7, 3).0, [255, 0, 0, 255]);
    // The limit caps the output without changing the aspect.
    let capped = composite_image_document_with_sources(&source, &document, 8, 4, 4, &mut |_| {
        Err("unused".into())
    })
    .expect("composite capped");
    assert_eq!(capped.dimensions(), (4, 2));
}

#[test]
fn hidden_base_keeps_a_transformed_placed_layer_visible() {
    // Hiding the opened base layer must not blank a moved placed layer:
    // the placed layer still draws its own source through its transform.
    let source = RgbaImage::from_pixel(8, 8, Rgba([255, 0, 0, 255]));
    let mut load = |_: &str| Ok(RgbaImage::from_pixel(4, 4, Rgba([0, 255, 0, 255])));
    let doc = |base_visible: bool, dx: f64| {
        json!({
            "layers": [
                {
                    "kind": "mask",
                    "visible": base_visible,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [{ "type": "source_image", "placement": [0.0, 0.0, 8.0, 8.0] }]
                },
                {
                    "kind": "mask",
                    "visible": true,
                    "opacity": 1.0,
                    "blend": "normal",
                    "ops": [
                        {
                            "type": "source_image",
                            "source": { "path": "green.png", "width": 4, "height": 4 },
                            "placement": [2.0, 2.0, 6.0, 6.0]
                        },
                        { "type": "transform", "dx": dx, "dy": 0.0 }
                    ]
                }
            ]
        })
    };
    for (name, base_visible, dx) in [
        ("base visible, unmoved", true, 0.0),
        ("base hidden, unmoved", false, 0.0),
        ("base visible, moved", true, 1.0),
        ("base hidden, moved", false, 1.0),
    ] {
        let out = composite_image_document_with_sources(
            &source,
            &doc(base_visible, dx),
            8,
            8,
            8,
            &mut load,
        )
        .expect("composite");
        let green = out.pixels().filter(|p| p.0 == [0, 255, 0, 255]).count();
        assert_eq!(green, 16, "placed layer pixels missing: {name}");
        let opaque = out.pixels().filter(|p| p.0[3] > 0).count();
        let expected = if base_visible { 64 } else { 16 };
        assert_eq!(opaque, expected, "unexpected coverage: {name}");
    }
}

#[test]
fn invalid_source_image_layers_are_not_presented_or_framed() {
    let source = RgbaImage::from_pixel(4, 4, Rgba([255, 0, 0, 255]));
    for (name, op) in [
        (
            "missing placement",
            json!({ "type": "source_image", "source": { "width": 4, "height": 4 } }),
        ),
        (
            "disabled source",
            json!({ "type": "source_image", "disabled": true, "placement": [0, 0, 4, 4] }),
        ),
        (
            "empty placement",
            json!({ "type": "source_image", "placement": [2, 2, 2, 4] }),
        ),
        (
            "string placement coordinate",
            json!({ "type": "source_image", "placement": ["0", 0, 4, 4] }),
        ),
        (
            "null placement coordinate",
            json!({ "type": "source_image", "placement": [null, 0, 4, 4] }),
        ),
    ] {
        let document = json!({
            "layers": [{
                "id": "invalid",
                "kind": "pixel",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [op]
            }]
        });
        let output = composite_image_document(&source, &document, 4, 4)
            .unwrap_or_else(|err| panic!("{name}: {err}"));
        assert!(
            output.pixels().all(|pixel| pixel.0 == [0, 0, 0, 0]),
            "{name} unexpectedly presented pixels"
        );
        assert!(
            selected_layer_frame(&document, "invalid", 4, 4, None)
                .expect("resolve invalid selected frame")
                .is_none(),
            "{name} unexpectedly produced a selected-layer frame"
        );
    }
}

#[test]
fn selection_assist_read_materializes_only_the_selected_pixel_layer() {
    let source = RgbaImage::from_pixel(6, 6, Rgba([255, 0, 0, 255]));
    let document = json!({
        "layers": [
            {
                "id": "base",
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [{ "type": "source_image", "placement": [0.0, 0.0, 6.0, 6.0] }]
            },
            {
                "id": "picked",
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [
                    {
                        "type": "source_image",
                        "source": { "path": "green.png", "width": 2, "height": 2 },
                        "placement": [2.0, 2.0, 4.0, 4.0]
                    }
                ]
            }
        ]
    });
    let mut load = |path: &str| match path {
        "green.png" => Ok(RgbaImage::from_pixel(2, 2, Rgba([0, 255, 0, 255]))),
        other => Err(format!("unexpected source {other}")),
    };

    let out = selection_assist_layer_pixels_in_frame(
        &source, &document, "picked", 6, 6, 0.0, 0.0, 6, 6, 6, &mut load,
    )
    .expect("assist pixels");

    assert_eq!(out.dimensions(), (6, 6));
    assert_eq!(out.get_pixel(2, 2).0, [0, 255, 0, 255]);
    assert_eq!(out.get_pixel(0, 0).0, [0, 0, 0, 0]);
    assert!(
        out.pixels().all(|p| p.0 != [255, 0, 0, 255]),
        "assist read must not include the lower base layer"
    );
}

#[test]
fn selection_assist_read_rejects_non_pixel_layers() {
    let source = RgbaImage::from_pixel(2, 2, Rgba([255, 0, 0, 255]));
    let document = json!({
        "layers": [
            {
                "id": "adjustment",
                "kind": "adjustment",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": []
            }
        ]
    });
    let mut load = |_: &str| Err("unused".into());

    let err = selection_assist_layer_pixels_in_frame(
        &source,
        &document,
        "adjustment",
        2,
        2,
        0.0,
        0.0,
        2,
        2,
        2,
        &mut load,
    )
    .expect_err("adjustment layers cannot be assist-read sources");

    assert!(err.contains("not an active editable pixel layer"));
}

#[test]
fn selected_layer_frame_resolves_layer_placement_and_transform() {
    let document = json!({
        "layers": [
            {
                "id": "layer-photo",
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [
                    {
                        "type": "source_image",
                        "source": { "path": "photo.png", "width": 80, "height": 40 },
                        "placement": [-20.0, 10.0, 60.0, 50.0]
                    },
                    { "type": "transform", "dx": 5.0, "dy": -2.0 }
                ]
            }
        ]
    });

    let frame = selected_layer_frame(&document, "layer-photo", 100, 80, None)
        .expect("resolve selected frame")
        .expect("selected frame");

    assert_eq!(frame.owner, "selected-layer-frame");
    assert_eq!(frame.shape, "axis-aligned-rect");
    assert_eq!(frame.layer_id, "layer-photo");
    assert_eq!(frame.source_rect, [-20.0, 10.0, 60.0, 50.0]);
    assert_eq!(frame.rect, [-15.0, 8.0, 65.0, 48.0]);
    assert_eq!(frame.source, "asset-frame");
}

#[test]
fn scene_frame_composite_alpha_bounds_match_projected_selected_layer_placement() {
    let document_width = 6;
    let document_height = 4;
    let scene_frame = CompositeFrame::new(-3.0, -2.0, 12, 8);
    let document = json!({
        "layers": [
            {
                "id": "layer-full-canvas",
                "kind": "pixel",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [
                    {
                        "type": "source_image",
                        "source": { "path": "full-canvas.png", "width": 6, "height": 4 },
                        "placement": [0.0, 0.0, 6.0, 4.0]
                    }
                ]
            }
        ]
    });
    let source = RgbaImage::new(document_width, document_height);
    let mut load = |path: &str| {
        assert_eq!(path, "full-canvas.png");
        Ok(RgbaImage::from_pixel(
            document_width,
            document_height,
            Rgba([20, 80, 160, 255]),
        ))
    };
    let output = composite_image_document_with_sources_in_frame(
        &source,
        &document,
        document_width,
        document_height,
        scene_frame.x,
        scene_frame.y,
        scene_frame.w as u32,
        scene_frame.h as u32,
        scene_frame.w as u32,
        &mut load,
    )
    .expect("composite full-canvas layer in pasteboard frame");

    let mut alpha_bounds: Option<[u32; 4]> = None;
    for (x, y, pixel) in output.enumerate_pixels() {
        if pixel[3] == 0 {
            continue;
        }
        alpha_bounds = Some(match alpha_bounds {
            Some([x0, y0, x1, y1]) => [x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1)],
            None => [x, y, x + 1, y + 1],
        });
    }

    let selected = selected_layer_frame(
        &document,
        "layer-full-canvas",
        document_width,
        document_height,
        None,
    )
    .expect("resolve selected full-canvas frame")
    .expect("selected full-canvas frame");
    let sx = scene_frame.sx(output.width());
    let sy = scene_frame.sy(output.height());
    let projected_rect = [
        ((selected.rect[0] - scene_frame.x) * sx).round() as u32,
        ((selected.rect[1] - scene_frame.y) * sy).round() as u32,
        ((selected.rect[2] - scene_frame.x) * sx).round() as u32,
        ((selected.rect[3] - scene_frame.y) * sy).round() as u32,
    ];

    assert_eq!(selected.rect, [0.0, 0.0, 6.0, 4.0]);
    assert_eq!(alpha_bounds, Some(projected_rect));
    assert_eq!(projected_rect, [3, 2, 9, 6]);
}

#[test]
fn selected_layer_frame_uses_source_placement_and_ignores_clip_regions() {
    let document = json!({
        "layers": [
            {
                "id": "layer-with-mask",
                "kind": "mask",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": [
                    {
                        "type": "source_image",
                        "source": { "path": "photo.png", "width": 100, "height": 80 },
                        "placement": [0.0, 0.0, 100.0, 80.0],
                        "clip": { "region": [40.0, 20.0, 65.0, 45.0] }
                    },
                    {
                        "type": "invert",
                        "clip": { "region": [2.0, 3.0, 20.0, 30.0] }
                    }
                ],
                "mask": {
                    "id": "mask-1",
                    "ops": [{ "type": "rect", "region": [2.0, 3.0, 20.0, 30.0] }]
                }
            }
        ]
    });

    let frame = selected_layer_frame(
        &document,
        "layer-with-mask",
        100,
        80,
        Some(SelectedLayerMoveDraft { dx: 7.0, dy: 9.0 }),
    )
    .expect("resolve selected frame")
    .expect("selected frame");

    assert_eq!(frame.source_rect, [0.0, 0.0, 100.0, 80.0]);
    assert_eq!(frame.rect, [7.0, 9.0, 107.0, 89.0]);
}

#[test]
fn selected_layer_frame_requires_explicit_source_placement() {
    let document = json!({
        "layers": [
            {
                "id": "source-without-placement",
                "kind": "pixel",
                "visible": true,
                "opacity": 1.0,
                "ops": [
                    {
                        "type": "source_image",
                        "source": { "path": "photo.png", "width": 320, "height": 180 }
                    }
                ]
            }
        ]
    });

    assert!(
        selected_layer_frame(&document, "source-without-placement", 800, 600, None,)
            .expect("resolve frame without placement")
            .is_none()
    );
}

#[test]
fn selected_layer_frame_returns_none_for_non_image_layers() {
    let document = json!({
        "layers": [
            {
                "id": "adjustment",
                "kind": "adjustment",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": []
            }
        ]
    });

    assert!(selected_layer_frame(&document, "adjustment", 100, 80, None)
        .expect("resolve adjustment frame")
        .is_none());
    assert!(selected_layer_frame(&document, "missing", 100, 80, None)
        .expect("resolve missing frame")
        .is_none());
}

#[test]
fn selected_layer_frame_requires_an_explicit_source_image_op() {
    let document = json!({
        "layers": [
            {
                "id": "empty-base",
                "kind": "pixel",
                "visible": true,
                "opacity": 1.0,
                "blend": "normal",
                "ops": []
            }
        ]
    });

    assert!(
        selected_layer_frame(&document, "empty-base", 800, 600, None)
            .expect("resolve empty base frame")
            .is_none()
    );
}

#[test]
fn missing_layer_stack_is_transparent() {
    let source = RgbaImage::from_pixel(1, 1, Rgba([10, 20, 30, 40]));
    assert_eq!(
        composite_image_document(&source, &json!({}), 1, 1).expect("empty composite"),
        RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 0]))
    );
}
