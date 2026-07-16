#[path = "support/dng_fixture.rs"]
mod dng_fixture;

use dng_fixture::{
    minimal_dng, ByteOrder, ACTIVE_AREA, BLACK_LEVEL, CFA_PATTERN_RGGB, DEFAULT_CROP_ORIGIN,
    DEFAULT_CROP_SIZE, SENSOR_HEIGHT, SENSOR_SAMPLES, SENSOR_WIDTH, WHITE_LEVEL,
};
use hgripe_raw::{
    probe_dng, RawByteOrder, RawContainer, RawDataLayout, RawDimensions, RawGridSize,
    RawMatrixKind, RawPreviewKind, RawProbeError, RawProbeReport, RawRational, RawRect,
    RAW_PROBE_SCHEMA_VERSION,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::panic::catch_unwind;

const TAG_IMAGE_WIDTH: u16 = 256;
const TAG_COMPRESSION: u16 = 259;
const TAG_PHOTOMETRIC_INTERPRETATION: u16 = 262;
const TAG_MAKE: u16 = 271;
const TAG_MODEL: u16 = 272;
const TAG_STRIP_OFFSETS: u16 = 273;
const TAG_ROWS_PER_STRIP: u16 = 278;
const TAG_STRIP_BYTE_COUNTS: u16 = 279;
const TAG_SUB_IFDS: u16 = 330;
const TAG_CFA_PATTERN: u16 = 33422;
const TAG_DNG_VERSION: u16 = 50706;
const TAG_COLOR_MATRIX_1: u16 = 50721;
const TAG_AS_SHOT_NEUTRAL: u16 = 50728;
const TAG_CALIBRATION_ILLUMINANT_1: u16 = 50778;
const TAG_RAW_DATA_UNIQUE_ID: u16 = 50781;
const TAG_ACTIVE_AREA: u16 = 50829;

const TYPE_LONG: u16 = 4;
const PHOTOMETRIC_CFA: u16 = 32803;

#[derive(Clone, Copy, Debug)]
struct LocatedEntry {
    entry_offset: usize,
    field_type: u16,
    count: u32,
    value_offset: usize,
    byte_length: usize,
    inline: bool,
}

#[test]
fn probes_equivalent_little_and_big_endian_minimal_dngs() {
    assert_minimal_report(ByteOrder::Little, RawByteOrder::LittleEndian);
    assert_minimal_report(ByteOrder::Big, RawByteOrder::BigEndian);
}

#[test]
fn reads_camera_profile_and_white_balance_from_shared_ifd0() {
    for byte_order in [ByteOrder::Little, ByteOrder::Big] {
        let bytes = minimal_dng(byte_order);
        let ifd0 = first_ifd_offset(&bytes, byte_order);
        let raw_ifd = raw_ifd_offset(&bytes, byte_order);
        for tag in [
            TAG_COLOR_MATRIX_1,
            TAG_AS_SHOT_NEUTRAL,
            TAG_CALIBRATION_ILLUMINANT_1,
            TAG_RAW_DATA_UNIQUE_ID,
        ] {
            assert!(ifd_has_tag(&bytes, byte_order, ifd0, tag));
            assert!(!ifd_has_tag(&bytes, byte_order, raw_ifd, tag));
        }

        let report = probe_dng(&bytes).expect("shared IFD0 metadata must probe");
        assert!(report.as_shot_neutral.is_some());
        assert_eq!(report.color_matrices.len(), 1);
        assert_eq!(report.color_matrices[0].calibration_illuminant, Some(21));
        assert!(report.source.embedded_unique_id.is_some());
    }
}

#[test]
fn sensor_payload_bytes_do_not_affect_the_metadata_report() {
    let bytes = minimal_dng(ByteOrder::Little);
    let mut changed = bytes.clone();
    let raw_ifd = raw_ifd_offset(&changed, ByteOrder::Little);
    let strips = locate_entry(&changed, ByteOrder::Little, raw_ifd, TAG_STRIP_OFFSETS);
    let payload_offset =
        usize::try_from(read_u32(&changed, ByteOrder::Little, strips.value_offset)).unwrap();
    changed[payload_offset..].fill(0xa5);

    let mut original_report = probe_dng(&bytes).expect("fixture must probe");
    let mut changed_report = probe_dng(&changed).expect("changed payload must still probe");
    original_report.metrics.elapsed_us = 0;
    changed_report.metrics.elapsed_us = 0;
    assert_eq!(changed_report, original_report);
}

#[test]
fn every_proper_fixture_prefix_returns_error_without_panicking() {
    for byte_order in [ByteOrder::Little, ByteOrder::Big] {
        let bytes = minimal_dng(byte_order);
        for end in 0..bytes.len() {
            let outcome = catch_unwind(|| probe_dng(&bytes[..end]));
            let result = outcome.unwrap_or_else(|_| {
                panic!("probe panicked for {byte_order:?} fixture prefix of {end} bytes")
            });
            assert!(
                result.is_err(),
                "{byte_order:?} fixture prefix of {end} bytes unexpectedly probed successfully"
            );
        }
    }
}

#[test]
fn every_single_byte_fixture_mutation_is_panic_free() {
    for byte_order in [ByteOrder::Little, ByteOrder::Big] {
        let original = minimal_dng(byte_order);
        for index in 0..original.len() {
            let mut changed = original.clone();
            changed[index] ^= 0xff;
            assert!(
                catch_unwind(|| probe_dng(&changed)).is_ok(),
                "probe panicked for {byte_order:?} fixture mutation at byte {index}"
            );
        }
    }
}

#[test]
fn rejects_tiff_without_dng_version() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let ifd0 = first_ifd_offset(&bytes, byte_order);
    let version = locate_entry(&bytes, byte_order, ifd0, TAG_DNG_VERSION);
    write_u16(&mut bytes, byte_order, version.entry_offset, 65000);

    assert_eq!(probe_error(&bytes), RawProbeError::NotDng);
}

