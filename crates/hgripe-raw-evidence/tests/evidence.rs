#[path = "../../hgripe-raw/tests/support/dng_fixture.rs"]
mod dng_fixture;

use dng_fixture::{minimal_dng, ByteOrder, SENSOR_SAMPLES};
use hgripe_raw::{RawContainer, RawDimensions};
use hgripe_raw_evidence::{
    canonical_sensor_digest_u16_le, load_manifest_snapshot, probe_owned_case, resolve_case_path,
    validate_manifest, write_evidence_bundle, RawCorpusCase, RawCorpusFamily, RawCorpusManifest,
    RawCorpusOrigin, RawCorpusProvenance, RawEvidenceBundle, RawEvidenceOutcome,
    RawManifestIssueSeverity, RawProbeExpectation, RawRedistributionPolicy,
    RawSensorFrameSelection, RawSensorReference, RawSensorReferenceBasis,
    RawSensorReferenceDimensions, RawSensorReferenceDomain, RawSensorReferenceProducer,
    RawSensorSampleEncoding, RawSensorSampleOrder, RawSensorUnpackEvidence,
    RAW_CORPUS_MANIFEST_SCHEMA_VERSION, RAW_EVIDENCE_SCHEMA_VERSION, RAW_SENSOR_ARTIFACT_MAX_BYTES,
    RAW_SENSOR_ARTIFACT_OBSERVATION_TIMEOUT_MS, RAW_SENSOR_REFERENCE_SCHEMA_VERSION,
};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[test]
fn validates_incremental_manifest_and_reports_missing_coverage() {
    let manifest = manifest_with_case(sample_case(
        RawCorpusFamily::DngUncompressedBayer,
        "cases/minimal.dng",
        &"0".repeat(64),
    ));
    let validation = validate_manifest(&manifest);

    assert!(validation.valid);
    assert!(!validation.coverage.complete);
    assert_eq!(
        validation.coverage.present,
        vec![RawCorpusFamily::DngUncompressedBayer]
    );
    assert_eq!(validation.coverage.missing.len(), 9);
    assert_eq!(
        validation
            .issues
            .iter()
            .filter(|issue| issue.severity == RawManifestIssueSeverity::Warning)
            .count(),
        9
    );
}

#[test]
fn rejects_legacy_manifest_schema_after_sensor_contract_upgrade() {
    let mut manifest = manifest_with_case(sample_case(
        RawCorpusFamily::DngUncompressedBayer,
        "cases/minimal.dng",
        &"0".repeat(64),
    ));
    manifest.schema_version = 1;
    let validation = validate_manifest(&manifest);
    assert!(!validation.valid);
    assert!(validation
        .issues
        .iter()
        .any(|issue| issue.code == "unsupported_schema_version"));
}

#[test]
fn complete_manifest_covers_every_required_family() {
    let cases = RawCorpusFamily::REQUIRED
        .into_iter()
        .enumerate()
        .map(|(index, family)| {
            let mut case = sample_case(
                family,
                &format!("cases/case-{index}.raw"),
                &format!("{index:064x}"),
            );
            case.id = format!("case-{index}");
            if family == RawCorpusFamily::DngUncompressedBayer {
                case.expected.compression_code = Some(1);
            }
            match family {
                RawCorpusFamily::CanonCr3 => {
                    case.expected.compression_description = Some("canon_cr3_raw".into());
                }
                RawCorpusFamily::CanonCr3Craw => {
                    case.expected.compression_description = Some("canon_cr3_c_raw".into());
                }
                _ => {}
            }
            case
        })
        .collect();
    let manifest = RawCorpusManifest {
        schema_version: RAW_CORPUS_MANIFEST_SCHEMA_VERSION,
        corpus_id: "complete-corpus".into(),
        cases,
    };
    let validation = validate_manifest(&manifest);

    assert!(validation.valid);
    assert!(validation.coverage.complete);
    assert!(validation.coverage.missing.is_empty());
}

