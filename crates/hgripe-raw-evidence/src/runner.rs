use crate::manifest::is_safe_windows_relative_path;
use crate::windows_support::{
    final_path_for_file, move_file_without_replacing, path_is_within, peak_child_working_set_bytes,
    peak_current_working_set_bytes, ChildJob,
};
use crate::{
    load_manifest_snapshot, validate_manifest, RawChildProcessMetrics, RawCorpusCase,
    RawCorpusFamily, RawCorpusManifest, RawEvidenceBundle, RawEvidenceCaseRecord,
    RawEvidenceMetrics, RawEvidenceOutcome, RawEvidenceSummary, RawExpectationCheck,
    RawManifestValidation, RawRunnerIdentity, RawSensorUnpackEvidence, RAW_EVIDENCE_SCHEMA_VERSION,
};
use hgripe_raw::{probe_dng, RawContainer, RawProbeReport};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MAX_CORPUS_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const CHILD_TIMEOUT_MS: u64 = 120_000;
pub const CHILD_MEMORY_LIMIT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const CHILD_PROCESS_LIMIT: u32 = 1;
pub const CHILD_OUTPUT_LIMIT_BYTES: u64 = 4 * 1024 * 1024;
const CHILD_COMMAND: &str = "__probe-owned-case";
const CHILD_HANDSHAKE_ENV: &str = "HG_R0_CHILD_HANDSHAKE";

#[derive(Debug)]
pub enum EvidenceRunError {
    Manifest(String),
    InvalidManifest(RawManifestValidation),
    Environment(String),
    Io(String),
    Json(String),
}

impl fmt::Display for EvidenceRunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Manifest(message) => write!(formatter, "cannot load corpus manifest: {message}"),
            Self::InvalidManifest(validation) => {
                let errors = validation
                    .issues
                    .iter()
                    .filter(|issue| issue.severity == crate::RawManifestIssueSeverity::Error)
                    .count();
                write!(formatter, "corpus manifest has {errors} validation errors")
            }
            Self::Environment(message) => {
                write!(formatter, "invalid evidence environment: {message}")
            }
            Self::Io(message) => write!(formatter, "evidence I/O failed: {message}"),
            Self::Json(message) => write!(formatter, "evidence JSON failed: {message}"),
        }
    }
}

impl std::error::Error for EvidenceRunError {}

pub fn resolve_case_path(
    corpus_root: &Path,
    relative_path: &str,
) -> Result<PathBuf, EvidenceRunError> {
    let (_, resolved) = open_case_file(corpus_root, relative_path)?;
    Ok(resolved)
}

pub fn build_runner_identity() -> Result<RawRunnerIdentity, EvidenceRunError> {
    let executable = std::env::current_exe()
        .map_err(|error| EvidenceRunError::Environment(error.to_string()))?;
    let metadata = executable.metadata().map_err(|error| {
        EvidenceRunError::Io(format!("cannot inspect runner executable: {error}"))
    })?;
    let executable_sha256 = sha256_file(&executable)?;
    let executable_name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| EvidenceRunError::Environment("runner executable name is not UTF-8".into()))?
        .to_string();
    let build_revision = env!("HG_R0_BUILD_REVISION").to_string();
    let build_dirty = match env!("HG_R0_BUILD_DIRTY") {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    };
    let source_root = find_workspace_root(&executable);
    let runtime_revision = source_root
        .as_deref()
        .and_then(|root| git_output(root, &["rev-parse", "HEAD"]));
    let runtime_dirty = source_root
        .as_deref()
        .and_then(|root| git_output(root, &["status", "--porcelain"]))
        .map(|output| !output.trim().is_empty());
    let source_dirty = match (build_dirty, runtime_revision, runtime_dirty) {
        (Some(build_dirty), Some(runtime_revision), Some(runtime_dirty))
            if runtime_revision == build_revision =>
        {
            Some(build_dirty || runtime_dirty)
        }
        _ => None,
    };
    Ok(RawRunnerIdentity {
        id: "owned_dng_metadata_probe".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        source_revision: build_revision,
        source_dirty,
        source_license: "GPL-3.0-only".into(),
        platform: "windows-x86_64".into(),
        build_profile: env!("HG_R0_BUILD_PROFILE").into(),
        executable_name,
        executable_sha256,
        executable_bytes: metadata.len(),
        bundled_runtime_payload_bytes: 0,
        case_timeout_ms: CHILD_TIMEOUT_MS,
        case_memory_limit_bytes: CHILD_MEMORY_LIMIT_BYTES,
        case_process_limit: CHILD_PROCESS_LIMIT,
        child_output_limit_bytes: CHILD_OUTPUT_LIMIT_BYTES,
        supported_families: vec![
            RawCorpusFamily::DngUncompressedBayer,
            RawCorpusFamily::DngLosslessCompressedBayer,
        ],
    })
}