#[test]
fn rejects_bigtiff_before_reading_a_directory() {
    for byte_order in [ByteOrder::Little, ByteOrder::Big] {
        let mut bytes = minimal_dng(byte_order);
        write_u16(&mut bytes, byte_order, 2, 43);
        assert_eq!(probe_error(&bytes), RawProbeError::BigTiffUnsupported);
    }
}

#[test]
fn rejects_first_ifd_outside_the_file() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let invalid_offset = u32::try_from(bytes.len() + 1).unwrap();
    write_u32(&mut bytes, byte_order, 4, invalid_offset);

    assert!(matches!(
        probe_error(&bytes),
        RawProbeError::OutOfBounds { context, offset, .. }
            if context == "IFD entry count" && offset == u64::from(invalid_offset)
    ));
}

#[test]
fn rejects_ifd_entry_table_outside_the_file() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let ifd0 = first_ifd_offset(&bytes, byte_order);
    write_u16(&mut bytes, byte_order, ifd0, 73);

    assert!(matches!(
        probe_error(&bytes),
        RawProbeError::OutOfBounds { context, .. } if context == "IFD table"
    ));
}

#[test]
fn rejects_ifd_entry_count_above_the_budget() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let ifd0 = first_ifd_offset(&bytes, byte_order);
    write_u16(&mut bytes, byte_order, ifd0, 513);

    assert_eq!(
        probe_error(&bytes),
        RawProbeError::ResourceLimit {
            resource: "entries_per_ifd".into(),
            actual: 513,
            limit: 512,
        }
    );
}

#[test]
fn rejects_huge_tag_value_count_without_allocating_from_it() {
    for byte_order in [ByteOrder::Little, ByteOrder::Big] {
        let mut bytes = minimal_dng(byte_order);
        let raw_ifd = raw_ifd_offset(&bytes, byte_order);
        let pattern = locate_entry(&bytes, byte_order, raw_ifd, TAG_CFA_PATTERN);
        write_u32(&mut bytes, byte_order, pattern.entry_offset + 4, u32::MAX);

        assert!(matches!(
            probe_error(&bytes),
            RawProbeError::OutOfBounds {
                context,
                byte_length,
                ..
            } if context == "TIFF field value" && byte_length == u64::from(u32::MAX)
        ));
    }
}