#[test]
fn rejects_unsafe_duplicate_and_unlicensed_manifest_entries() {
    let mut first = sample_case(
        RawCorpusFamily::DngUncompressedBayer,
        "../escape.dng",
        &"A".repeat(64),
    );
    first.provenance.rights_reference.clear();
    first.expected.cfa_repeat_rows = Some(2);
    first.expected.cfa_repeat_columns = None;
    first.expected.sensor_reference = Some(test_sensor_reference());
    first
        .expected
        .sensor_reference
        .as_mut()
        .unwrap()
        .sample_count = 35;
    let mut second = first.clone();
    second.relative_path = first.relative_path.clone();
    let manifest = RawCorpusManifest {
        schema_version: RAW_CORPUS_MANIFEST_SCHEMA_VERSION + 1,
        corpus_id: "bad corpus id".into(),
        cases: vec![first, second],
    };

    let validation = validate_manifest(&manifest);
    let codes = validation
        .issues
        .iter()
        .map(|issue| issue.code.as_str())
        .collect::<Vec<_>>();
    assert!(!validation.valid);
    for expected in [
        "unsupported_schema_version",
        "invalid_corpus_id",
        "unsafe_relative_path",
        "invalid_sha256",
        "missing_rights_reference",
        "invalid_cfa_expectation",
        "contradictory_sensor_reference_count",
        "duplicate_case_id",
        "duplicate_relative_path",
    ] {
        assert!(codes.contains(&expected), "missing issue {expected}");
    }
}

#[test]
fn manifest_snapshot_hashes_the_exact_deserialized_bytes() {
    let temp = TestDir::new();
    let mut case = sample_case(
        RawCorpusFamily::DngUncompressedBayer,
        "cases/minimal.dng",
        &"0".repeat(64),
    );
    case.expected.sensor_reference = Some(test_sensor_reference());
    let manifest = manifest_with_case(case);
    let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
    let path = temp.path().join("manifest.json");
    fs::write(&path, &bytes).unwrap();

    let snapshot = load_manifest_snapshot(&path).unwrap();
    assert_eq!(snapshot.manifest, manifest);
    assert_eq!(snapshot.sha256, format!("{:x}", Sha256::digest(&bytes)));
    let serialized: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        serialized["cases"][0]["expected"]["sensor_reference"]["sample_count"],
        "36"
    );

    let mut json = serde_json::to_value(&snapshot.manifest).unwrap();
    json["unexpected"] = serde_json::json!(true);
    fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
    assert!(load_manifest_snapshot(&path).is_err());
}

