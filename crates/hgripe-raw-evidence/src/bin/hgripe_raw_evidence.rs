use hgripe_raw_evidence::{
    child_command_name, collect_owned_evidence, fingerprint_case, load_manifest, probe_owned_case,
    validate_manifest, verify_corpus, write_evidence_bundle, RawBlindChildCase, RawCorpusManifest,
    RawCorpusProvenance, RawFingerprintRequest, RAW_BLIND_CHILD_CASE_SCHEMA_VERSION,
    RAW_CORPUS_MANIFEST_SCHEMA_VERSION,
};
use serde::Serialize;
use serde_json::json;
use std::env;
use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

const CHILD_HANDSHAKE_ENV: &str = "HG_R0_CHILD_HANDSHAKE";
const MAX_CHILD_CASE_JSON_BYTES: u64 = 1024 * 1024;

fn main() -> ExitCode {
    match run(env::args().skip(1).collect()) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}

fn run(mut args: Vec<String>) -> Result<ExitCode, String> {
    if args.is_empty() || matches!(args[0].as_str(), "-h" | "--help") {
        print_help();
        return Ok(ExitCode::SUCCESS);
    }
    let command = args.remove(0);
    match command.as_str() {
        "validate" => run_validate(args),
        "verify-corpus" => run_verify_corpus(args),
        "fingerprint" => run_fingerprint(args),
        "run-owned" => run_owned(args),
        command if command == child_command_name() => run_child(args),
        _ => Err(format!(
            "unknown command '{command}'. Run hgripe-raw-evidence --help."
        )),
    }
}