pub fn probe_owned_case(case: &RawCorpusCase, corpus_root: &Path) -> RawEvidenceCaseRecord {
    let total_started = Instant::now();
    let (file, _) = match open_case_file(corpus_root, &case.relative_path) {
        Ok(opened) => opened,
        Err(error) => return failed_input_record(case, error.to_string()),
    };
    let read_started = Instant::now();
    let bytes = match read_bounded(file) {
        Ok(bytes) => bytes,
        Err(error) => return failed_input_record(case, error.to_string()),
    };
    let actual_sha256 = sha256_hex(&bytes);
    let read_and_hash_us = elapsed_us(read_started);

    if actual_sha256 != case.sha256 {
        return completed_record(
            case,
            &bytes,
            actual_sha256.clone(),
            read_and_hash_us,
            None,
            total_started,
            Vec::new(),
            RawEvidenceOutcome::IntegrityMismatch {
                expected_sha256: case.sha256.clone(),
                actual_sha256,
            },
        );
    }

    if !case.family.supported_by_owned_probe() {
        return completed_record(
            case,
            &bytes,
            actual_sha256,
            read_and_hash_us,
            None,
            total_started,
            Vec::new(),
            RawEvidenceOutcome::UnsupportedFamily {
                reason: "the owned R0-A runner implements DNG metadata probing only".into(),
            },
        );
    }

    let probe_started = Instant::now();
    let probe_result = probe_dng(&bytes);
    let metadata_probe_us = elapsed_us(probe_started);
    match probe_result {
        Ok(report) => {
            let sensor_unpack = RawSensorUnpackEvidence::NotAttempted {
                reason: "R0-A owned probe validates metadata and byte ranges only".into(),
            };
            let checks = expectation_checks(case, &report, &sensor_unpack);
            let failed_checks = checks.iter().filter(|check| !check.passed).count();
            let diagnostics = if failed_checks == 0 {
                Vec::new()
            } else {
                vec![format!(
                    "{failed_checks} manifest expectations did not match"
                )]
            };
            completed_record(
                case,
                &bytes,
                actual_sha256,
                read_and_hash_us,
                Some(metadata_probe_us),
                total_started,
                checks,
                RawEvidenceOutcome::ProbeSucceeded {
                    report: Box::new(report),
                    sensor_unpack,
                },
            )
            .with_diagnostics(diagnostics)
        }
        Err(error) => completed_record(
            case,
            &bytes,
            actual_sha256,
            read_and_hash_us,
            Some(metadata_probe_us),
            total_started,
            Vec::new(),
            RawEvidenceOutcome::ProbeFailed { error },
        ),
    }
}

pub fn collect_owned_evidence(
    manifest_path: &Path,
    corpus_root: &Path,
) -> Result<RawEvidenceBundle, EvidenceRunError> {
    let manifest_path = manifest_path
        .canonicalize()
        .map_err(|error| EvidenceRunError::Io(format!("cannot resolve manifest path: {error}")))?;
    let snapshot = load_manifest_snapshot(&manifest_path)
        .map_err(|error| EvidenceRunError::Manifest(error.to_string()))?;
    let manifest_sha256 = snapshot.sha256;
    let manifest = snapshot.manifest;
    let validation = validate_manifest(&manifest);
    if !validation.valid {
        return Err(EvidenceRunError::InvalidManifest(validation));
    }
    let corpus_root = corpus_root
        .canonicalize()
        .map_err(|error| EvidenceRunError::Io(format!("cannot resolve corpus root: {error}")))?;
    let executable = std::env::current_exe()
        .map_err(|error| EvidenceRunError::Environment(error.to_string()))?;
    let runner = build_runner_identity()?;

    let mut records = Vec::with_capacity(manifest.cases.len());
    for case in &manifest.cases {
        let mut command = Command::new(&executable);
        command
            .arg(CHILD_COMMAND)
            .arg(&manifest_path)
            .arg(&corpus_root)
            .arg(&case.id)
            .arg(&manifest_sha256)
            .env(CHILD_HANDSHAKE_ENV, "1");
        let output = run_bounded_child(
            &mut command,
            Duration::from_millis(CHILD_TIMEOUT_MS),
            CHILD_MEMORY_LIMIT_BYTES,
            CHILD_OUTPUT_LIMIT_BYTES,
            true,
        )?;
        let process_metrics = output.metrics.clone();
        let record = if output.metrics.timed_out {
            child_failure_record(
                case,
                output.status.code(),
                "case child exceeded the time limit",
            )
        } else if output.stdout.truncated || output.stderr.truncated {
            child_failure_record(
                case,
                output.status.code(),
                "case child exceeded the stdout/stderr evidence limit",
            )
        } else if output.status.success() {
            match serde_json::from_slice::<RawEvidenceCaseRecord>(&output.stdout.bytes) {
                Ok(record) => match validate_child_record(case, &record) {
                    Ok(()) => record,
                    Err(message) => child_failure_record(case, output.status.code(), &message),
                },
                Err(error) => child_failure_record(
                    case,
                    output.status.code(),
                    &format!("case child returned invalid JSON: {error}"),
                ),
            }
        } else {
            let message = String::from_utf8_lossy(&output.stderr.bytes)
                .trim()
                .to_string();
            child_failure_record(
                case,
                output.status.code(),
                if message.is_empty() {
                    "case child exited without an error message"
                } else {
                    &message
                },
            )
        };
        records.push(record.with_child_process(process_metrics));
        verify_manifest_snapshot(&manifest_path, &manifest_sha256)?;
    }

    verify_manifest_snapshot(&manifest_path, &manifest_sha256)?;

    let generated_unix_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| EvidenceRunError::Environment(error.to_string()))?
        .as_secs();
    let summary = summarize_evidence(&validation.coverage, &runner, &records);
    Ok(RawEvidenceBundle {
        schema_version: RAW_EVIDENCE_SCHEMA_VERSION,
        manifest_schema_version: manifest.schema_version,
        manifest_sha256,
        corpus_id: manifest.corpus_id,
        generated_unix_seconds,
        coverage: validation.coverage,
        runner,
        summary,
        cases: records,
    })
}

#[derive(Debug)]
struct CapturedOutput {
    bytes: Vec<u8>,
    total_bytes: u64,
    truncated: bool,
}

#[derive(Debug)]
struct ChildExecution {
    status: ExitStatus,
    stdout: CapturedOutput,
    stderr: CapturedOutput,
    metrics: RawChildProcessMetrics,
}