#[test]
fn rejects_out_of_bounds_external_tag_value() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let ifd0 = first_ifd_offset(&bytes, byte_order);
    let model = locate_entry(&bytes, byte_order, ifd0, TAG_MODEL);
    assert!(!model.inline);
    let invalid_offset = u32::try_from(bytes.len() - 1).unwrap();
    write_u32(
        &mut bytes,
        byte_order,
        model.entry_offset + 8,
        invalid_offset,
    );

    assert!(matches!(
        probe_error(&bytes),
        RawProbeError::OutOfBounds {
            context,
            offset,
            byte_length,
            ..
        } if context == "TIFF field value"
            && offset == u64::from(invalid_offset)
            && byte_length == u64::try_from(model.byte_length).unwrap()
    ));
}

#[test]
fn rejects_raw_payload_offsets_into_metadata_or_past_eof() {
    for byte_order in [ByteOrder::Little, ByteOrder::Big] {
        let original = minimal_dng(byte_order);
        let file_length = u32::try_from(original.len()).unwrap();
        for invalid_offset in [0, file_length - 1, file_length, u32::MAX] {
            let mut bytes = original.clone();
            let raw_ifd = raw_ifd_offset(&bytes, byte_order);
            let strips = locate_entry(&bytes, byte_order, raw_ifd, TAG_STRIP_OFFSETS);
            write_u32(&mut bytes, byte_order, strips.value_offset, invalid_offset);

            let error = probe_error(&bytes);
            if invalid_offset == 0 {
                assert!(matches!(
                    error,
                    RawProbeError::InvalidTag { tag, reason, .. }
                        if tag == TAG_STRIP_OFFSETS && reason.contains("overlaps TIFF metadata")
                ));
            } else {
                assert!(matches!(
                    error,
                    RawProbeError::OutOfBounds { context, .. }
                        if context == "referenced image payload"
                ));
            }
        }
    }
}

#[test]
fn rejects_next_ifd_self_cycle() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let ifd0 = first_ifd_offset(&bytes, byte_order);
    let next_pointer = next_ifd_pointer_offset(&bytes, byte_order, ifd0);
    write_u32(
        &mut bytes,
        byte_order,
        next_pointer,
        u32::try_from(ifd0).unwrap(),
    );

    assert_eq!(
        probe_error(&bytes),
        RawProbeError::IfdCycle {
            offset: u64::try_from(ifd0).unwrap()
        }
    );
}

#[test]
fn rejects_sub_ifd_cycle() {
    let byte_order = ByteOrder::Big;
    let mut bytes = minimal_dng(byte_order);
    let ifd0 = first_ifd_offset(&bytes, byte_order);
    let sub_ifds = locate_entry(&bytes, byte_order, ifd0, TAG_SUB_IFDS);
    assert!(sub_ifds.inline);
    write_u32(
        &mut bytes,
        byte_order,
        sub_ifds.value_offset,
        u32::try_from(ifd0).unwrap(),
    );

    assert_eq!(
        probe_error(&bytes),
        RawProbeError::IfdCycle {
            offset: u64::try_from(ifd0).unwrap()
        }
    );
}

#[test]
fn rejects_zero_rational_denominator() {
    for byte_order in [ByteOrder::Little, ByteOrder::Big] {
        let mut bytes = minimal_dng(byte_order);
        let ifd0 = first_ifd_offset(&bytes, byte_order);
        let neutral = locate_entry(&bytes, byte_order, ifd0, TAG_AS_SHOT_NEUTRAL);
        assert_eq!(neutral.field_type, 5);
        assert_eq!(neutral.count, 3);
        assert!(!neutral.inline);
        write_u32(&mut bytes, byte_order, neutral.value_offset + 4, 0);

        assert!(matches!(
            probe_error(&bytes),
            RawProbeError::ZeroRationalDenominator { tag, index, .. }
                if tag == TAG_AS_SHOT_NEUTRAL && index == 0
        ));
    }
}

#[test]
fn rejects_duplicate_tag_in_one_ifd() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let ifd0 = first_ifd_offset(&bytes, byte_order);
    let model = locate_entry(&bytes, byte_order, ifd0, TAG_MODEL);
    write_u16(&mut bytes, byte_order, model.entry_offset, TAG_MAKE);

    assert_eq!(
        probe_error(&bytes),
        RawProbeError::DuplicateTag {
            ifd_offset: u64::try_from(ifd0).unwrap(),
            tag: TAG_MAKE,
        }
    );
}

