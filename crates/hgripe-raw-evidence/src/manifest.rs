use crate::{
    RawCorpusCoverage, RawCorpusFamily, RawCorpusManifest, RawCorpusOrigin, RawManifestIssue,
    RawManifestIssueSeverity, RawManifestValidation, RawSensorReference, RawSensorReferenceBasis,
    RAW_CORPUS_MANIFEST_SCHEMA_VERSION, RAW_SENSOR_ARTIFACT_MAX_BYTES,
    RAW_SENSOR_REFERENCE_SCHEMA_VERSION,
};
use hgripe_raw::RawDimensions;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path};

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

#[derive(Debug)]
pub enum ManifestLoadError {
    Io(String),
    TooLarge { actual: u64, limit: u64 },
    Json(String),
}

#[derive(Debug, Clone)]
pub struct RawManifestSnapshot {
    pub manifest: RawCorpusManifest,
    pub sha256: String,
}

impl fmt::Display for ManifestLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) => write!(formatter, "cannot read corpus manifest: {message}"),
            Self::TooLarge { actual, limit } => {
                write!(
                    formatter,
                    "corpus manifest is {actual} bytes; limit is {limit}"
                )
            }
            Self::Json(message) => write!(formatter, "invalid corpus manifest JSON: {message}"),
        }
    }
}

impl std::error::Error for ManifestLoadError {}

pub fn load_manifest(path: &Path) -> Result<RawCorpusManifest, ManifestLoadError> {
    Ok(load_manifest_snapshot(path)?.manifest)
}

pub fn load_manifest_snapshot(path: &Path) -> Result<RawManifestSnapshot, ManifestLoadError> {
    let file = File::open(path).map_err(|error| ManifestLoadError::Io(error.to_string()))?;
    let declared_length = file
        .metadata()
        .map_err(|error| ManifestLoadError::Io(error.to_string()))?
        .len();
    if declared_length > MAX_MANIFEST_BYTES {
        return Err(ManifestLoadError::TooLarge {
            actual: declared_length,
            limit: MAX_MANIFEST_BYTES,
        });
    }

    let mut bytes = Vec::with_capacity(usize::try_from(declared_length).unwrap_or(0));
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| ManifestLoadError::Io(error.to_string()))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_MANIFEST_BYTES {
        return Err(ManifestLoadError::TooLarge {
            actual: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            limit: MAX_MANIFEST_BYTES,
        });
    }
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let manifest = serde_json::from_slice(&bytes)
        .map_err(|error| ManifestLoadError::Json(error.to_string()))?;
    Ok(RawManifestSnapshot { manifest, sha256 })
}

