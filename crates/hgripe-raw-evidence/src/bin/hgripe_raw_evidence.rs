use hgripe_raw_evidence::{
    child_command_name, collect_owned_evidence, find_case, load_manifest, load_manifest_snapshot,
    probe_owned_case, validate_manifest, write_evidence_bundle,
};
use serde::Serialize;
use serde_json::json;
use std::env;
use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

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
    let [manifest_path, corpus_root, case_id, expected_manifest_sha256] = args.as_slice() else {
        return Err("invalid internal child arguments".into());
    };
    if env::var_os("HG_R0_CHILD_HANDSHAKE").is_some() {
        let mut release = [0_u8; 2];
        std::io::stdin()
            .lock()
            .read_exact(&mut release)
            .map_err(|error| format!("cannot receive parent release handshake: {error}"))?;
        if release != *b"R0" {
            return Err("invalid parent release handshake".into());
        }
    }
    let manifest_path = PathBuf::from(manifest_path);
    let snapshot = load_manifest_snapshot(&manifest_path).map_err(|error| error.to_string())?;
    if snapshot.sha256 != *expected_manifest_sha256 {
        return Err("corpus manifest snapshot does not match the parent digest".into());
    }
    let manifest = snapshot.manifest;
    let validation = validate_manifest(&manifest);
    if !validation.valid {
        return Err("internal child received an invalid manifest".into());
    }
    let case = find_case(&manifest, case_id)
        .ok_or_else(|| format!("manifest case '{case_id}' was not found"))?;
    let record = probe_owned_case(case, PathBuf::from(corpus_root).as_path());
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
           run-owned <manifest.json> <corpus-root> <output.json>\n\n\
         The owned runner probes DNG metadata only. It does not unpack sensor samples."
    );
}