#[test]
fn rejects_wrong_required_tag_type() {
    let byte_order = ByteOrder::Big;
    let mut bytes = minimal_dng(byte_order);
    let raw_ifd = raw_ifd_offset(&bytes, byte_order);
    let compression = locate_entry(&bytes, byte_order, raw_ifd, TAG_COMPRESSION);
    write_u16(
        &mut bytes,
        byte_order,
        compression.entry_offset + 2,
        TYPE_LONG,
    );

    assert_invalid_tag(&bytes, TAG_COMPRESSION, "field type 4 is not allowed");
}

#[test]
fn rejects_wrong_required_tag_count() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let ifd0 = first_ifd_offset(&bytes, byte_order);
    let version = locate_entry(&bytes, byte_order, ifd0, TAG_DNG_VERSION);
    write_u32(&mut bytes, byte_order, version.entry_offset + 4, 3);

    assert_invalid_tag(&bytes, TAG_DNG_VERSION, "must contain four bytes");
}

#[test]
fn rejects_cfa_pattern_count_mismatch() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let raw_ifd = raw_ifd_offset(&bytes, byte_order);
    let pattern = locate_entry(&bytes, byte_order, raw_ifd, TAG_CFA_PATTERN);
    write_u32(&mut bytes, byte_order, pattern.entry_offset + 4, 3);

    assert_invalid_tag(
        &bytes,
        TAG_CFA_PATTERN,
        "count does not match CFA repeat area",
    );
}

#[test]
fn rejects_cfa_pattern_with_unknown_plane_index() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let raw_ifd = raw_ifd_offset(&bytes, byte_order);
    let pattern = locate_entry(&bytes, byte_order, raw_ifd, TAG_CFA_PATTERN);
    bytes[pattern.value_offset] = 3;

    assert_invalid_tag(&bytes, TAG_CFA_PATTERN, "out-of-range colour-plane index");
}

#[test]
fn rejects_active_area_outside_sensor() {
    let byte_order = ByteOrder::Big;
    let mut bytes = minimal_dng(byte_order);
    let raw_ifd = raw_ifd_offset(&bytes, byte_order);
    let active = locate_entry(&bytes, byte_order, raw_ifd, TAG_ACTIVE_AREA);
    assert!(!active.inline);
    write_u32(
        &mut bytes,
        byte_order,
        active.value_offset + 2 * size_of::<u32>(),
        SENSOR_HEIGHT + 1,
    );

    assert_invalid_tag(&bytes, TAG_ACTIVE_AREA, "exceeds sensor dimensions");
}

#[test]
fn rejects_zero_sensor_dimension() {
    let byte_order = ByteOrder::Big;
    let mut bytes = minimal_dng(byte_order);
    let raw_ifd = raw_ifd_offset(&bytes, byte_order);
    let width = locate_entry(&bytes, byte_order, raw_ifd, TAG_IMAGE_WIDTH);
    write_u32(&mut bytes, byte_order, width.value_offset, 0);

    assert_invalid_tag(&bytes, TAG_IMAGE_WIDTH, "sensor dimension is zero");
}

#[test]
fn rejects_crop_outside_active_area() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let raw_ifd = raw_ifd_offset(&bytes, byte_order);
    let crop_size = locate_entry(&bytes, byte_order, raw_ifd, TAG_DEFAULT_CROP_SIZE);
    write_u32(&mut bytes, byte_order, crop_size.value_offset, 5);

    assert_invalid_tag(&bytes, TAG_DEFAULT_CROP_SIZE, "crop exceeds ActiveArea");
}

#[test]
fn rejects_black_level_at_or_above_white_level() {
    let byte_order = ByteOrder::Big;
    let mut bytes = minimal_dng(byte_order);
    let raw_ifd = raw_ifd_offset(&bytes, byte_order);
    let black = locate_entry(&bytes, byte_order, raw_ifd, TAG_BLACK_LEVEL);
    write_u16(&mut bytes, byte_order, black.value_offset, WHITE_LEVEL);

    assert_invalid_tag(&bytes, TAG_BLACK_LEVEL, "must be below white level");
}