fn run_bounded_child(
    command: &mut Command,
    timeout: Duration,
    memory_limit_bytes: u64,
    output_limit_bytes: u64,
    handshake: bool,
) -> Result<ChildExecution, EvidenceRunError> {
    command
        .stdin(if handshake {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let job = ChildJob::new(memory_limit_bytes).map_err(|error| {
        EvidenceRunError::Environment(format!("cannot create child job: {error}"))
    })?;
    let started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|error| EvidenceRunError::Io(format!("cannot start case child: {error}")))?;
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(EvidenceRunError::Environment(format!(
            "cannot assign case child to the evidence job: {error}"
        )));
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| EvidenceRunError::Environment("case child stdout was not piped".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| EvidenceRunError::Environment("case child stderr was not piped".into()))?;
    let stdout_reader = thread::spawn(move || capture_output(stdout, output_limit_bytes));
    let stderr_reader = thread::spawn(move || capture_output(stderr, output_limit_bytes));
    if handshake {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            EvidenceRunError::Environment("case child stdin was not piped".into())
        })?;
        stdin
            .write_all(b"R0")
            .map_err(|error| EvidenceRunError::Io(format!("cannot release case child: {error}")))?;
    }

    let mut peak_working_set_bytes = None;
    let mut timed_out = false;
    let mut job = Some(job);
    let status = loop {
        if let Ok(value) = peak_child_working_set_bytes(&child) {
            peak_working_set_bytes =
                Some(peak_working_set_bytes.map_or(value, |peak: u64| peak.max(value)));
        }
        match child
            .try_wait()
            .map_err(|error| EvidenceRunError::Io(format!("cannot poll case child: {error}")))?
        {
            Some(status) => break status,
            None if started.elapsed() >= timeout => {
                timed_out = true;
                drop(job.take());
                let _ = child.kill();
                break child.wait().map_err(|error| {
                    EvidenceRunError::Io(format!("cannot reap timed-out case child: {error}"))
                })?;
            }
            None => thread::sleep(Duration::from_millis(10)),
        }
    };
    if let Ok(value) = peak_child_working_set_bytes(&child) {
        peak_working_set_bytes = Some(peak_working_set_bytes.map_or(value, |peak| peak.max(value)));
    }
    drop(job.take());

    let stdout = stdout_reader
        .join()
        .map_err(|_| EvidenceRunError::Environment("case child stdout reader panicked".into()))?
        .map_err(|error| EvidenceRunError::Io(format!("cannot read case child stdout: {error}")))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| EvidenceRunError::Environment("case child stderr reader panicked".into()))?
        .map_err(|error| EvidenceRunError::Io(format!("cannot read case child stderr: {error}")))?;
    let metrics = RawChildProcessMetrics {
        wall_us: elapsed_us(started),
        peak_working_set_bytes,
        stdout_bytes: stdout.total_bytes,
        stderr_bytes: stderr.total_bytes,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        timed_out,
    };
    Ok(ChildExecution {
        status,
        stdout,
        stderr,
        metrics,
    })
}

fn capture_output(mut reader: impl Read, limit_bytes: u64) -> std::io::Result<CapturedOutput> {
    let mut bytes = Vec::with_capacity(usize::try_from(limit_bytes.min(64 * 1024)).unwrap_or(0));
    let mut total_bytes = 0_u64;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
        let remaining = limit_bytes.saturating_sub(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
        let retain = read.min(usize::try_from(remaining).unwrap_or(usize::MAX));
        bytes.extend_from_slice(&buffer[..retain]);
    }
    Ok(CapturedOutput {
        bytes,
        total_bytes,
        truncated: total_bytes > limit_bytes,
    })
}

fn verify_manifest_snapshot(path: &Path, expected_sha256: &str) -> Result<(), EvidenceRunError> {
    let snapshot = load_manifest_snapshot(path)
        .map_err(|error| EvidenceRunError::Manifest(error.to_string()))?;
    if snapshot.sha256 != expected_sha256 {
        return Err(EvidenceRunError::Io(
            "corpus manifest changed during evidence collection".into(),
        ));
    }
    Ok(())
}

fn validate_child_record(
    case: &RawCorpusCase,
    record: &RawEvidenceCaseRecord,
) -> Result<(), String> {
    if record.case_id != case.id
        || record.family != case.family
        || record.variant != case.variant
        || record.relative_path != case.relative_path
        || record.expected_sha256 != case.sha256
        || record.provenance != case.provenance
        || record.expected != case.expected
        || record.child_process.is_some()
    {
        return Err("case child returned identity fields that do not match the manifest".into());
    }

    match &record.outcome {
        RawEvidenceOutcome::ProbeSucceeded {
            report,
            sensor_unpack,
        } => {
            if record.observed_sha256.as_deref() != Some(case.sha256.as_str()) {
                return Err(
                    "case child returned a successful probe with the wrong file hash".into(),
                );
            }
            let expected_checks = expectation_checks(case, report, sensor_unpack);
            if record.expectation_checks != expected_checks {
                return Err(
                    "case child returned expectation checks that do not match the report".into(),
                );
            }
        }
        RawEvidenceOutcome::IntegrityMismatch {
            expected_sha256,
            actual_sha256,
        } => {
            if expected_sha256 != &case.sha256
                || record.observed_sha256.as_deref() != Some(actual_sha256.as_str())
                || !record.expectation_checks.is_empty()
            {
                return Err("case child returned inconsistent integrity evidence".into());
            }
        }
        RawEvidenceOutcome::UnsupportedFamily { .. } | RawEvidenceOutcome::ProbeFailed { .. } => {
            if record.observed_sha256.as_deref() != Some(case.sha256.as_str())
                || !record.expectation_checks.is_empty()
            {
                return Err("case child returned inconsistent probe failure evidence".into());
            }
        }
        RawEvidenceOutcome::InputFailed { .. } => {
            if record.observed_sha256.is_some()
                || record.metrics.is_some()
                || !record.expectation_checks.is_empty()
            {
                return Err("case child returned inconsistent input failure evidence".into());
            }
        }
        RawEvidenceOutcome::ChildProcessFailed { .. } => {
            return Err("case child cannot author a parent process failure record".into());
        }
    }
    Ok(())
}