#[test]
fn rejects_noncanonical_sensor_reference_contracts() {
    let mut case = sample_case(
        RawCorpusFamily::DngUncompressedBayer,
        "cases/minimal.dng",
        &"0".repeat(64),
    );
    case.provenance.origin = RawCorpusOrigin::RedistributableFixture;
    case.expected.dimensions = Some(RawDimensions {
        width: 6,
        height: 6,
    });

    let mut wrong_schema = test_sensor_reference();
    wrong_schema.schema_version += 1;
    assert_sensor_reference_issue(&case, wrong_schema, "unsupported_sensor_reference_schema");

    let mut ambiguous_frame = test_sensor_reference();
    ambiguous_frame.full_resolution_raw_frame_count = 2;
    assert_sensor_reference_issue(&case, ambiguous_frame, "ambiguous_sensor_reference_frame");

    let mut wrong_count = test_sensor_reference();
    wrong_count.sample_count = 35;
    assert_sensor_reference_issue(&case, wrong_count, "contradictory_sensor_reference_count");

    let mut wrong_dimensions = test_sensor_reference();
    wrong_dimensions.dimensions.width = 5;
    wrong_dimensions.sample_count = 30;
    assert_sensor_reference_issue(
        &case,
        wrong_dimensions,
        "contradictory_sensor_reference_dimensions",
    );

    let mut wrong_samples_per_pixel = test_sensor_reference();
    wrong_samples_per_pixel.samples_per_pixel = 2;
    wrong_samples_per_pixel.sample_count = 72;
    assert_sensor_reference_issue(
        &case,
        wrong_samples_per_pixel,
        "unsupported_sensor_reference_samples_per_pixel",
    );

    let mut wrong_digest = test_sensor_reference();
    wrong_digest.sample_digest_sha256 = "A".repeat(64);
    assert_sensor_reference_issue(&case, wrong_digest, "invalid_sensor_reference_digest");

    let mut wrong_tool = test_sensor_reference();
    wrong_tool.producer.tool_id = "not a stable id".into();
    assert_sensor_reference_issue(&case, wrong_tool, "invalid_sensor_reference_tool_id");

    let mut noncanonical_implementation = test_sensor_reference();
    noncanonical_implementation.producer.implementation_id = "LibRaw".into();
    assert_sensor_reference_issue(
        &case,
        noncanonical_implementation,
        "invalid_sensor_reference_implementation_id",
    );

    let mut wrong_artifact = test_sensor_reference();
    wrong_artifact.producer.tool_artifact_sha256 = "invalid".into();
    assert_sensor_reference_issue(
        &case,
        wrong_artifact,
        "invalid_sensor_reference_tool_artifact",
    );

    let mut wrong_record_artifact = test_sensor_reference();
    wrong_record_artifact.producer.record_artifact_sha256 = "invalid".into();
    assert_sensor_reference_issue(
        &case,
        wrong_record_artifact,
        "invalid_sensor_reference_record_artifact",
    );

    let mut oversized = test_sensor_reference();
    oversized.dimensions.width = 65_536;
    oversized.dimensions.height = 16_385;
    oversized.sample_count =
        u64::from(oversized.dimensions.width) * u64::from(oversized.dimensions.height);
    assert_sensor_reference_issue(&case, oversized, "sensor_reference_artifact_too_large");

    let mut wrong_basis_case = case.clone();
    wrong_basis_case.provenance.origin = RawCorpusOrigin::OwnedCapture;
    assert_sensor_reference_issue(
        &wrong_basis_case,
        test_sensor_reference(),
        "contradictory_sensor_reference_basis",
    );
}

#[test]
fn sensor_reference_dimensions_reject_unknown_json_fields() {
    let mut case = sample_case(
        RawCorpusFamily::DngUncompressedBayer,
        "cases/minimal.dng",
        &"0".repeat(64),
    );
    case.expected.sensor_reference = Some(test_sensor_reference());
    let mut value = serde_json::to_value(manifest_with_case(case)).unwrap();
    value["cases"][0]["expected"]["sensor_reference"]["dimensions"]["unexpected"] =
        serde_json::json!(true);
    assert!(serde_json::from_value::<RawCorpusManifest>(value).is_err());
}

#[test]
fn rejects_windows_path_aliases_and_case_insensitive_duplicates() {
    let mut cases = Vec::new();
    for (index, path) in [
        "cases/image.raw:preview",
        "cases/CON.raw",
        "cases/trailing.",
        "cases/trailing ",
    ]
    .into_iter()
    .enumerate()
    {
        let mut case = sample_case(RawCorpusFamily::CanonCr2, path, &format!("{index:064x}"));
        case.id = format!("unsafe-{index}");
        cases.push(case);
    }
    let mut first = sample_case(RawCorpusFamily::NikonNef, "cases/SAME.nef", &"a".repeat(64));
    first.id = "same-upper".into();
    let mut second = sample_case(RawCorpusFamily::NikonNef, "cases/same.nef", &"b".repeat(64));
    second.id = "same-lower".into();
    cases.extend([first, second]);
    let validation = validate_manifest(&RawCorpusManifest {
        schema_version: RAW_CORPUS_MANIFEST_SCHEMA_VERSION,
        corpus_id: "windows-paths".into(),
        cases,
    });
    let codes = validation
        .issues
        .iter()
        .map(|issue| issue.code.as_str())
        .collect::<Vec<_>>();
    assert!(!validation.valid);
    assert_eq!(
        codes
            .iter()
            .filter(|code| **code == "unsafe_relative_path")
            .count(),
        4
    );
    assert!(codes.contains(&"duplicate_relative_path"));
}

