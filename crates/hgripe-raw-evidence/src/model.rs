use hgripe_raw::{RawContainer, RawDimensions, RawProbeError, RawProbeReport};
use serde::{Deserialize, Serialize};

pub const RAW_CORPUS_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const RAW_EVIDENCE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawCorpusFamily {
    DngUncompressedBayer,
    DngLosslessCompressedBayer,
    CanonCr2,
    CanonCr3,
    CanonCr3Craw,
    NikonNef,
    SonyArw,
    FujifilmRafXTrans,
    OlympusOrf,
    PanasonicRw2,
}

impl RawCorpusFamily {
    pub const REQUIRED: [Self; 10] = [
        Self::DngUncompressedBayer,
        Self::DngLosslessCompressedBayer,
        Self::CanonCr2,
        Self::CanonCr3,
        Self::CanonCr3Craw,
        Self::NikonNef,
        Self::SonyArw,
        Self::FujifilmRafXTrans,
        Self::OlympusOrf,
        Self::PanasonicRw2,
    ];

    pub const fn expected_container(self) -> RawContainer {
        match self {
            Self::DngUncompressedBayer | Self::DngLosslessCompressedBayer => RawContainer::DngTiff,
            Self::CanonCr2 => RawContainer::CanonCr2,
            Self::CanonCr3 | Self::CanonCr3Craw => RawContainer::CanonCr3,
            Self::NikonNef => RawContainer::NikonNef,
            Self::SonyArw => RawContainer::SonyArw,
            Self::FujifilmRafXTrans => RawContainer::FujifilmRaf,
            Self::OlympusOrf => RawContainer::OlympusOrf,
            Self::PanasonicRw2 => RawContainer::PanasonicRw2,
        }
    }