fn child_failure_record(
    case: &RawCorpusCase,
    exit_code: Option<i32>,
    message: &str,
) -> RawEvidenceCaseRecord {
    RawEvidenceCaseRecord {
        case_id: case.id.clone(),
        family: case.family,
        variant: case.variant.clone(),
        relative_path: case.relative_path.clone(),
        expected_sha256: case.sha256.clone(),
        provenance: case.provenance.clone(),
        expected: case.expected.clone(),
        observed_sha256: None,
        metrics: None,
        child_process: None,
        expectation_checks: Vec::new(),
        outcome: RawEvidenceOutcome::ChildProcessFailed {
            exit_code,
            message: message.into(),
        },
        diagnostics: Vec::new(),
    }
}

fn summarize_evidence(
    coverage: &crate::RawCorpusCoverage,
    runner: &RawRunnerIdentity,
    records: &[RawEvidenceCaseRecord],
) -> RawEvidenceSummary {
    let runner_eligible = runner.build_profile == "release"
        && runner.source_dirty == Some(false)
        && runner.platform == "windows-x86_64"
        && is_lower_hex_digest(&runner.source_revision, 40)
        && is_lower_hex_digest(&runner.executable_sha256, 64)
        && runner.executable_bytes > 0
        && runner.case_timeout_ms > 0
        && runner.case_memory_limit_bytes >= MAX_CORPUS_FILE_BYTES
        && runner.case_process_limit == CHILD_PROCESS_LIMIT
        && runner.child_output_limit_bytes > 0;
    let mut summary = RawEvidenceSummary {
        total_cases: u32::try_from(records.len()).unwrap_or(u32::MAX),
        metadata_probe_succeeded: 0,
        sensor_unpack_succeeded: 0,
        unsupported_cases: 0,
        integrity_mismatches: 0,
        failed_cases: 0,
        failed_expectation_checks: 0,
        runner_eligible,
        gate_ready: false,
    };
    for record in records {
        summary.failed_expectation_checks = summary.failed_expectation_checks.saturating_add(
            u32::try_from(
                record
                    .expectation_checks
                    .iter()
                    .filter(|check| !check.passed)
                    .count(),
            )
            .unwrap_or(u32::MAX),
        );
        match &record.outcome {
            RawEvidenceOutcome::ProbeSucceeded {
                report,
                sensor_unpack,
            } => {
                summary.metadata_probe_succeeded =
                    summary.metadata_probe_succeeded.saturating_add(1);
                if sensor_unpack_is_complete(sensor_unpack, report, &record.expected) {
                    summary.sensor_unpack_succeeded =
                        summary.sensor_unpack_succeeded.saturating_add(1);
                }
            }
            RawEvidenceOutcome::UnsupportedFamily { .. } => {
                summary.unsupported_cases = summary.unsupported_cases.saturating_add(1);
            }
            RawEvidenceOutcome::IntegrityMismatch { .. } => {
                summary.integrity_mismatches = summary.integrity_mismatches.saturating_add(1);
            }
            RawEvidenceOutcome::ProbeFailed { .. }
            | RawEvidenceOutcome::InputFailed { .. }
            | RawEvidenceOutcome::ChildProcessFailed { .. } => {
                summary.failed_cases = summary.failed_cases.saturating_add(1);
            }
        }
    }
    summary.gate_ready = summary.runner_eligible
        && coverage.complete
        && summary.total_cases > 0
        && summary.metadata_probe_succeeded == summary.total_cases
        && summary.sensor_unpack_succeeded == summary.total_cases
        && summary.failed_expectation_checks == 0
        && runner_supports_required_families(runner)
        && records_cover_required_families(records)
        && records
            .iter()
            .all(|record| record_respects_runner_limits(record, runner))
        && records.iter().all(record_is_gate_complete);
    summary
}

fn sensor_unpack_is_complete(
    evidence: &RawSensorUnpackEvidence,
    report: &RawProbeReport,
    expected: &crate::RawProbeExpectation,
) -> bool {
    let expected_samples = u64::from(report.dimensions.width)
        .checked_mul(u64::from(report.dimensions.height))
        .and_then(|pixels| pixels.checked_mul(u64::from(report.samples_per_pixel)));
    matches!(
        (
            evidence,
            expected_samples,
            expected.sensor_sample_count,
            expected.sensor_sample_digest_sha256.as_deref(),
            expected.sensor_reference.as_deref(),
        ),
        (
            RawSensorUnpackEvidence::Succeeded {
                sample_count,
                sample_digest_sha256,
            },
            Some(expected_samples),
            Some(trusted_count),
            Some(trusted_digest),
            Some(trusted_reference),
        ) if expected_samples > 0
            && *sample_count == expected_samples
            && *sample_count == trusted_count
            && sample_digest_sha256 == trusted_digest
            && !trusted_reference.trim().is_empty()
            && is_lower_hex_digest(sample_digest_sha256, 64)
    )
}

fn record_is_gate_complete(record: &RawEvidenceCaseRecord) -> bool {
    let Some(metrics) = &record.metrics else {
        return false;
    };
    let Some(child_process) = &record.child_process else {
        return false;
    };
    let RawEvidenceOutcome::ProbeSucceeded {
        report,
        sensor_unpack,
    } = &record.outcome
    else {
        return false;
    };
    record.observed_sha256.as_deref() == Some(record.expected_sha256.as_str())
        && !record.expectation_checks.is_empty()
        && record.expectation_checks.iter().all(|check| check.passed)
        && metrics.metadata_probe_us.is_some()
        && metrics.sensor_unpack_us.is_some()
        && metrics.peak_working_set_bytes.is_some()
        && child_process.peak_working_set_bytes.is_some()
        && !child_process.stdout_truncated
        && !child_process.stderr_truncated
        && !child_process.timed_out
        && report_matches_family(record.family, report)
        && sensor_unpack_is_complete(sensor_unpack, report, &record.expected)
}