#[test]
fn requires_distinct_cr3_and_craw_discriminators() {
    let mut cr3 = sample_case(RawCorpusFamily::CanonCr3, "canon/full.cr3", &"1".repeat(64));
    cr3.id = "canon-full".into();
    let mut craw = sample_case(
        RawCorpusFamily::CanonCr3Craw,
        "canon/compressed.cr3",
        &"2".repeat(64),
    );
    craw.id = "canon-craw".into();
    let mut manifest = RawCorpusManifest {
        schema_version: RAW_CORPUS_MANIFEST_SCHEMA_VERSION,
        corpus_id: "canon-variants".into(),
        cases: vec![cr3, craw],
    };

    let invalid = validate_manifest(&manifest);
    assert_eq!(
        invalid
            .issues
            .iter()
            .filter(|issue| issue.code == "missing_variant_discriminator")
            .count(),
        2
    );

    manifest.cases[0].expected.compression_description = Some("canon_cr3_raw".into());
    manifest.cases[1].expected.compression_description = Some("canon_cr3_c_raw".into());
    assert!(validate_manifest(&manifest).valid);
}

#[test]
fn owned_probe_records_metadata_without_claiming_sensor_unpack() {
    for byte_order in [ByteOrder::Little, ByteOrder::Big] {
        let temp = TestDir::new();
        let (case, _) =
            write_fixture_case(&temp, RawCorpusFamily::DngUncompressedBayer, byte_order);
        let record = probe_owned_case(&case, temp.path());

        assert_eq!(
            record.observed_sha256.as_deref(),
            Some(case.sha256.as_str())
        );
        assert!(record
            .metrics
            .as_ref()
            .unwrap()
            .peak_working_set_bytes
            .is_some());
        assert!(record.expectation_checks.iter().all(|check| check.passed));
        match record.outcome {
            RawEvidenceOutcome::ProbeSucceeded {
                report,
                sensor_unpack,
            } => {
                assert_eq!(report.container, RawContainer::DngTiff);
                assert_eq!(
                    report.dimensions,
                    RawDimensions {
                        width: 6,
                        height: 6
                    }
                );
                assert!(matches!(
                    sensor_unpack,
                    RawSensorUnpackEvidence::NotAttempted { .. }
                ));
            }
            outcome => panic!("unexpected outcome: {outcome:?}"),
        }
    }
}

#[test]
fn hash_mismatch_stops_before_metadata_probe() {
    let temp = TestDir::new();
    let (mut case, _) = write_fixture_case(
        &temp,
        RawCorpusFamily::DngUncompressedBayer,
        ByteOrder::Little,
    );
    case.sha256 = "0".repeat(64);
    let record = probe_owned_case(&case, temp.path());

    assert!(matches!(
        record.outcome,
        RawEvidenceOutcome::IntegrityMismatch { .. }
    ));
    assert_eq!(record.metrics.as_ref().unwrap().metadata_probe_us, None);
    assert!(record.expectation_checks.is_empty());
}

#[test]
fn owned_runner_hashes_but_does_not_parse_unsupported_family() {
    let temp = TestDir::new();
    let (case, _) = write_fixture_case(&temp, RawCorpusFamily::CanonCr2, ByteOrder::Little);
    let record = probe_owned_case(&case, temp.path());

    assert!(matches!(
        record.outcome,
        RawEvidenceOutcome::UnsupportedFamily { .. }
    ));
    assert_eq!(record.metrics.as_ref().unwrap().metadata_probe_us, None);
}

#[test]
fn path_resolution_rejects_parent_traversal() {
    let temp = TestDir::new();
    assert!(resolve_case_path(temp.path(), "../outside.raw").is_err());
    assert!(resolve_case_path(temp.path(), "C:\\outside.raw").is_err());
}

#[test]
fn path_resolution_rejects_a_junction_escape() {
    let root = TestDir::new();
    let outside = TestDir::new();
    fs::write(outside.path().join("outside.raw"), b"outside").unwrap();
    let junction = root.path().join("escape");
    let output = Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(&junction)
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(resolve_case_path(root.path(), "escape/outside.raw").is_err());
}