pub fn validate_manifest(manifest: &RawCorpusManifest) -> RawManifestValidation {
    let mut issues = Vec::new();
    if manifest.schema_version != RAW_CORPUS_MANIFEST_SCHEMA_VERSION {
        error(
            &mut issues,
            "unsupported_schema_version",
            None,
            format!(
                "manifest schema_version {} does not match {}",
                manifest.schema_version, RAW_CORPUS_MANIFEST_SCHEMA_VERSION
            ),
        );
    }
    validate_identifier(
        &mut issues,
        "invalid_corpus_id",
        None,
        "corpus_id",
        &manifest.corpus_id,
    );
    if manifest.cases.is_empty() {
        error(
            &mut issues,
            "empty_corpus",
            None,
            "manifest contains no cases".into(),
        );
    }

    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    let mut families = HashSet::new();
    let source_path_keys = manifest
        .cases
        .iter()
        .map(|case| windows_path_key(&case.relative_path))
        .collect::<HashSet<_>>();
    for case in &manifest.cases {
        let case_id = Some(case.id.clone());
        validate_identifier(
            &mut issues,
            "invalid_case_id",
            case_id.clone(),
            "case id",
            &case.id,
        );
        if !ids.insert(case.id.clone()) {
            error(
                &mut issues,
                "duplicate_case_id",
                case_id.clone(),
                format!("case id '{}' appears more than once", case.id),
            );
        }
        if case.variant.trim().is_empty() || case.variant.len() > 256 {
            error(
                &mut issues,
                "invalid_variant",
                case_id.clone(),
                "variant must contain 1 through 256 characters".into(),
            );
        }
        validate_relative_path(&mut issues, case_id.clone(), &case.relative_path);
        if !paths.insert(windows_path_key(&case.relative_path)) {
            error(
                &mut issues,
                "duplicate_relative_path",
                case_id.clone(),
                format!(
                    "relative_path '{}' appears more than once",
                    case.relative_path
                ),
            );
        }
        if !is_lower_hex_sha256(&case.sha256) {
            error(
                &mut issues,
                "invalid_sha256",
                case_id.clone(),
                "sha256 must be exactly 64 lowercase hexadecimal characters".into(),
            );
        }
        if case.provenance.rights_reference.trim().is_empty()
            || case.provenance.rights_reference.len() > 1024
        {
            error(
                &mut issues,
                "missing_rights_reference",
                case_id.clone(),
                "rights_reference must contain 1 through 1024 characters".into(),
            );
        }
        if case
            .provenance
            .source_uri
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        {
            error(
                &mut issues,
                "empty_source_uri",
                case_id.clone(),
                "source_uri cannot be an empty string".into(),
            );
        }
        match (
            case.expected.cfa_repeat_rows,
            case.expected.cfa_repeat_columns,
        ) {
            (None, None) => {}
            (Some(rows), Some(columns))
                if rows > 0 && columns > 0 && rows <= 64 && columns <= 64 => {}
            _ => error(
                &mut issues,
                "invalid_cfa_expectation",
                case_id.clone(),
                "CFA repeat rows and columns must both be present and between 1 and 64".into(),
            ),
        }
        if let Some(reference) = &case.expected.sensor_reference {
            validate_sensor_reference(
                &mut issues,
                case_id.clone(),
                case.expected.dimensions,
                case.provenance.origin,
                reference,
            );
            if source_path_keys
                .contains(&windows_path_key(&reference.producer.record_relative_path))
            {
                error(
                    &mut issues,
                    "sensor_reference_record_is_source_file",
                    case_id.clone(),
                    "sensor reference record_relative_path must not identify a corpus source file"
                        .into(),
                );
            }
        }
        if case.family == RawCorpusFamily::DngUncompressedBayer
            && case.expected.compression_code.is_some_and(|code| code != 1)
        {
            error(
                &mut issues,
                "contradictory_compression_expectation",
                case_id.clone(),
                "uncompressed DNG family requires TIFF compression code 1".into(),
            );
        }
        if case.family == RawCorpusFamily::DngLosslessCompressedBayer
            && case
                .expected
                .compression_code
                .is_some_and(|code| !matches!(code, 7 | 8))
        {
            error(
                &mut issues,
                "contradictory_compression_expectation",
                case_id.clone(),
                "lossless-compressed DNG family requires TIFF compression code 7 or 8".into(),
            );
        }
        let required_compression_description = match case.family {
            RawCorpusFamily::CanonCr3 => Some("canon_cr3_raw"),
            RawCorpusFamily::CanonCr3Craw => Some("canon_cr3_c_raw"),
            _ => None,
        };
        if let Some(required) = required_compression_description {
            if case.expected.compression_description.as_deref() != Some(required) {
                error(
                    &mut issues,
                    "missing_variant_discriminator",
                    case_id.clone(),
                    format!(
                        "{:?} requires expected.compression_description '{required}'",
                        case.family
                    ),
                );
            }
        }
        if matches!(
            case.family,
            RawCorpusFamily::DngUncompressedBayer | RawCorpusFamily::DngLosslessCompressedBayer
        ) && matches!(
            (
                case.expected.cfa_repeat_rows,
                case.expected.cfa_repeat_columns
            ),
            (Some(rows), Some(columns)) if rows != 2 || columns != 2
        ) {
            error(
                &mut issues,
                "contradictory_cfa_expectation",
                case_id.clone(),
                "Bayer DNG family requires a 2x2 CFA repeat".into(),
            );
        }
        if case.family == RawCorpusFamily::FujifilmRafXTrans
            && matches!(
                (
                    case.expected.cfa_repeat_rows,
                    case.expected.cfa_repeat_columns
                ),
                (Some(rows), Some(columns)) if rows != 6 || columns != 6
            )
        {
            error(
                &mut issues,
                "contradictory_cfa_expectation",
                case_id.clone(),
                "Fujifilm RAF X-Trans family requires a 6x6 CFA repeat".into(),
            );
        }
        families.insert(case.family);
    }

    let present = RawCorpusFamily::REQUIRED
        .into_iter()
        .filter(|family| families.contains(family))
        .collect::<Vec<_>>();
    let missing = RawCorpusFamily::REQUIRED
        .into_iter()
        .filter(|family| !families.contains(family))
        .collect::<Vec<_>>();
    for family in &missing {
        warning(
            &mut issues,
            "missing_required_family",
            None,
            format!("corpus does not yet contain required family {family:?}"),
        );
    }
    let valid = !issues
        .iter()
        .any(|issue| issue.severity == RawManifestIssueSeverity::Error);
    RawManifestValidation {
        valid,
        coverage: RawCorpusCoverage {
            complete: missing.is_empty(),
            present,
            missing,
        },
        issues,
    }
}