fn runner_supports_required_families(runner: &RawRunnerIdentity) -> bool {
    RawCorpusFamily::REQUIRED
        .into_iter()
        .all(|family| runner.supported_families.contains(&family))
}

fn record_respects_runner_limits(
    record: &RawEvidenceCaseRecord,
    runner: &RawRunnerIdentity,
) -> bool {
    record.child_process.as_ref().is_some_and(|metrics| {
        metrics.wall_us <= runner.case_timeout_ms.saturating_mul(1000)
            && metrics.stdout_bytes <= runner.child_output_limit_bytes
            && metrics.stderr_bytes <= runner.child_output_limit_bytes
            && metrics
                .peak_working_set_bytes
                .is_some_and(|peak| peak <= runner.case_memory_limit_bytes)
    })
}

fn records_cover_required_families(records: &[RawEvidenceCaseRecord]) -> bool {
    let ids = records
        .iter()
        .map(|record| record.case_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    ids.len() == records.len()
        && RawCorpusFamily::REQUIRED
            .into_iter()
            .all(|family| records.iter().any(|record| record.family == family))
}

fn report_matches_family(family: RawCorpusFamily, report: &RawProbeReport) -> bool {
    if report.container != family.expected_container() {
        return false;
    }
    match family {
        RawCorpusFamily::DngUncompressedBayer => {
            report.compression.code == 1 && report_has_cfa_repeat(report, 2, 2)
        }
        RawCorpusFamily::DngLosslessCompressedBayer => {
            matches!(report.compression.code, 7 | 8) && report_has_cfa_repeat(report, 2, 2)
        }
        RawCorpusFamily::CanonCr3 => {
            report.compression.description.as_deref() == Some("canon_cr3_raw")
                && report.cfa.is_some()
        }
        RawCorpusFamily::CanonCr3Craw => {
            report.compression.description.as_deref() == Some("canon_cr3_c_raw")
                && report.cfa.is_some()
        }
        RawCorpusFamily::FujifilmRafXTrans => report_has_cfa_repeat(report, 6, 6),
        _ => report.cfa.is_some(),
    }
}

fn report_has_cfa_repeat(report: &RawProbeReport, rows: u32, columns: u32) -> bool {
    report
        .cfa
        .as_ref()
        .is_some_and(|cfa| cfa.repeat.rows == rows && cfa.repeat.columns == columns)
}

pub fn write_evidence_bundle(
    output_path: &Path,
    bundle: &RawEvidenceBundle,
) -> Result<(), EvidenceRunError> {
    let parent = output_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err(EvidenceRunError::Io(
            "evidence output parent directory does not exist".into(),
        ));
    }
    let parent = parent
        .canonicalize()
        .map_err(|error| EvidenceRunError::Io(format!("cannot resolve output parent: {error}")))?;
    let file_name = output_path
        .file_name()
        .ok_or_else(|| EvidenceRunError::Io("evidence output has no file name".into()))?;
    let destination = parent.join(file_name);
    if destination.exists() {
        return Err(EvidenceRunError::Io(
            "evidence output already exists; refusing to overwrite it".into(),
        ));
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| EvidenceRunError::Environment(error.to_string()))?
        .as_nanos();
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        file_name.to_string_lossy(),
        std::process::id(),
        nonce
    ));
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| EvidenceRunError::Io(error.to_string()))?;
        serde_json::to_writer_pretty(&mut file, bundle)
            .map_err(|error| EvidenceRunError::Json(error.to_string()))?;
        file.write_all(b"\n")
            .map_err(|error| EvidenceRunError::Io(error.to_string()))?;
        file.sync_all()
            .map_err(|error| EvidenceRunError::Io(error.to_string()))?;
        move_file_without_replacing(&temporary, &destination).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                EvidenceRunError::Io(
                    "evidence output already exists; refusing to overwrite it".into(),
                )
            } else {
                EvidenceRunError::Io(format!("cannot publish evidence output: {error}"))
            }
        })
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

pub fn child_command_name() -> &'static str {
    CHILD_COMMAND
}

fn open_case_file(
    corpus_root: &Path,
    relative_path: &str,
) -> Result<(File, PathBuf), EvidenceRunError> {
    if !is_safe_windows_relative_path(relative_path) {
        return Err(EvidenceRunError::Environment(
            "case relative_path is not safe under Windows path rules".into(),
        ));
    }
    let root = corpus_root
        .canonicalize()
        .map_err(|error| EvidenceRunError::Io(format!("cannot resolve corpus root: {error}")))?;
    let candidate = root.join(relative_path);
    let file = File::open(&candidate)
        .map_err(|error| EvidenceRunError::Io(format!("cannot open case file: {error}")))?;
    if !file
        .metadata()
        .map_err(|error| EvidenceRunError::Io(format!("cannot inspect case file: {error}")))?
        .is_file()
    {
        return Err(EvidenceRunError::Environment(
            "case path does not resolve to a regular file".into(),
        ));
    }
    let resolved = final_path_for_file(&file)
        .map_err(|error| EvidenceRunError::Io(format!("cannot resolve open case file: {error}")))?;
    if !path_is_within(&root, &resolved) {
        return Err(EvidenceRunError::Environment(
            "open case file resolves outside the corpus root".into(),
        ));
    }
    Ok((file, resolved))
}

fn read_bounded(file: File) -> Result<Vec<u8>, EvidenceRunError> {
    let declared_length = file
        .metadata()
        .map_err(|error| EvidenceRunError::Io(format!("cannot inspect case file: {error}")))?
        .len();
    if declared_length > MAX_CORPUS_FILE_BYTES {
        return Err(EvidenceRunError::Io(format!(
            "case file is {declared_length} bytes; limit is {MAX_CORPUS_FILE_BYTES}"
        )));
    }
    let capacity = usize::try_from(declared_length.min(64 * 1024 * 1024)).unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    file.take(MAX_CORPUS_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| EvidenceRunError::Io(format!("cannot read case file: {error}")))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_CORPUS_FILE_BYTES {
        return Err(EvidenceRunError::Io(format!(
            "case file exceeds {MAX_CORPUS_FILE_BYTES} bytes"
        )));
    }
    Ok(bytes)
}