#[test]
fn rejects_strip_count_that_disagrees_with_rows_per_strip() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let raw_ifd = raw_ifd_offset(&bytes, byte_order);
    let rows = locate_entry(&bytes, byte_order, raw_ifd, TAG_ROWS_PER_STRIP);
    write_u32(&mut bytes, byte_order, rows.value_offset, 3);

    assert_invalid_tag(
        &bytes,
        TAG_STRIP_OFFSETS,
        "range count does not match the declared image geometry",
    );
}

#[test]
fn rejects_ascii_without_a_nul_terminator() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let ifd0 = first_ifd_offset(&bytes, byte_order);
    let model = locate_entry(&bytes, byte_order, ifd0, TAG_MODEL);
    bytes[model.value_offset + model.byte_length - 1] = b'!';

    assert_invalid_tag(&bytes, TAG_MODEL, "not NUL terminated");
}

#[test]
fn rejects_unpaired_strip_offset_and_byte_count() {
    let byte_order = ByteOrder::Little;
    let mut bytes = minimal_dng(byte_order);
    let raw_ifd = raw_ifd_offset(&bytes, byte_order);
    let byte_counts = locate_entry(&bytes, byte_order, raw_ifd, TAG_STRIP_BYTE_COUNTS);
    write_u16(&mut bytes, byte_order, byte_counts.entry_offset, 65001);

    assert_invalid_tag(
        &bytes,
        TAG_STRIP_OFFSETS,
        "offset and byte-count arrays must both be present",
    );
}

#[test]
fn rejects_multiple_raw_ifds() {
    let byte_order = ByteOrder::Big;
    let mut bytes = minimal_dng(byte_order);
    let ifd0 = first_ifd_offset(&bytes, byte_order);
    let photometric = locate_entry(&bytes, byte_order, ifd0, TAG_PHOTOMETRIC_INTERPRETATION);
    write_u16(
        &mut bytes,
        byte_order,
        photometric.value_offset,
        PHOTOMETRIC_CFA,
    );

    assert_eq!(
        probe_error(&bytes),
        RawProbeError::AmbiguousRawIfd { count: 2 }
    );
}

