use crate::manifest::is_safe_windows_relative_path;
use crate::windows_support::{final_path_for_file, path_is_within};
use crate::{
    load_manifest_snapshot, validate_manifest, EvidenceRunError, RawCorpusCase,
    RawCorpusFileVerification, RawCorpusPreflightCase, RawCorpusPreflightReport,
    RawFingerprintDraft, RawFingerprintRequest, RawManifestIssueSeverity, RawProbeExpectation,
    RAW_CORPUS_PREFLIGHT_SCHEMA_VERSION, RAW_FINGERPRINT_DRAFT_SCHEMA_VERSION,
    RAW_REFERENCE_RECORD_MAX_BYTES,
};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

pub fn verify_corpus(
    manifest_path: &Path,
    corpus_root: &Path,
) -> Result<RawCorpusPreflightReport, EvidenceRunError> {
    let snapshot = load_manifest_snapshot(manifest_path)
        .map_err(|error| EvidenceRunError::Manifest(error.to_string()))?;
    let validation = validate_manifest(&snapshot.manifest);
    let root = corpus_root
        .canonicalize()
        .map_err(|error| EvidenceRunError::Io(format!("cannot resolve corpus root: {error}")))?;
    if !root.is_dir() {
        return Err(EvidenceRunError::Environment(
            "corpus root is not a directory".into(),
        ));
    }

    let mut cases = Vec::with_capacity(snapshot.manifest.cases.len());
    for case in &snapshot.manifest.cases {
        let source = verify_relative_file(
            &root,
            &case.relative_path,
            &case.sha256,
            crate::MAX_CORPUS_FILE_BYTES,
        );
        let sensor_reference_present = case.expected.sensor_reference.is_some();
        let sensor_reference_valid = sensor_reference_present
            && !validation.issues.iter().any(|issue| {
                issue.severity == RawManifestIssueSeverity::Error
                    && issue.case_id.as_deref() == Some(case.id.as_str())
                    && issue.code.contains("sensor_reference")
            });
        let reference_record = case.expected.sensor_reference.as_ref().map(|reference| {
            verify_relative_file(
                &root,
                &reference.producer.record_relative_path,
                &reference.producer.record_artifact_sha256,
                RAW_REFERENCE_RECORD_MAX_BYTES,
            )
        });
        let mut issues = Vec::new();
        issues.extend(
            validation
                .issues
                .iter()
                .filter(|issue| {
                    issue.severity == RawManifestIssueSeverity::Error
                        && issue.case_id.as_deref() == Some(case.id.as_str())
                })
                .map(|issue| format!("manifest:{}", issue.code)),
        );
        if !source.verified {
            issues.push("source_file_not_verified".into());
        }
        if !sensor_reference_present {
            issues.push("sensor_reference_missing".into());
        } else if !sensor_reference_valid {
            issues.push("sensor_reference_invalid".into());
        }
        if reference_record
            .as_ref()
            .is_none_or(|record| !record.verified)
        {
            issues.push("reference_record_not_verified".into());
        }
        let ready = issues.is_empty();
        cases.push(RawCorpusPreflightCase {
            case_id: case.id.clone(),
            family: case.family,
            source,
            sensor_reference_present,
            sensor_reference_valid,
            reference_record,
            ready,
            issues,
        });
    }

    let manifest_valid = validation
        .issues
        .iter()
        .all(|issue| issue.severity != RawManifestIssueSeverity::Error);
    let coverage_complete = validation.coverage.complete;
    let has_cases = !cases.is_empty();
    let all_case_files_verified = has_cases && cases.iter().all(|case| case.source.verified);
    let all_sensor_references_complete = has_cases
        && cases
            .iter()
            .all(|case| case.sensor_reference_present && case.sensor_reference_valid);
    let all_reference_records_verified = has_cases
        && cases.iter().all(|case| {
            case.reference_record
                .as_ref()
                .is_some_and(|record| record.verified)
        });
    let corpus_ready = manifest_valid
        && coverage_complete
        && has_cases
        && all_case_files_verified
        && all_sensor_references_complete
        && all_reference_records_verified
        && cases.iter().all(|case| case.ready);

    let final_snapshot = load_manifest_snapshot(manifest_path)
        .map_err(|error| EvidenceRunError::Manifest(error.to_string()))?;
    if final_snapshot.sha256 != snapshot.sha256 {
        return Err(EvidenceRunError::Io(
            "corpus manifest changed during preflight".into(),
        ));
    }

    Ok(RawCorpusPreflightReport {
        schema_version: RAW_CORPUS_PREFLIGHT_SCHEMA_VERSION,
        manifest_schema_version: snapshot.manifest.schema_version,
        manifest_sha256: snapshot.sha256,
        corpus_id: snapshot.manifest.corpus_id,
        manifest_validation: validation,
        coverage_complete,
        all_case_files_verified,
        all_sensor_references_complete,
        all_reference_records_verified,
        corpus_ready,
        cases,
    })
}