fn find_workspace_root(executable: &Path) -> Option<PathBuf> {
    executable.ancestors().skip(1).find_map(|ancestor| {
        (ancestor.join(".git").exists() && ancestor.join("Cargo.toml").is_file())
            .then(|| ancestor.to_path_buf())
    })
}

fn git_output(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn sha256_file(path: &Path) -> Result<String, EvidenceRunError> {
    let mut file = File::open(path)
        .map_err(|error| EvidenceRunError::Io(format!("cannot open file for hashing: {error}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| EvidenceRunError::Io(format!("cannot hash file: {error}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn is_lower_hex_digest(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn failed_input_record(case: &RawCorpusCase, message: String) -> RawEvidenceCaseRecord {
    RawEvidenceCaseRecord {
        case_id: case.id.clone(),
        family: case.family,
        variant: case.variant.clone(),
        relative_path: case.relative_path.clone(),
        expected_sha256: case.sha256.clone(),
        provenance: case.provenance.clone(),
        expected: case.expected.clone(),
        observed_sha256: None,
        metrics: None,
        child_process: None,
        expectation_checks: Vec::new(),
        outcome: RawEvidenceOutcome::InputFailed { message },
        diagnostics: Vec::new(),
    }
}

#[allow(clippy::too_many_arguments)]
fn completed_record(
    case: &RawCorpusCase,
    bytes: &[u8],
    observed_sha256: String,
    read_and_hash_us: u64,
    metadata_probe_us: Option<u64>,
    total_started: Instant,
    expectation_checks: Vec<RawExpectationCheck>,
    outcome: RawEvidenceOutcome,
) -> RawEvidenceCaseRecord {
    let (peak_working_set_bytes, mut diagnostics) = match peak_current_working_set_bytes() {
        Ok(value) => (Some(value), Vec::new()),
        Err(error) => (None, vec![format!("cannot read peak working set: {error}")]),
    };
    let total_us = elapsed_us(total_started);
    if peak_working_set_bytes.is_none() {
        diagnostics.push("peak memory evidence is incomplete".into());
    }
    RawEvidenceCaseRecord {
        case_id: case.id.clone(),
        family: case.family,
        variant: case.variant.clone(),
        relative_path: case.relative_path.clone(),
        expected_sha256: case.sha256.clone(),
        provenance: case.provenance.clone(),
        expected: case.expected.clone(),
        observed_sha256: Some(observed_sha256),
        metrics: Some(RawEvidenceMetrics {
            input_bytes: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            read_and_hash_us,
            metadata_probe_us,
            sensor_unpack_us: None,
            total_us,
            peak_working_set_bytes,
        }),
        child_process: None,
        expectation_checks,
        outcome,
        diagnostics,
    }
}

trait WithDiagnostics {
    fn with_diagnostics(self, diagnostics: Vec<String>) -> Self;

    fn with_child_process(self, metrics: RawChildProcessMetrics) -> Self;
}

impl WithDiagnostics for RawEvidenceCaseRecord {
    fn with_diagnostics(mut self, diagnostics: Vec<String>) -> Self {
        self.diagnostics.extend(diagnostics);
        self
    }

    fn with_child_process(mut self, metrics: RawChildProcessMetrics) -> Self {
        self.child_process = Some(metrics);
        self
    }
}

fn expectation_checks(
    case: &RawCorpusCase,
    report: &RawProbeReport,
    sensor_unpack: &RawSensorUnpackEvidence,
) -> Vec<RawExpectationCheck> {
    let mut checks = Vec::new();
    push_check(
        &mut checks,
        "container",
        container_name(case.family.expected_container()),
        Some(container_name(report.container.clone())),
    );
    push_check(
        &mut checks,
        "cfa_present",
        "true".into(),
        Some(report.cfa.is_some().to_string()),
    );
    match case.family {
        RawCorpusFamily::DngUncompressedBayer => push_check(
            &mut checks,
            "compression_code",
            "1".into(),
            Some(report.compression.code.to_string()),
        ),
        RawCorpusFamily::DngLosslessCompressedBayer => checks.push(RawExpectationCheck {
            field: "lossless_compression_code".into(),
            expected: "7_or_8".into(),
            actual: Some(report.compression.code.to_string()),
            passed: matches!(report.compression.code, 7 | 8),
        }),
        _ => {}
    }
    match case.family {
        RawCorpusFamily::DngUncompressedBayer | RawCorpusFamily::DngLosslessCompressedBayer => {
            let actual = report
                .cfa
                .as_ref()
                .map(|cfa| dimensions_string(cfa.repeat.columns, cfa.repeat.rows));
            push_check(&mut checks, "bayer_cfa_repeat", "2x2".into(), actual);
        }
        RawCorpusFamily::FujifilmRafXTrans => {
            let actual = report
                .cfa
                .as_ref()
                .map(|cfa| dimensions_string(cfa.repeat.columns, cfa.repeat.rows));
            push_check(&mut checks, "xtrans_cfa_repeat", "6x6".into(), actual);
        }
        _ => {}
    }
    if let Some(expected) = &case.expected.make {
        push_check(
            &mut checks,
            "make",
            expected.clone(),
            report.camera.make.clone(),
        );
    }
    if let Some(expected) = &case.expected.model {
        push_check(
            &mut checks,
            "model",
            expected.clone(),
            report.camera.model.clone(),
        );
    }
    if let Some(expected) = case.expected.dimensions {
        push_check(
            &mut checks,
            "dimensions",
            dimensions_string(expected.width, expected.height),
            Some(dimensions_string(
                report.dimensions.width,
                report.dimensions.height,
            )),
        );
    }
    if let Some(expected) = case.expected.compression_code {
        push_check(
            &mut checks,
            "manifest_compression_code",
            expected.to_string(),
            Some(report.compression.code.to_string()),
        );
    }
    if let Some(expected) = &case.expected.compression_description {
        push_check(
            &mut checks,
            "compression_description",
            expected.clone(),
            report.compression.description.clone(),
        );
    }
    if let (Some(rows), Some(columns)) = (
        case.expected.cfa_repeat_rows,
        case.expected.cfa_repeat_columns,
    ) {
        let actual = report
            .cfa
            .as_ref()
            .map(|cfa| dimensions_string(cfa.repeat.columns, cfa.repeat.rows));
        push_check(
            &mut checks,
            "cfa_repeat",
            dimensions_string(columns, rows),
            actual,
        );
    }
    if let Some(expected) = case.expected.sensor_sample_count {
        let actual = match sensor_unpack {
            RawSensorUnpackEvidence::Succeeded { sample_count, .. } => {
                Some(sample_count.to_string())
            }
            _ => None,
        };
        push_check(
            &mut checks,
            "sensor_sample_count",
            expected.to_string(),
            actual,
        );
    }
    if let Some(expected) = &case.expected.sensor_sample_digest_sha256 {
        let actual = match sensor_unpack {
            RawSensorUnpackEvidence::Succeeded {
                sample_digest_sha256,
                ..
            } => Some(sample_digest_sha256.clone()),
            _ => None,
        };
        push_check(
            &mut checks,
            "sensor_sample_digest_sha256",
            expected.clone(),
            actual,
        );
    }
    checks
}

fn push_check(
    checks: &mut Vec<RawExpectationCheck>,
    field: &str,
    expected: String,
    actual: Option<String>,
) {
    let passed = actual.as_deref() == Some(expected.as_str());
    checks.push(RawExpectationCheck {
        field: field.into(),
        expected,
        actual,
        passed,
    });
}

fn container_name(container: RawContainer) -> String {
    serde_json::to_value(container)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".into())
}

fn dimensions_string(width: u32, height: u32) -> String {
    format!("{width}x{height}")
}

fn elapsed_us(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

pub fn find_case<'a>(manifest: &'a RawCorpusManifest, case_id: &str) -> Option<&'a RawCorpusCase> {
    manifest.cases.iter().find(|case| case.id == case_id)
}

#[cfg(test)]
#[path = "../../hgripe-raw/tests/support/dng_fixture.rs"]
mod runner_test_dng_fixture;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        RawChildProcessMetrics, RawCorpusCoverage, RawCorpusOrigin, RawCorpusProvenance,
        RawProbeExpectation, RawRedistributionPolicy,
    };
    use hgripe_raw::RawGridSize;
    use runner_test_dng_fixture::{minimal_dng, ByteOrder};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn bounded_child_times_out_and_caps_output() {
        let mut sleeper = Command::new("powershell");
        sleeper.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 5",
        ]);
        let timed_out = run_bounded_child(
            &mut sleeper,
            Duration::from_millis(150),
            1024 * 1024 * 1024,
            1024,
            false,
        )
        .unwrap();
        assert!(timed_out.metrics.timed_out);
        assert!(timed_out.metrics.wall_us < 5_000_000);

        let mut noisy = Command::new("powershell");
        noisy.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.Write(('x' * 4096))",
        ]);
        let capped = run_bounded_child(
            &mut noisy,
            Duration::from_secs(5),
            1024 * 1024 * 1024,
            128,
            false,
        )
        .unwrap();
        assert!(capped.status.success());
        assert!(capped.stdout.truncated);
        assert_eq!(capped.stdout.bytes.len(), 128);
        assert_eq!(capped.stdout.total_bytes, 4096);
    }

    #[test]
    fn child_record_identity_and_gate_require_complete_evidence() {
        let temp = TestDir::new();
        assert!(!minimal_dng(ByteOrder::Big).is_empty());
        let case_dir = temp.path.join("cases");
        fs::create_dir_all(&case_dir).unwrap();
        let bytes = minimal_dng(ByteOrder::Little);
        fs::write(case_dir.join("minimal.dng"), &bytes).unwrap();
        let case = RawCorpusCase {
            id: "owned-dng".into(),
            family: RawCorpusFamily::DngUncompressedBayer,
            variant: "generated fixture".into(),
            relative_path: "cases/minimal.dng".into(),
            sha256: sha256_hex(&bytes),
            provenance: RawCorpusProvenance {
                origin: RawCorpusOrigin::RedistributableFixture,
                rights_reference: "generated by the test suite".into(),
                source_uri: None,
                redistribution: RawRedistributionPolicy::Permitted,
                contains_personal_metadata: false,
            },
            expected: RawProbeExpectation::default(),
        };
        let base = probe_owned_case(&case, &temp.path);
        validate_child_record(&case, &base).unwrap();

        let mut wrong_id = base.clone();
        wrong_id.case_id = "other".into();
        assert!(validate_child_record(&case, &wrong_id).is_err());
        let mut forged_checks = base.clone();
        forged_checks.expectation_checks.clear();
        assert!(validate_child_record(&case, &forged_checks).is_err());
        let mut forged_expected = base.clone();
        forged_expected.expected.sensor_sample_count = Some(36);
        assert!(validate_child_record(&case, &forged_expected).is_err());

        let coverage = RawCorpusCoverage {
            complete: true,
            present: RawCorpusFamily::REQUIRED.to_vec(),
            missing: Vec::new(),
        };
        let runner = eligible_runner();
        let complete = complete_gate_records(&base);
        assert!(summarize_evidence(&coverage, &runner, &complete).gate_ready);

        let mut missing_peak = complete.clone();
        missing_peak[0]
            .metrics
            .as_mut()
            .unwrap()
            .peak_working_set_bytes = None;
        assert!(!summarize_evidence(&coverage, &runner, &missing_peak).gate_ready);

        let mut missing_child_peak = complete.clone();
        missing_child_peak[0]
            .child_process
            .as_mut()
            .unwrap()
            .peak_working_set_bytes = None;
        assert!(!summarize_evidence(&coverage, &runner, &missing_child_peak).gate_ready);

        let mut missing_sensor_timing = complete.clone();
        missing_sensor_timing[0]
            .metrics
            .as_mut()
            .unwrap()
            .sensor_unpack_us = None;
        assert!(!summarize_evidence(&coverage, &runner, &missing_sensor_timing).gate_ready);

        let mut zero_samples = complete.clone();
        if let RawEvidenceOutcome::ProbeSucceeded { sensor_unpack, .. } =
            &mut zero_samples[0].outcome
        {
            *sensor_unpack = RawSensorUnpackEvidence::Succeeded {
                sample_count: 0,
                sample_digest_sha256: "a".repeat(64),
            };
        }
        assert!(!summarize_evidence(&coverage, &runner, &zero_samples).gate_ready);

        let mut bad_digest = complete.clone();
        if let RawEvidenceOutcome::ProbeSucceeded { sensor_unpack, .. } = &mut bad_digest[0].outcome
        {
            *sensor_unpack = RawSensorUnpackEvidence::Succeeded {
                sample_count: 36,
                sample_digest_sha256: "not-a-digest".into(),
            };
        }
        assert!(!summarize_evidence(&coverage, &runner, &bad_digest).gate_ready);

        let mut missing_reference = complete.clone();
        missing_reference[0].expected.sensor_sample_digest_sha256 = None;
        assert!(!summarize_evidence(&coverage, &runner, &missing_reference).gate_ready);

        let mut missing_checks = complete.clone();
        missing_checks[0].expectation_checks.clear();
        assert!(!summarize_evidence(&coverage, &runner, &missing_checks).gate_ready);

        let mut duplicate_case = complete.clone();
        duplicate_case[1].case_id = duplicate_case[0].case_id.clone();
        assert!(!summarize_evidence(&coverage, &runner, &duplicate_case).gate_ready);

        let mut unknown_source = runner.clone();
        unknown_source.source_dirty = None;
        assert!(!summarize_evidence(&coverage, &unknown_source, &complete).gate_ready);

        let mut incomplete_runner = runner.clone();
        incomplete_runner.supported_families.pop();
        assert!(!summarize_evidence(&coverage, &incomplete_runner, &complete).gate_ready);
    }

    fn complete_gate_records(base: &RawEvidenceCaseRecord) -> Vec<RawEvidenceCaseRecord> {
        RawCorpusFamily::REQUIRED
            .into_iter()
            .enumerate()
            .map(|(index, family)| {
                let mut record = base.clone();
                record.case_id = format!("gate-{index}");
                record.family = family;
                record.expected.sensor_sample_count = Some(36);
                record.expected.sensor_sample_digest_sha256 = Some("a".repeat(64));
                record.expected.sensor_reference = Some("independent generated fixture".into());
                record.expectation_checks = vec![RawExpectationCheck {
                    field: "verified".into(),
                    expected: "true".into(),
                    actual: Some("true".into()),
                    passed: true,
                }];
                let metrics = record.metrics.as_mut().unwrap();
                metrics.metadata_probe_us = Some(1);
                metrics.sensor_unpack_us = Some(1);
                metrics.peak_working_set_bytes = Some(1);
                record.child_process = Some(RawChildProcessMetrics {
                    wall_us: 1,
                    peak_working_set_bytes: Some(1),
                    stdout_bytes: 1,
                    stderr_bytes: 0,
                    stdout_truncated: false,
                    stderr_truncated: false,
                    timed_out: false,
                });
                if let RawEvidenceOutcome::ProbeSucceeded {
                    report,
                    sensor_unpack,
                } = &mut record.outcome
                {
                    report.container = family.expected_container();
                    match family {
                        RawCorpusFamily::DngUncompressedBayer => report.compression.code = 1,
                        RawCorpusFamily::DngLosslessCompressedBayer => {
                            report.compression.code = 7;
                        }
                        RawCorpusFamily::CanonCr3 => {
                            report.compression.description = Some("canon_cr3_raw".into());
                        }
                        RawCorpusFamily::CanonCr3Craw => {
                            report.compression.description = Some("canon_cr3_c_raw".into());
                        }
                        RawCorpusFamily::FujifilmRafXTrans => {
                            report.cfa.as_mut().unwrap().repeat = RawGridSize {
                                rows: 6,
                                columns: 6,
                            };
                        }
                        _ => {}
                    }
                    *sensor_unpack = RawSensorUnpackEvidence::Succeeded {
                        sample_count: 36,
                        sample_digest_sha256: "a".repeat(64),
                    };
                }
                record
            })
            .collect()
    }

    fn eligible_runner() -> RawRunnerIdentity {
        RawRunnerIdentity {
            id: "test-runner".into(),
            version: "1".into(),
            source_revision: "a".repeat(40),
            source_dirty: Some(false),
            source_license: "GPL-3.0-only".into(),
            platform: "windows-x86_64".into(),
            build_profile: "release".into(),
            executable_name: "runner.exe".into(),
            executable_sha256: "b".repeat(64),
            executable_bytes: 1,
            bundled_runtime_payload_bytes: 0,
            case_timeout_ms: CHILD_TIMEOUT_MS,
            case_memory_limit_bytes: CHILD_MEMORY_LIMIT_BYTES,
            case_process_limit: CHILD_PROCESS_LIMIT,
            child_output_limit_bytes: CHILD_OUTPUT_LIMIT_BYTES,
            supported_families: RawCorpusFamily::REQUIRED.to_vec(),
        }
    }

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "hgripe-raw-evidence-runner-{}-{id}",
                std::process::id()
            ));
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
