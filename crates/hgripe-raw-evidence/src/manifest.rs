use crate::{
    RawCorpusCoverage, RawCorpusFamily, RawCorpusManifest, RawManifestIssue,
    RawManifestIssueSeverity, RawManifestValidation, RAW_CORPUS_MANIFEST_SCHEMA_VERSION,
};
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
        match (
            case.expected.sensor_sample_count,
            case.expected.sensor_sample_digest_sha256.as_deref(),
            case.expected.sensor_reference.as_deref(),
        ) {
            (None, None, None) => {}
            (Some(count), Some(digest), Some(reference))
                if count > 0
                    && is_lower_hex_sha256(digest)
                    && !reference.trim().is_empty()
                    && reference.len() <= 1024 =>
            {
                if case.expected.dimensions.is_some_and(|dimensions| {
                    u64::from(dimensions.width).checked_mul(u64::from(dimensions.height))
                        != Some(count)
                }) {
                    error(
                        &mut issues,
                        "contradictory_sensor_expectation",
                        case_id.clone(),
                        "sensor_sample_count must match expected dimensions for one-sample CFA data"
                            .into(),
                    );
                }
            }
            _ => error(
                &mut issues,
                "invalid_sensor_expectation",
                case_id.clone(),
                "sensor count, lowercase SHA-256, and a 1..1024 character independent reference must all be present or all omitted".into(),
            ),
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
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if !valid {
        error(
            issues,
            code,
            case_id,
            format!("{field} must contain 1 through 128 ASCII letters, digits, '.', '_' or '-'"),
        );
    }
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