#[test]
fn lossless_dng_family_rejects_lossy_jpeg_compression() {
    let temp = TestDir::new();
    let mut bytes = minimal_dng(ByteOrder::Little);
    set_little_endian_raw_compression(&mut bytes, 34_892);
    let case_dir = temp.path().join("cases");
    fs::create_dir_all(&case_dir).unwrap();
    fs::write(case_dir.join("lossy.dng"), &bytes).unwrap();
    let mut case = sample_case(
        RawCorpusFamily::DngLosslessCompressedBayer,
        "cases/lossy.dng",
        &format!("{:x}", Sha256::digest(&bytes)),
    );
    case.expected.compression_code = None;

    let record = probe_owned_case(&case, temp.path());
    assert!(matches!(
        record.outcome,
        RawEvidenceOutcome::ProbeSucceeded { .. }
    ));
    assert!(record.expectation_checks.iter().any(|check| {
        check.field == "lossless_compression_code"
            && check.actual.as_deref() == Some("34892")
            && !check.passed
    }));
}

#[test]
fn cli_validates_and_collects_isolated_owned_evidence() {
    let temp = TestDir::new();
    let (case, _) = write_fixture_case(
        &temp,
        RawCorpusFamily::DngUncompressedBayer,
        ByteOrder::Little,
    );
    let manifest = manifest_with_case(case);
    let manifest_path = temp.path().join("manifest.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();

    let executable = env!("CARGO_BIN_EXE_hgripe-raw-evidence");
    let validation_output = Command::new(executable)
        .arg("validate")
        .arg(&manifest_path)
        .output()
        .unwrap();
    assert!(
        validation_output.status.success(),
        "{}",
        String::from_utf8_lossy(&validation_output.stderr)
    );
    let validation: serde_json::Value = serde_json::from_slice(&validation_output.stdout).unwrap();
    assert_eq!(validation["valid"], true);
    assert_eq!(validation["coverage"]["complete"], false);

    let evidence_path = temp.path().join("evidence.json");
    let run_output = Command::new(executable)
        .arg("run-owned")
        .arg(&manifest_path)
        .arg(temp.path())
        .arg(&evidence_path)
        .output()
        .unwrap();
    assert!(
        run_output.status.success(),
        "{}",
        String::from_utf8_lossy(&run_output.stderr)
    );
    let bundle: RawEvidenceBundle =
        serde_json::from_slice(&fs::read(&evidence_path).unwrap()).unwrap();
    assert_eq!(bundle.schema_version, RAW_EVIDENCE_SCHEMA_VERSION);
    assert_eq!(
        bundle.manifest_schema_version,
        RAW_CORPUS_MANIFEST_SCHEMA_VERSION
    );
    assert_eq!(bundle.cases.len(), 1);
    assert_eq!(bundle.runner.id, "owned_dng_metadata_probe");
    assert_eq!(bundle.runner.executable_sha256.len(), 64);
    assert_eq!(
        bundle.runner.sensor_artifact_limit_bytes,
        RAW_SENSOR_ARTIFACT_MAX_BYTES
    );
    assert_eq!(
        bundle.runner.sensor_artifact_observation_timeout_ms,
        RAW_SENSOR_ARTIFACT_OBSERVATION_TIMEOUT_MS
    );
    assert!(bundle.runner.sensor_decoder_implementation_id.is_none());
    assert!(bundle.runner.sensor_decoder_artifact_sha256.is_none());
    assert!(!bundle.runner.source_revision.is_empty());
    assert_ne!(bundle.runner.source_revision, "unknown");
    assert!(!bundle.summary.gate_ready);
    assert_eq!(bundle.summary.metadata_probe_succeeded, 1);
    assert_eq!(bundle.summary.sensor_unpack_succeeded, 0);
    assert_eq!(
        bundle.manifest_sha256,
        format!("{:x}", Sha256::digest(fs::read(&manifest_path).unwrap()))
    );
    assert!(matches!(
        bundle.cases[0].outcome,
        RawEvidenceOutcome::ProbeSucceeded { .. }
    ));
    assert!(bundle.cases[0].child_process.is_some());
    assert!(
        !bundle.cases[0]
            .child_process
            .as_ref()
            .unwrap()
            .sensor_artifact_limit_exceeded
    );

    let json: serde_json::Value =
        serde_json::from_slice(&fs::read(&evidence_path).unwrap()).unwrap();
    assert!(json["runner"]["executable_bytes"].is_string());
    assert!(json["cases"][0]["metrics"]["input_bytes"].is_string());
    assert!(json["cases"][0]["metrics"]["peak_working_set_bytes"].is_string());
    assert_eq!(
        json["cases"][0]["metrics"]["sensor_unpack_us"],
        serde_json::Value::Null
    );
    assert_eq!(
        json["cases"][0]["metrics"]["sensor_artifact_observation_us"],
        serde_json::Value::Null
    );
    assert_eq!(
        json["cases"][0]["outcome"]["sensor_unpack"]["status"],
        "not_attempted"
    );

    let overwrite = Command::new(executable)
        .arg("run-owned")
        .arg(&manifest_path)
        .arg(temp.path())
        .arg(&evidence_path)
        .output()
        .unwrap();
    assert!(!overwrite.status.success());
    assert!(String::from_utf8_lossy(&overwrite.stderr).contains("refusing to overwrite"));

    let race_path = temp.path().join("race.json");
    let mut first = bundle.clone();
    first.corpus_id = "race-first".into();
    let mut second = bundle.clone();
    second.corpus_id = "race-second".into();
    let barrier = Arc::new(Barrier::new(3));
    let handles = [("race-first", first), ("race-second", second)]
        .into_iter()
        .map(|(id, candidate)| {
            let barrier = Arc::clone(&barrier);
            let path = race_path.clone();
            std::thread::spawn(move || {
                barrier.wait();
                (id, write_evidence_bundle(&path, &candidate))
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        results.iter().filter(|(_, result)| result.is_ok()).count(),
        1
    );
    let winner = results
        .iter()
        .find(|(_, result)| result.is_ok())
        .map(|(id, _)| *id)
        .unwrap();
    let raced: RawEvidenceBundle = serde_json::from_slice(&fs::read(&race_path).unwrap()).unwrap();
    assert_eq!(raced.corpus_id, winner);

    let sentinel_path = temp.path().join("sentinel.json");
    fs::write(&sentinel_path, b"do-not-replace").unwrap();
    assert!(write_evidence_bundle(&sentinel_path, &bundle).is_err());
    assert_eq!(fs::read(&sentinel_path).unwrap(), b"do-not-replace");

    let bare_name = format!(
        "hgripe-raw-evidence-relative-{}-{}.json",
        std::process::id(),
        NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
    );
    let bare_path = PathBuf::from(&bare_name);
    let _ = fs::remove_file(&bare_path);
    write_evidence_bundle(&bare_path, &bundle).unwrap();
    assert!(bare_path.is_file());
    fs::remove_file(bare_path).unwrap();
}

fn set_little_endian_raw_compression(bytes: &mut [u8], compression: u16) {
    let ifd0_offset = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let ifd0_count = u16::from_le_bytes(bytes[ifd0_offset..ifd0_offset + 2].try_into().unwrap());
    let mut raw_ifd_offset = None;
    for index in 0..usize::from(ifd0_count) {
        let entry = ifd0_offset + 2 + index * 12;
        let tag = u16::from_le_bytes(bytes[entry..entry + 2].try_into().unwrap());
        if tag == 330 {
            raw_ifd_offset =
                Some(u32::from_le_bytes(bytes[entry + 8..entry + 12].try_into().unwrap()) as usize);
            break;
        }
    }
    let raw_ifd_offset = raw_ifd_offset.expect("fixture has a raw SubIFD");
    let raw_count = u16::from_le_bytes(
        bytes[raw_ifd_offset..raw_ifd_offset + 2]
            .try_into()
            .unwrap(),
    );
    for index in 0..usize::from(raw_count) {
        let entry = raw_ifd_offset + 2 + index * 12;
        let tag = u16::from_le_bytes(bytes[entry..entry + 2].try_into().unwrap());
        if tag == 259 {
            bytes[entry + 8..entry + 10].copy_from_slice(&compression.to_le_bytes());
            return;
        }
    }
    panic!("fixture raw SubIFD has no Compression tag");
}

fn manifest_with_case(case: RawCorpusCase) -> RawCorpusManifest {
    RawCorpusManifest {
        schema_version: RAW_CORPUS_MANIFEST_SCHEMA_VERSION,
        corpus_id: "r0-local-corpus".into(),
        cases: vec![case],
    }
}

fn sample_case(family: RawCorpusFamily, relative_path: &str, sha256: &str) -> RawCorpusCase {
    RawCorpusCase {
        id: "sample-case".into(),
        family,
        variant: "test variant".into(),
        relative_path: relative_path.into(),
        sha256: sha256.into(),
        provenance: RawCorpusProvenance {
            origin: RawCorpusOrigin::OwnedCapture,
            rights_reference: "test fixture generated by H-Gripe".into(),
            source_uri: None,
            redistribution: RawRedistributionPolicy::Prohibited,
            contains_personal_metadata: false,
        },
        expected: RawProbeExpectation::default(),
    }
}

fn write_fixture_case(
    temp: &TestDir,
    family: RawCorpusFamily,
    byte_order: ByteOrder,
) -> (RawCorpusCase, PathBuf) {
    let case_dir = temp.path().join("cases");
    fs::create_dir_all(&case_dir).unwrap();
    let file_name = match byte_order {
        ByteOrder::Little => "minimal-le.dng",
        ByteOrder::Big => "minimal-be.dng",
    };
    let path = case_dir.join(file_name);
    let bytes = minimal_dng(byte_order);
    fs::write(&path, &bytes).unwrap();
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let mut case = sample_case(family, &format!("cases/{file_name}"), &sha256);
    case.expected = RawProbeExpectation {
        make: Some("H-Gripe".into()),
        model: Some("Synthetic Bayer".into()),
        dimensions: Some(RawDimensions {
            width: 6,
            height: 6,
        }),
        compression_code: Some(1),
        compression_description: Some("uncompressed".into()),
        cfa_repeat_rows: Some(2),
        cfa_repeat_columns: Some(2),
        sensor_reference: None,
    };
    (case, path)
}

fn test_sensor_reference() -> RawSensorReference {
    RawSensorReference {
        schema_version: RAW_SENSOR_REFERENCE_SCHEMA_VERSION,
        domain: RawSensorReferenceDomain::FullSensorRaster,
        frame: RawSensorFrameSelection::OnlyFullResolutionRawFrame,
        full_resolution_raw_frame_count: 1,
        sample_order: RawSensorSampleOrder::RowMajorInterleaved,
        sample_encoding: RawSensorSampleEncoding::UnsignedU16LittleEndian,
        dimensions: RawSensorReferenceDimensions {
            width: 6,
            height: 6,
        },
        samples_per_pixel: 1,
        sample_count: 36,
        sample_digest_sha256: canonical_sensor_digest_u16_le(&SENSOR_SAMPLES),
        producer: RawSensorReferenceProducer {
            basis: RawSensorReferenceBasis::KnownGeneratedFixture,
            implementation_id: "hgripe-generated-dng-fixture".into(),
            implementation_revision: "1".into(),
            tool_id: "hgripe-generated-dng-fixture".into(),
            tool_version: "1".into(),
            tool_artifact_sha256: "d".repeat(64),
            record_reference: "crates/hgripe-raw/tests/support/dng_fixture.rs".into(),
            record_artifact_sha256: "e".repeat(64),
        },
    }
}

fn assert_sensor_reference_issue(
    case: &RawCorpusCase,
    reference: RawSensorReference,
    expected_code: &str,
) {
    let mut case = case.clone();
    case.expected.sensor_reference = Some(reference);
    let validation = validate_manifest(&manifest_with_case(case));
    assert!(
        validation
            .issues
            .iter()
            .any(|issue| issue.code == expected_code),
        "missing issue {expected_code}: {:?}",
        validation.issues
    );
}

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new() -> Self {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("hgripe-raw-evidence-{}-{id}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