pub fn fingerprint_case(
    corpus_root: &Path,
    request: RawFingerprintRequest,
) -> Result<RawFingerprintDraft, EvidenceRunError> {
    validate_fingerprint_request(&request)?;
    let root = corpus_root
        .canonicalize()
        .map_err(|error| EvidenceRunError::Io(format!("cannot resolve corpus root: {error}")))?;
    if !root.is_dir() {
        return Err(EvidenceRunError::Environment(
            "corpus root is not a directory".into(),
        ));
    }
    let (file, _) = open_relative_file(&root, &request.relative_path)?;
    let (observed_bytes, sha256) = hash_bounded_file(file, crate::MAX_CORPUS_FILE_BYTES)?;
    let case = RawCorpusCase {
        id: request.id,
        family: request.family,
        variant: request.variant,
        relative_path: request.relative_path,
        sha256,
        provenance: request.provenance,
        expected: RawProbeExpectation::default(),
    };
    Ok(RawFingerprintDraft {
        schema_version: RAW_FINGERPRINT_DRAFT_SCHEMA_VERSION,
        observed_bytes,
        case,
        operator_asserted_fields: vec![
            "id".into(),
            "family".into(),
            "variant".into(),
            "relative_path".into(),
            "provenance.origin".into(),
            "provenance.rights_reference".into(),
            "provenance.source_uri".into(),
            "provenance.redistribution".into(),
            "provenance.contains_personal_metadata".into(),
        ],
        unresolved_fields: vec![
            "expected.make".into(),
            "expected.model".into(),
            "expected.dimensions".into(),
            "expected.compression".into(),
            "expected.cfa_repeat".into(),
            "expected.sensor_reference".into(),
        ],
    })
}

fn validate_fingerprint_request(request: &RawFingerprintRequest) -> Result<(), EvidenceRunError> {
    if !is_safe_windows_relative_path(&request.relative_path) {
        return Err(EvidenceRunError::Environment(
            "fingerprint relative_path is unsafe under Windows path rules".into(),
        ));
    }
    let stable_identifier = !request.id.is_empty()
        && request.id.len() <= 128
        && request
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if !stable_identifier {
        return Err(EvidenceRunError::Environment(
            "fingerprint id must be a stable ASCII identifier".into(),
        ));
    }
    if request.variant.trim().is_empty() || request.variant.len() > 256 {
        return Err(EvidenceRunError::Environment(
            "fingerprint variant must contain 1 through 256 characters".into(),
        ));
    }
    if request.provenance.rights_reference.trim().is_empty()
        || request.provenance.rights_reference.len() > 1024
    {
        return Err(EvidenceRunError::Environment(
            "fingerprint rights_reference must contain 1 through 1024 characters".into(),
        ));
    }
    if request
        .provenance
        .source_uri
        .as_ref()
        .is_some_and(|uri| uri.trim().is_empty())
    {
        return Err(EvidenceRunError::Environment(
            "fingerprint source_uri cannot be empty".into(),
        ));
    }
    Ok(())
}

fn verify_relative_file(
    root: &Path,
    relative_path: &str,
    expected_sha256: &str,
    limit: u64,
) -> RawCorpusFileVerification {
    let result = (|| {
        let (file, _) = open_relative_file(root, relative_path)?;
        hash_bounded_file(file, limit)
    })();
    match result {
        Ok((observed_bytes, observed_sha256)) => {
            let verified = observed_sha256 == expected_sha256;
            RawCorpusFileVerification {
                relative_path: relative_path.into(),
                expected_sha256: expected_sha256.into(),
                observed_sha256: Some(observed_sha256),
                observed_bytes: Some(observed_bytes),
                verified,
                error: (!verified).then(|| "sha256_mismatch".into()),
            }
        }
        Err(error) => RawCorpusFileVerification {
            relative_path: relative_path.into(),
            expected_sha256: expected_sha256.into(),
            observed_sha256: None,
            observed_bytes: None,
            verified: false,
            error: Some(error.to_string()),
        },
    }
}