fn validate_identifier(
    issues: &mut Vec<RawManifestIssue>,
    code: &str,
    case_id: Option<String>,
    field: &str,
    value: &str,
) {
    if !is_valid_identifier(value) {
        error(
            issues,
            code,
            case_id,
            format!("{field} must contain 1 through 128 ASCII letters, digits, '.', '_' or '-'"),
        );
    }
}

fn is_valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn is_canonical_implementation_id(value: &str) -> bool {
    is_valid_identifier(value) && !value.bytes().any(|byte| byte.is_ascii_uppercase())
}

fn validate_relative_path(
    issues: &mut Vec<RawManifestIssue>,
    case_id: Option<String>,
    value: &str,
) {
    if !is_safe_windows_relative_path(value) {
        error(
            issues,
            "unsafe_relative_path",
            case_id,
            "relative_path must use safe Windows '/'-separated relative components".into(),
        );
    }
}

pub(crate) fn is_safe_windows_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && value.len() <= 1024
        && !value.contains('\\')
        && !path.is_absolute()
        && path.components().all(|component| match component {
            Component::Normal(component) => {
                valid_windows_component(component.to_string_lossy().as_ref())
            }
            _ => false,
        })
}

fn valid_windows_component(component: &str) -> bool {
    if component.is_empty()
        || component.ends_with(['.', ' '])
        || component.chars().any(|character| {
            character <= '\u{1f}' || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
        })
    {
        return false;
    }

    let stem = component
        .split_once('.')
        .map_or(component, |(stem, _)| stem)
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) && !(stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn windows_path_key(path: &str) -> String {
    path.to_lowercase()
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_sensor_reference(
    issues: &mut Vec<RawManifestIssue>,
    case_id: Option<String>,
    expected_dimensions: Option<RawDimensions>,
    origin: RawCorpusOrigin,
    reference: &RawSensorReference,
) {
    if reference.schema_version != RAW_SENSOR_REFERENCE_SCHEMA_VERSION {
        error(
            issues,
            "unsupported_sensor_reference_schema",
            case_id.clone(),
            format!(
                "sensor reference schema_version {} does not match {}",
                reference.schema_version, RAW_SENSOR_REFERENCE_SCHEMA_VERSION
            ),
        );
    }
    if reference.full_resolution_raw_frame_count != 1 {
        error(
            issues,
            "ambiguous_sensor_reference_frame",
            case_id.clone(),
            "sensor reference schema 2 requires exactly one full-resolution RAW frame".into(),
        );
    }
    if reference.dimensions.width == 0 || reference.dimensions.height == 0 {
        error(
            issues,
            "invalid_sensor_reference_dimensions",
            case_id.clone(),
            "sensor reference dimensions must be non-zero".into(),
        );
    }
    if reference.samples_per_pixel != 1 {
        error(
            issues,
            "unsupported_sensor_reference_samples_per_pixel",
            case_id.clone(),
            "sensor reference schema 2 supports one CFA sample per pixel only".into(),
        );
    }
    let expected_count = u64::from(reference.dimensions.width)
        .checked_mul(u64::from(reference.dimensions.height))
        .and_then(|pixels| pixels.checked_mul(u64::from(reference.samples_per_pixel)));
    if expected_count != Some(reference.sample_count) || reference.sample_count == 0 {
        error(
            issues,
            "contradictory_sensor_reference_count",
            case_id.clone(),
            "sensor reference sample_count must equal width * height * samples_per_pixel".into(),
        );
    }
    if reference
        .sample_count
        .checked_mul(2)
        .is_none_or(|bytes| bytes > RAW_SENSOR_ARTIFACT_MAX_BYTES)
    {
        error(
            issues,
            "sensor_reference_artifact_too_large",
            case_id.clone(),
            format!(
                "sensor reference canonical bytes must not exceed {RAW_SENSOR_ARTIFACT_MAX_BYTES}"
            ),
        );
    }
    if expected_dimensions.is_some_and(|dimensions| {
        dimensions.width != reference.dimensions.width
            || dimensions.height != reference.dimensions.height
    }) {
        error(
            issues,
            "contradictory_sensor_reference_dimensions",
            case_id.clone(),
            "sensor reference dimensions must match expected dimensions".into(),
        );
    }
    if !is_lower_hex_sha256(&reference.sample_digest_sha256) {
        error(
            issues,
            "invalid_sensor_reference_digest",
            case_id.clone(),
            "sensor reference digest must be lowercase SHA-256".into(),
        );
    }
    if !is_valid_identifier(&reference.producer.tool_id) {
        error(
            issues,
            "invalid_sensor_reference_tool_id",
            case_id.clone(),
            "sensor reference tool_id must be a stable ASCII identifier".into(),
        );
    }
    if !is_canonical_implementation_id(&reference.producer.implementation_id) {
        error(
            issues,
            "invalid_sensor_reference_implementation_id",
            case_id.clone(),
            "sensor reference implementation_id must be a canonical lowercase ASCII identifier"
                .into(),
        );
    }
    validate_bounded_text(
        issues,
        "invalid_sensor_reference_implementation_revision",
        case_id.clone(),
        "sensor reference implementation_revision",
        &reference.producer.implementation_revision,
        128,
    );
    validate_bounded_text(
        issues,
        "invalid_sensor_reference_tool_version",
        case_id.clone(),
        "sensor reference tool_version",
        &reference.producer.tool_version,
        128,
    );
    if !is_lower_hex_sha256(&reference.producer.tool_artifact_sha256) {
        error(
            issues,
            "invalid_sensor_reference_tool_artifact",
            case_id.clone(),
            "sensor reference tool_artifact_sha256 must be lowercase SHA-256".into(),
        );
    }
    validate_bounded_text(
        issues,
        "invalid_sensor_reference_record",
        case_id.clone(),
        "sensor reference record_reference",
        &reference.producer.record_reference,
        1024,
    );
    if !is_safe_windows_relative_path(&reference.producer.record_relative_path) {
        error(
            issues,
            "unsafe_sensor_reference_record_path",
            case_id.clone(),
            "sensor reference record_relative_path must use safe Windows '/'-separated relative components"
                .into(),
        );
    }
    if !is_lower_hex_sha256(&reference.producer.record_artifact_sha256) {
        error(
            issues,
            "invalid_sensor_reference_record_artifact",
            case_id.clone(),
            "sensor reference record_artifact_sha256 must be lowercase SHA-256".into(),
        );
    }
    if reference.producer.basis == RawSensorReferenceBasis::KnownGeneratedFixture
        && origin != RawCorpusOrigin::RedistributableFixture
    {
        error(
            issues,
            "contradictory_sensor_reference_basis",
            case_id,
            "known_generated_fixture references require redistributable_fixture provenance".into(),
        );
    }
}

fn validate_bounded_text(
    issues: &mut Vec<RawManifestIssue>,
    code: &str,
    case_id: Option<String>,
    field: &str,
    value: &str,
    limit: usize,
) {
    if value.trim().is_empty() || value.len() > limit {
        error(
            issues,
            code,
            case_id,
            format!("{field} must contain 1 through {limit} characters"),
        );
    }
}

fn error(issues: &mut Vec<RawManifestIssue>, code: &str, case_id: Option<String>, message: String) {
    issues.push(RawManifestIssue {
        severity: RawManifestIssueSeverity::Error,
        code: code.into(),
        case_id,
        message,
    });
}

fn warning(
    issues: &mut Vec<RawManifestIssue>,
    code: &str,
    case_id: Option<String>,
    message: String,
) {
    issues.push(RawManifestIssue {
        severity: RawManifestIssueSeverity::Warning,
        code: code.into(),
        case_id,
        message,
    });
}