#[test]
fn serializes_stable_schema_and_u64_values_as_decimal_strings() {
    let bytes = minimal_dng(ByteOrder::Little);
    let report = probe_dng(&bytes).expect("minimal DNG must probe");
    let json = serde_json::to_value(&report).expect("probe report must serialize");
    let object = json
        .as_object()
        .expect("probe report JSON must be an object");
    let actual_keys = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected_keys = [
        "active_area",
        "analog_balance",
        "as_shot_neutral",
        "as_shot_white_xy",
        "bits_per_sample",
        "black_level",
        "byte_order",
        "camera",
        "cfa",
        "color_matrices",
        "compression",
        "container",
        "default_crop",
        "deferred_metadata",
        "diagnostics",
        "dimensions",
        "dng",
        "masked_areas",
        "metrics",
        "orientation",
        "previews",
        "profile",
        "raw_data",
        "samples_per_pixel",
        "schema_version",
        "source",
        "white_level",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    assert_eq!(actual_keys, expected_keys);

    assert_eq!(json["schema_version"], RAW_PROBE_SCHEMA_VERSION);
    assert_eq!(json["container"], "dng_tiff");
    assert_eq!(json["byte_order"], "little_endian");
    assert_eq!(json["compression"]["code"], 1);
    assert_eq!(json["compression"]["description"], "uncompressed");
    assert_eq!(json["source"]["byte_length"], bytes.len().to_string());
    assert_eq!(
        json["source"]["embedded_unique_id"],
        "4847524950452d52302d464958545552"
    );
    assert_eq!(json["dng"]["version"], json!([1, 4, 0, 0]));
    assert_eq!(json["dng"]["backward_version"], json!([1, 1, 0, 0]));
    assert_json_decimal_string(&json["raw_data"][0]["offset"]);
    assert_eq!(json["raw_data"][0]["byte_count"], "72");
    assert_eq!(json["previews"][0]["ifd_offset"], "8");
    assert_json_decimal_string(&json["previews"][0]["data"][0]["offset"]);
    assert_eq!(json["previews"][0]["data"][0]["byte_count"], "12");
    assert_json_decimal_string(&json["metrics"]["elapsed_us"]);
    assert_json_decimal_string(&json["metrics"]["metadata_bytes_materialized"]);
    assert_eq!(json["metrics"]["estimated_unpacked_bytes"], "72");

    let round_trip: RawProbeReport =
        serde_json::from_value(json).expect("probe report JSON must deserialize");
    assert_eq!(round_trip, report);

    let mut proprietary_report = report.clone();
    proprietary_report.container = RawContainer::CanonCr2;
    proprietary_report.byte_order = None;
    proprietary_report.dng = None;
    proprietary_report.compression.code = 0x4352_4157;
    proprietary_report.compression.description = Some("canon_raw".into());
    let proprietary_json = serde_json::to_value(&proprietary_report).unwrap();
    assert_eq!(proprietary_json["container"], "canon_cr2");
    assert_eq!(proprietary_json["byte_order"], Value::Null);
    assert_eq!(proprietary_json["dng"], Value::Null);
    assert_eq!(proprietary_json["compression"]["code"], 0x4352_4157_u32);
    assert_eq!(
        serde_json::from_value::<RawProbeReport>(proprietary_json).unwrap(),
        proprietary_report
    );
}

#[test]
fn serializes_structured_error_codes_stably() {
    let error = RawProbeError::OutOfBounds {
        context: "fixture".into(),
        offset: 10,
        byte_length: 20,
        file_length: 24,
    };
    let value = serde_json::to_value(&error).unwrap();
    assert_eq!(
        value,
        json!({
            "code": "out_of_bounds",
            "context": "fixture",
            "offset": "10",
            "byte_length": "20",
            "file_length": "24"
        })
    );
    assert_eq!(
        serde_json::from_value::<RawProbeError>(value).unwrap(),
        error
    );
}

fn assert_minimal_report(byte_order: ByteOrder, expected_byte_order: RawByteOrder) {
    let bytes = minimal_dng(byte_order);
    let report = probe_dng(&bytes).expect("minimal DNG must probe");

    assert_eq!(report.schema_version, RAW_PROBE_SCHEMA_VERSION);
    assert_eq!(report.container, RawContainer::DngTiff);
    assert_eq!(report.byte_order, Some(expected_byte_order));
    assert_eq!(
        report.source.byte_length,
        u64::try_from(bytes.len()).unwrap()
    );
    assert_eq!(
        report.source.embedded_unique_id.as_deref(),
        Some("4847524950452d52302d464958545552")
    );
    let dng = report.dng.expect("DNG probe must report DNG metadata");
    assert_eq!(dng.version, [1, 4, 0, 0]);
    assert_eq!(dng.backward_version, Some([1, 1, 0, 0]));
    assert_eq!(report.camera.make.as_deref(), Some("H-Gripe"));
    assert_eq!(report.camera.model.as_deref(), Some("Synthetic Bayer"));
    assert_eq!(
        report.camera.unique_camera_model.as_deref(),
        Some("H-Gripe Synthetic Bayer")
    );

    assert_eq!(
        report.dimensions,
        RawDimensions {
            width: SENSOR_WIDTH,
            height: SENSOR_HEIGHT,
        }
    );
    assert_eq!(
        report.active_area,
        Some(RawRect {
            top: ACTIVE_AREA[0],
            left: ACTIVE_AREA[1],
            bottom: ACTIVE_AREA[2],
            right: ACTIVE_AREA[3],
        })
    );
    assert_eq!(
        report.masked_areas,
        vec![
            RawRect {
                top: 0,
                left: 0,
                bottom: 1,
                right: SENSOR_WIDTH,
            },
            RawRect {
                top: 1,
                left: 0,
                bottom: 5,
                right: 1,
            },
        ]
    );
    let crop = report.default_crop.expect("fixture declares a crop");
    assert_eq!(
        crop.origin,
        DEFAULT_CROP_ORIGIN.map(|value| rational(i64::from(value), 1))
    );
    assert_eq!(
        crop.size,
        DEFAULT_CROP_SIZE.map(|value| rational(i64::from(value), 1))
    );
    assert_eq!(report.orientation, Some(1));
    assert_eq!(report.bits_per_sample, vec![16]);
    assert_eq!(report.compression.code, 1);
    assert_eq!(
        report.compression.description.as_deref(),
        Some("uncompressed")
    );
    assert_eq!(report.samples_per_pixel, 1);

    let cfa = report.cfa.expect("fixture declares a CFA");
    assert_eq!(
        cfa.repeat,
        RawGridSize {
            rows: 2,
            columns: 2,
        }
    );
    assert_eq!(cfa.pattern, CFA_PATTERN_RGGB);
    assert_eq!(cfa.plane_colors, vec![0, 1, 2]);
    assert_eq!(cfa.layout, Some(1));

    let black = report.black_level.expect("fixture declares black level");
    assert_eq!(
        black.repeat,
        RawGridSize {
            rows: 1,
            columns: 1,
        }
    );
    assert_eq!(black.values, vec![rational(i64::from(BLACK_LEVEL), 1)]);
    assert_eq!(
        report.white_level,
        vec![rational(i64::from(WHITE_LEVEL), 1)]
    );
    assert_eq!(
        report.as_shot_neutral,
        Some(vec![rational(1, 2), rational(1, 1), rational(2, 3)])
    );
    assert_eq!(report.as_shot_white_xy, None);
    assert_eq!(report.analog_balance, None);

    assert_eq!(report.color_matrices.len(), 1);
    let matrix = &report.color_matrices[0];
    assert_eq!(matrix.kind, RawMatrixKind::ColorMatrix1);
    assert_eq!((matrix.rows, matrix.columns), (3, 3));
    assert_eq!(matrix.calibration_illuminant, Some(21));
    assert_eq!(
        matrix.values,
        vec![
            rational(1, 1),
            rational(0, 1),
            rational(0, 1),
            rational(0, 1),
            rational(1, 1),
            rational(0, 1),
            rational(0, 1),
            rational(0, 1),
            rational(1, 1),
        ]
    );

    assert_eq!(report.raw_data.len(), 1);
    let raw_data = &report.raw_data[0];
    assert_eq!(raw_data.layout, RawDataLayout::Strip);
    assert_eq!(raw_data.index, 0);
    assert_eq!(
        raw_data.byte_count,
        u64::try_from(SENSOR_SAMPLES.len() * 2).unwrap()
    );
    assert!(raw_data.offset + raw_data.byte_count <= u64::try_from(bytes.len()).unwrap());

    assert_eq!(report.previews.len(), 1);
    let preview = &report.previews[0];
    assert_eq!(preview.kind, RawPreviewKind::Thumbnail);
    assert_eq!(
        preview.dimensions,
        Some(RawDimensions {
            width: 2,
            height: 2,
        })
    );
    assert_eq!(
        preview.compression.as_ref().map(|value| value.code),
        Some(1)
    );
    assert_eq!(
        preview
            .compression
            .as_ref()
            .and_then(|value| value.description.as_deref()),
        Some("uncompressed")
    );
    assert_eq!(preview.photometric_interpretation, Some(2));
    assert_eq!(preview.data.len(), 1);
    assert_eq!(preview.data[0].layout, RawDataLayout::Strip);
    assert_eq!(preview.data[0].byte_count, 12);
    assert!(
        preview.data[0].offset + preview.data[0].byte_count <= u64::try_from(bytes.len()).unwrap()
    );

    assert!(report.deferred_metadata.is_empty());
    assert!(report.diagnostics.is_empty());
    assert_eq!(report.metrics.estimated_unpacked_bytes, 72);
    assert!(report.metrics.metadata_bytes_materialized > 0);
}

fn assert_invalid_tag(bytes: &[u8], expected_tag: u16, expected_reason: &str) {
    match probe_error(bytes) {
        RawProbeError::InvalidTag { tag, reason, .. } => {
            assert_eq!(tag, expected_tag);
            assert!(
                reason.contains(expected_reason),
                "invalid-tag reason {reason:?} did not contain {expected_reason:?}"
            );
        }
        error => panic!("expected InvalidTag for {expected_tag}, got {error:?}"),
    }
}

fn probe_error(bytes: &[u8]) -> RawProbeError {
    let outcome = catch_unwind(|| probe_dng(bytes));
    let result = outcome.unwrap_or_else(|_| panic!("probe panicked for malformed input"));
    result.expect_err("malformed input unexpectedly probed successfully")
}

fn assert_json_decimal_string(value: &Value) {
    let value = value.as_str().expect("u64 JSON field must be a string");
    assert!(!value.is_empty());
    assert!(value.bytes().all(|byte| byte.is_ascii_digit()));
}

const fn rational(num: i64, den: i64) -> RawRational {
    RawRational { num, den }
}

fn first_ifd_offset(bytes: &[u8], byte_order: ByteOrder) -> usize {
    usize::try_from(read_u32(bytes, byte_order, 4)).unwrap()
}

fn raw_ifd_offset(bytes: &[u8], byte_order: ByteOrder) -> usize {
    let ifd0 = first_ifd_offset(bytes, byte_order);
    let sub_ifds = locate_entry(bytes, byte_order, ifd0, TAG_SUB_IFDS);
    assert_eq!(sub_ifds.field_type, TYPE_LONG);
    assert_eq!(sub_ifds.count, 1);
    usize::try_from(read_u32(bytes, byte_order, sub_ifds.value_offset)).unwrap()
}

fn locate_entry(
    bytes: &[u8],
    byte_order: ByteOrder,
    ifd_offset: usize,
    wanted_tag: u16,
) -> LocatedEntry {
    let count = usize::from(read_u16(bytes, byte_order, ifd_offset));
    for index in 0..count {
        let entry_offset = ifd_offset + 2 + index * 12;
        let tag = read_u16(bytes, byte_order, entry_offset);
        if tag != wanted_tag {
            continue;
        }
        let field_type = read_u16(bytes, byte_order, entry_offset + 2);
        let count = read_u32(bytes, byte_order, entry_offset + 4);
        let byte_length = usize::try_from(count)
            .unwrap()
            .checked_mul(type_width(field_type))
            .unwrap();
        let inline = byte_length <= 4;
        let value_offset = if inline {
            entry_offset + 8
        } else {
            usize::try_from(read_u32(bytes, byte_order, entry_offset + 8)).unwrap()
        };
        return LocatedEntry {
            entry_offset,
            field_type,
            count,
            value_offset,
            byte_length,
            inline,
        };
    }
    panic!("tag {wanted_tag} is absent from fixture IFD at {ifd_offset}");
}

fn ifd_has_tag(bytes: &[u8], byte_order: ByteOrder, ifd_offset: usize, wanted_tag: u16) -> bool {
    let count = usize::from(read_u16(bytes, byte_order, ifd_offset));
    (0..count).any(|index| {
        let entry_offset = ifd_offset + 2 + index * 12;
        read_u16(bytes, byte_order, entry_offset) == wanted_tag
    })
}

fn next_ifd_pointer_offset(bytes: &[u8], byte_order: ByteOrder, ifd_offset: usize) -> usize {
    let count = usize::from(read_u16(bytes, byte_order, ifd_offset));
    ifd_offset + 2 + count * 12
}

fn type_width(field_type: u16) -> usize {
    match field_type {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 | 13 => 4,
        5 | 10 | 12 => 8,
        _ => panic!("unsupported fixture field type {field_type}"),
    }
}

fn read_u16(bytes: &[u8], byte_order: ByteOrder, offset: usize) -> u16 {
    let value = [bytes[offset], bytes[offset + 1]];
    match byte_order {
        ByteOrder::Little => u16::from_le_bytes(value),
        ByteOrder::Big => u16::from_be_bytes(value),
    }
}

fn read_u32(bytes: &[u8], byte_order: ByteOrder, offset: usize) -> u32 {
    let value = [
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ];
    match byte_order {
        ByteOrder::Little => u32::from_le_bytes(value),
        ByteOrder::Big => u32::from_be_bytes(value),
    }
}

fn write_u16(bytes: &mut [u8], byte_order: ByteOrder, offset: usize, value: u16) {
    let value = match byte_order {
        ByteOrder::Little => value.to_le_bytes(),
        ByteOrder::Big => value.to_be_bytes(),
    };
    bytes[offset..offset + 2].copy_from_slice(&value);
}

fn write_u32(bytes: &mut [u8], byte_order: ByteOrder, offset: usize, value: u32) {
    let value = match byte_order {
        ByteOrder::Little => value.to_le_bytes(),
        ByteOrder::Big => value.to_be_bytes(),
    };
    bytes[offset..offset + 4].copy_from_slice(&value);
}
const TAG_BLACK_LEVEL: u16 = 50714;
const TAG_DEFAULT_CROP_SIZE: u16 = 50720;