fn run_validate(args: Vec<String>) -> Result<ExitCode, String> {
    let [manifest_path] = args.as_slice() else {
        return Err("usage: hgripe-raw-evidence validate <manifest.json>".into());
    };
    let manifest =
        load_manifest(PathBuf::from(manifest_path).as_path()).map_err(|error| error.to_string())?;
    let validation = validate_manifest(&manifest);
    print_json_pretty(&validation)?;
    Ok(if validation.valid {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

fn run_verify_corpus(args: Vec<String>) -> Result<ExitCode, String> {
    let [manifest_path, corpus_root] = args.as_slice() else {
        return Err(
            "usage: hgripe-raw-evidence verify-corpus <manifest.json> <corpus-root>".into(),
        );
    };
    let report = verify_corpus(
        PathBuf::from(manifest_path).as_path(),
        PathBuf::from(corpus_root).as_path(),
    )
    .map_err(|error| error.to_string())?;
    print_json_pretty(&report)?;
    Ok(if report.corpus_ready {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(3)
    })
}

fn run_fingerprint(args: Vec<String>) -> Result<ExitCode, String> {
    let [corpus_root, relative_path, id, family, variant, origin, rights_reference, redistribution, contains_personal_metadata, source_uri] =
        args.as_slice()
    else {
        return Err(
            "usage: hgripe-raw-evidence fingerprint <corpus-root> <relative-path> <id> <family> <variant> <origin> <rights-reference> <redistribution> <contains-personal-metadata> <source-uri-or-dash>"
                .into(),
        );
    };
    let request = RawFingerprintRequest {
        id: id.clone(),
        family: parse_json_enum(family, "RAW family")?,
        variant: variant.clone(),
        relative_path: relative_path.clone(),
        provenance: RawCorpusProvenance {
            origin: parse_json_enum(origin, "corpus origin")?,
            rights_reference: rights_reference.clone(),
            source_uri: (source_uri != "-").then(|| source_uri.clone()),
            redistribution: parse_json_enum(redistribution, "redistribution policy")?,
            contains_personal_metadata: parse_bool(
                contains_personal_metadata,
                "contains-personal-metadata",
            )?,
        },
    };
    let draft = fingerprint_case(PathBuf::from(corpus_root).as_path(), request)
        .map_err(|error| error.to_string())?;
    print_json_pretty(&draft)?;
    Ok(ExitCode::SUCCESS)
}

fn parse_json_enum<T>(value: &str, field: &str) -> Result<T, String>
where
    T: serde::de::DeserializeOwned,
{
    serde_json::from_value(serde_json::Value::String(value.into()))
        .map_err(|_| format!("invalid {field} '{value}'"))
}

fn parse_bool(value: &str, field: &str) -> Result<bool, String> {
    match value {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(format!("{field} must be true or false")),
    }
}

fn run_owned(args: Vec<String>) -> Result<ExitCode, String> {
    let [manifest_path, corpus_root, output_path] = args.as_slice() else {
        return Err(
            "usage: hgripe-raw-evidence run-owned <manifest.json> <corpus-root> <output.json>"
                .into(),
        );
    };
    let manifest_path = PathBuf::from(manifest_path);
    let corpus_root = PathBuf::from(corpus_root);
    let output_path = PathBuf::from(output_path);
    let bundle =
        collect_owned_evidence(&manifest_path, &corpus_root).map_err(|error| error.to_string())?;
    write_evidence_bundle(&output_path, &bundle).map_err(|error| error.to_string())?;
    print_json_pretty(&json!({
        "output": output_path,
        "corpus_id": bundle.corpus_id,
        "case_count": bundle.cases.len(),
        "coverage_complete": bundle.coverage.complete,
        "gate_ready": bundle.summary.gate_ready,
    }))?;
    Ok(ExitCode::SUCCESS)
}

fn run_child(args: Vec<String>) -> Result<ExitCode, String> {
    let [corpus_root] = args.as_slice() else {
        return Err("invalid internal child arguments".into());
    };
    match env::var(CHILD_HANDSHAKE_ENV) {
        Ok(value) if value == "1" => {}
        _ => return Err("internal child requires a parent handshake".into()),
    }
    let mut stdin = std::io::stdin().lock();
    let mut release = [0_u8; 2];
    stdin
        .read_exact(&mut release)
        .map_err(|error| format!("cannot receive parent release handshake: {error}"))?;
    if release != *b"R0" {
        return Err("invalid parent release handshake".into());
    }
    let mut payload = Vec::new();
    stdin
        .take(MAX_CHILD_CASE_JSON_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| format!("cannot receive child case snapshot: {error}"))?;
    if u64::try_from(payload.len()).unwrap_or(u64::MAX) > MAX_CHILD_CASE_JSON_BYTES {
        return Err(format!(
            "child case snapshot exceeds {MAX_CHILD_CASE_JSON_BYTES} bytes"
        ));
    }
    let snapshot: RawBlindChildCase = serde_json::from_slice(&payload)
        .map_err(|error| format!("invalid child case snapshot: {error}"))?;
    if snapshot.schema_version != RAW_BLIND_CHILD_CASE_SCHEMA_VERSION {
        return Err("internal child received an unsupported snapshot schema".into());
    }
    let case = snapshot.to_probe_case();
    let manifest = RawCorpusManifest {
        schema_version: RAW_CORPUS_MANIFEST_SCHEMA_VERSION,
        corpus_id: "internal-child-case".into(),
        cases: vec![case.clone()],
    };
    let validation = validate_manifest(&manifest);
    if !validation.valid {
        return Err("internal child received an invalid case snapshot".into());
    }
    let record = probe_owned_case(&case, PathBuf::from(corpus_root).as_path());
    serde_json::to_writer(std::io::stdout().lock(), &record).map_err(|error| error.to_string())?;
    Ok(ExitCode::SUCCESS)
}

fn print_json_pretty(value: &impl Serialize) -> Result<(), String> {
    serde_json::to_writer_pretty(std::io::stdout().lock(), value)
        .map_err(|error| error.to_string())?;
    println!();
    Ok(())
}

fn print_help() {
    println!(
        "hgripe-raw-evidence\n\n\
         Commands:\n\
           validate <manifest.json>\n\
           verify-corpus <manifest.json> <corpus-root>\n\
           fingerprint <corpus-root> <relative-path> <id> <family> <variant> <origin> <rights-reference> <redistribution> <contains-personal-metadata> <source-uri-or-dash>\n\
           run-owned <manifest.json> <corpus-root> <output.json>\n\n\
         The owned runner probes DNG metadata only. It does not unpack sensor samples."
    );
}