    pub const fn supported_by_owned_probe(self) -> bool {
        matches!(
            self,
            Self::DngUncompressedBayer | Self::DngLosslessCompressedBayer
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawCorpusOrigin {
    OwnedCapture,
    RedistributableFixture,
    LocalEvaluationOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawRedistributionPolicy {
    Permitted,
    Prohibited,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawCorpusProvenance {
    pub origin: RawCorpusOrigin,
    pub rights_reference: String,
    pub source_uri: Option<String>,
    pub redistribution: RawRedistributionPolicy,
    pub contains_personal_metadata: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct RawProbeExpectation {
    pub make: Option<String>,
    pub model: Option<String>,
    pub dimensions: Option<RawDimensions>,
    pub compression_code: Option<u32>,
    pub compression_description: Option<String>,
    pub cfa_repeat_rows: Option<u32>,
    pub cfa_repeat_columns: Option<u32>,
    #[serde(with = "decimal_u64_option")]
    pub sensor_sample_count: Option<u64>,
    pub sensor_sample_digest_sha256: Option<String>,
    pub sensor_reference: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawCorpusCase {
    pub id: String,
    pub family: RawCorpusFamily,
    pub variant: String,
    pub relative_path: String,
    pub sha256: String,
    pub provenance: RawCorpusProvenance,
    #[serde(default)]
    pub expected: RawProbeExpectation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawCorpusManifest {
    pub schema_version: u32,
    pub corpus_id: String,
    pub cases: Vec<RawCorpusCase>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawManifestIssueSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawManifestIssue {
    pub severity: RawManifestIssueSeverity,
    pub code: String,
    pub case_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawCorpusCoverage {
    pub complete: bool,
    pub present: Vec<RawCorpusFamily>,
    pub missing: Vec<RawCorpusFamily>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawManifestValidation {
    pub valid: bool,
    pub coverage: RawCorpusCoverage,
    pub issues: Vec<RawManifestIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawRunnerIdentity {
    pub id: String,
    pub version: String,
    pub source_revision: String,
    pub source_dirty: Option<bool>,
    pub source_license: String,
    pub platform: String,
    pub build_profile: String,
    pub executable_name: String,
    pub executable_sha256: String,
    #[serde(with = "decimal_u64")]
    pub executable_bytes: u64,
    #[serde(with = "decimal_u64")]
    pub bundled_runtime_payload_bytes: u64,
    #[serde(with = "decimal_u64")]
    pub case_timeout_ms: u64,
    #[serde(with = "decimal_u64")]
    pub case_memory_limit_bytes: u64,
    pub case_process_limit: u32,
    #[serde(with = "decimal_u64")]
    pub child_output_limit_bytes: u64,
    pub supported_families: Vec<RawCorpusFamily>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawEvidenceSummary {
    pub total_cases: u32,
    pub metadata_probe_succeeded: u32,
    pub sensor_unpack_succeeded: u32,
    pub unsupported_cases: u32,
    pub integrity_mismatches: u32,
    pub failed_cases: u32,
    pub failed_expectation_checks: u32,
    pub runner_eligible: bool,
    pub gate_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawEvidenceMetrics {
    #[serde(with = "decimal_u64")]
    pub input_bytes: u64,
    #[serde(with = "decimal_u64")]
    pub read_and_hash_us: u64,
    #[serde(with = "decimal_u64_option")]
    pub metadata_probe_us: Option<u64>,
    #[serde(with = "decimal_u64_option")]
    pub sensor_unpack_us: Option<u64>,
    #[serde(with = "decimal_u64")]
    pub total_us: u64,
    #[serde(with = "decimal_u64_option")]
    pub peak_working_set_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawChildProcessMetrics {
    #[serde(with = "decimal_u64")]
    pub wall_us: u64,
    #[serde(with = "decimal_u64_option")]
    pub peak_working_set_bytes: Option<u64>,
    #[serde(with = "decimal_u64")]
    pub stdout_bytes: u64,
    #[serde(with = "decimal_u64")]
    pub stderr_bytes: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RawSensorUnpackEvidence {
    NotAttempted {
        reason: String,
    },
    Unsupported {
        reason: String,
    },
    Succeeded {
        #[serde(with = "decimal_u64")]
        sample_count: u64,
        sample_digest_sha256: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawExpectationCheck {
    pub field: String,
    pub expected: String,
    pub actual: Option<String>,
    pub passed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RawEvidenceOutcome {
    ProbeSucceeded {
        report: Box<RawProbeReport>,
        sensor_unpack: RawSensorUnpackEvidence,
    },
    IntegrityMismatch {
        expected_sha256: String,
        actual_sha256: String,
    },
    UnsupportedFamily {
        reason: String,
    },
    ProbeFailed {
        error: RawProbeError,
    },
    InputFailed {
        message: String,
    },
    ChildProcessFailed {
        exit_code: Option<i32>,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawEvidenceCaseRecord {
    pub case_id: String,
    pub family: RawCorpusFamily,
    pub variant: String,
    pub relative_path: String,
    pub expected_sha256: String,
    pub provenance: RawCorpusProvenance,
    pub expected: RawProbeExpectation,
    pub observed_sha256: Option<String>,
    pub metrics: Option<RawEvidenceMetrics>,
    pub child_process: Option<RawChildProcessMetrics>,
    pub expectation_checks: Vec<RawExpectationCheck>,
    pub outcome: RawEvidenceOutcome,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawEvidenceBundle {
    pub schema_version: u32,
    pub manifest_schema_version: u32,
    pub manifest_sha256: String,
    pub corpus_id: String,
    #[serde(with = "decimal_u64")]
    pub generated_unix_seconds: u64,
    pub coverage: RawCorpusCoverage,
    pub runner: RawRunnerIdentity,
    pub summary: RawEvidenceSummary,
    pub cases: Vec<RawEvidenceCaseRecord>,
}

pub(crate) mod decimal_u64 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}

pub(crate) mod decimal_u64_option {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(value) => serializer.serialize_some(&value.to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<String>::deserialize(deserializer)?
            .map(|value| value.parse().map_err(serde::de::Error::custom))
            .transpose()
    }
}