fn open_relative_file(
    root: &Path,
    relative_path: &str,
) -> Result<(File, PathBuf), EvidenceRunError> {
    if !is_safe_windows_relative_path(relative_path) {
        return Err(EvidenceRunError::Environment(
            "relative path is unsafe under Windows path rules".into(),
        ));
    }
    let candidate = root.join(relative_path);
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&candidate)
        .map_err(|error| EvidenceRunError::Io(format!("cannot open file: {error}")))?;
    if !file
        .metadata()
        .map_err(|error| EvidenceRunError::Io(format!("cannot inspect file: {error}")))?
        .is_file()
    {
        return Err(EvidenceRunError::Environment(
            "path does not resolve to a regular file".into(),
        ));
    }
    let resolved = final_path_for_file(&file)
        .map_err(|error| EvidenceRunError::Io(format!("cannot resolve open file: {error}")))?;
    if !path_is_within(root, &resolved) {
        return Err(EvidenceRunError::Environment(
            "open file resolves outside the corpus root".into(),
        ));
    }
    Ok((file, resolved))
}

fn hash_bounded_file(mut file: File, limit: u64) -> Result<(u64, String), EvidenceRunError> {
    let declared = file
        .metadata()
        .map_err(|error| EvidenceRunError::Io(format!("cannot inspect file: {error}")))?
        .len();
    if declared == 0 || declared > limit {
        return Err(EvidenceRunError::Io(format!(
            "file is {declared} bytes; expected 1 through {limit}"
        )));
    }
    let mut hasher = Sha256::new();
    let mut observed = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| EvidenceRunError::Io(format!("cannot hash file: {error}")))?;
        if read == 0 {
            break;
        }
        observed = observed
            .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            .ok_or_else(|| EvidenceRunError::Io("file length overflow".into()))?;
        if observed > limit {
            return Err(EvidenceRunError::Io(format!("file exceeds {limit} bytes")));
        }
        hasher.update(&buffer[..read]);
    }
    let final_length = file
        .metadata()
        .map_err(|error| EvidenceRunError::Io(format!("cannot re-inspect file: {error}")))?
        .len();
    if observed != declared || final_length != declared {
        return Err(EvidenceRunError::Environment(
            "file changed while it was being fingerprinted".into(),
        ));
    }
    Ok((observed, format!("{:x}", hasher.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        RawCorpusFamily, RawCorpusManifest, RawCorpusOrigin, RawCorpusProvenance,
        RawRedistributionPolicy, RawSensorFrameSelection, RawSensorReference,
        RawSensorReferenceBasis, RawSensorReferenceDimensions, RawSensorReferenceDomain,
        RawSensorReferenceProducer, RawSensorSampleEncoding, RawSensorSampleOrder,
        RAW_CORPUS_MANIFEST_SCHEMA_VERSION, RAW_SENSOR_REFERENCE_SCHEMA_VERSION,
    };
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn fingerprint_hashes_only_and_leaves_raw_facts_unresolved() {
        let temp = TestDir::new();
        fs::create_dir(temp.path.join("cases")).unwrap();
        fs::write(temp.path.join("cases/sample.raw"), b"camera-bytes").unwrap();
        let request = RawFingerprintRequest {
            id: "operator-case".into(),
            family: RawCorpusFamily::CanonCr3,
            variant: "operator asserted CR3".into(),
            relative_path: "cases/sample.raw".into(),
            provenance: provenance(),
        };

        let draft = fingerprint_case(&temp.path, request).unwrap();
        assert_eq!(draft.observed_bytes, 12);
        assert_eq!(
            draft.case.sha256,
            format!("{:x}", Sha256::digest(b"camera-bytes"))
        );
        assert_eq!(draft.case.family, RawCorpusFamily::CanonCr3);
        assert_eq!(draft.case.expected, RawProbeExpectation::default());
        assert!(draft
            .unresolved_fields
            .contains(&"expected.sensor_reference".into()));
        assert!(draft
            .operator_asserted_fields
            .contains(&"provenance.rights_reference".into()));
    }

    #[test]
    fn fingerprint_rejects_unsafe_paths_and_missing_rights() {
        let temp = TestDir::new();
        let request = RawFingerprintRequest {
            id: "case".into(),
            family: RawCorpusFamily::NikonNef,
            variant: "test".into(),
            relative_path: "../escape.nef".into(),
            provenance: provenance(),
        };
        assert!(fingerprint_case(&temp.path, request).is_err());

        fs::write(temp.path.join("sample.nef"), b"bytes").unwrap();
        let mut request = RawFingerprintRequest {
            id: "case".into(),
            family: RawCorpusFamily::NikonNef,
            variant: "test".into(),
            relative_path: "sample.nef".into(),
            provenance: provenance(),
        };
        request.provenance.rights_reference.clear();
        assert!(fingerprint_case(&temp.path, request).is_err());
    }

    #[test]
    fn preflight_requires_every_source_reference_and_family() {
        let temp = TestDir::new();
        let manifest_path = temp.path.join("manifest.json");
        let manifest = complete_manifest(&temp);
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let ready = verify_corpus(&manifest_path, &temp.path).unwrap();
        assert!(ready.corpus_ready);
        assert!(ready.coverage_complete);
        assert!(ready.all_case_files_verified);
        assert!(ready.all_sensor_references_complete);
        assert!(ready.all_reference_records_verified);
        assert!(ready.cases.iter().all(|case| case.ready));

        fs::write(temp.path.join("references/case-0.json"), b"tampered").unwrap();
        let tampered = verify_corpus(&manifest_path, &temp.path).unwrap();
        assert!(!tampered.corpus_ready);
        assert!(!tampered.all_reference_records_verified);
        assert_eq!(
            tampered.cases[0]
                .reference_record
                .as_ref()
                .unwrap()
                .error
                .as_deref(),
            Some("sha256_mismatch")
        );
    }

    fn complete_manifest(temp: &TestDir) -> RawCorpusManifest {
        fs::create_dir(temp.path.join("cases")).unwrap();
        fs::create_dir(temp.path.join("references")).unwrap();
        let mut cases = Vec::new();
        for (index, family) in RawCorpusFamily::REQUIRED.into_iter().enumerate() {
            let source = format!("source-{index}");
            let source_path = format!("cases/case-{index}.raw");
            let record = format!("reference-{index}");
            let record_path = format!("references/case-{index}.json");
            fs::write(temp.path.join(&source_path), source.as_bytes()).unwrap();
            fs::write(temp.path.join(&record_path), record.as_bytes()).unwrap();
            let mut expected = RawProbeExpectation {
                dimensions: Some(hgripe_raw::RawDimensions {
                    width: 1,
                    height: 1,
                }),
                sensor_reference: Some(sensor_reference(
                    &record_path,
                    format!("{:x}", Sha256::digest(record.as_bytes())),
                )),
                ..RawProbeExpectation::default()
            };
            if family == RawCorpusFamily::DngUncompressedBayer {
                expected.compression_code = Some(1);
            }
            if family == RawCorpusFamily::DngLosslessCompressedBayer {
                expected.compression_code = Some(7);
            }
            if matches!(
                family,
                RawCorpusFamily::DngUncompressedBayer | RawCorpusFamily::DngLosslessCompressedBayer
            ) {
                expected.cfa_repeat_rows = Some(2);
                expected.cfa_repeat_columns = Some(2);
            }
            if family == RawCorpusFamily::FujifilmRafXTrans {
                expected.cfa_repeat_rows = Some(6);
                expected.cfa_repeat_columns = Some(6);
            }
            match family {
                RawCorpusFamily::CanonCr3 => {
                    expected.compression_description = Some("canon_cr3_raw".into());
                }
                RawCorpusFamily::CanonCr3Craw => {
                    expected.compression_description = Some("canon_cr3_c_raw".into());
                }
                _ => {}
            }
            cases.push(RawCorpusCase {
                id: format!("case-{index}"),
                family,
                variant: "test corpus case".into(),
                relative_path: source_path,
                sha256: format!("{:x}", Sha256::digest(source.as_bytes())),
                provenance: provenance(),
                expected,
            });
        }
        RawCorpusManifest {
            schema_version: RAW_CORPUS_MANIFEST_SCHEMA_VERSION,
            corpus_id: "complete-preflight".into(),
            cases,
        }
    }

    fn sensor_reference(record_path: &str, record_digest: String) -> RawSensorReference {
        RawSensorReference {
            schema_version: RAW_SENSOR_REFERENCE_SCHEMA_VERSION,
            domain: RawSensorReferenceDomain::FullSensorRaster,
            frame: RawSensorFrameSelection::OnlyFullResolutionRawFrame,
            full_resolution_raw_frame_count: 1,
            sample_order: RawSensorSampleOrder::RowMajorInterleaved,
            sample_encoding: RawSensorSampleEncoding::UnsignedU16LittleEndian,
            dimensions: RawSensorReferenceDimensions {
                width: 1,
                height: 1,
            },
            samples_per_pixel: 1,
            sample_count: 1,
            sample_digest_sha256: "a".repeat(64),
            producer: RawSensorReferenceProducer {
                basis: RawSensorReferenceBasis::IndependentDecoder,
                implementation_id: "reference-decoder".into(),
                implementation_revision: "1".into(),
                tool_id: "reference-tool".into(),
                tool_version: "1".into(),
                tool_artifact_sha256: "b".repeat(64),
                record_reference: "local record".into(),
                record_relative_path: record_path.into(),
                record_artifact_sha256: record_digest,
            },
        }
    }

    fn provenance() -> RawCorpusProvenance {
        RawCorpusProvenance {
            origin: RawCorpusOrigin::LocalEvaluationOnly,
            rights_reference: "operator supplied rights record".into(),
            source_uri: None,
            redistribution: RawRedistributionPolicy::Prohibited,
            contains_personal_metadata: false,
        }
    }

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("hgripe-raw-intake-{}-{id}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
