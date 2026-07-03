//! Vendored-FFmpeg version contract (see `third_party/ffmpeg/VENDOR.md`).
//!
//! The FFmpeg version is declared in three independent places that nothing
//! else keeps in sync: the `ffmpegX_Y` feature on the `rusty_ffmpeg`
//! dependency (which selects the prebuilt bindings and version cfgs), the
//! vendored headers/DLLs under `third_party/ffmpeg/win-x64`, and the
//! `FFMPEG_*` link env in `.cargo/config.toml`. Bumping one without the
//! others can still compile and only fail at runtime, so these tests pin the
//! whole set together: any partial upgrade turns CI red.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// libav* major versions shipped by each supported FFmpeg release line,
/// keyed by the `rusty_ffmpeg` feature that selects it. Extend this table in
/// the same PR that upgrades `third_party/ffmpeg` and the Cargo feature.
fn expected_majors(feature: &str) -> Option<BTreeMap<&'static str, u32>> {
    match feature {
        "ffmpeg8_1" => Some(BTreeMap::from([
            ("avutil", 60),
            ("avcodec", 62),
            ("avformat", 62),
            ("avfilter", 11),
            ("avdevice", 62),
            ("swscale", 9),
            ("swresample", 6),
        ])),
        _ => None,
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The `ffmpegX_Y` feature declared on the `rusty_ffmpeg` dependency.
fn declared_feature() -> String {
    let manifest = read(&Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"));
    let line = manifest
        .lines()
        .find(|l| l.trim_start().starts_with("rusty_ffmpeg"))
        .expect("rusty_ffmpeg dependency in Cargo.toml");
    let feature = line
        .split(['"', '\''])
        .find(|tok| {
            tok.starts_with("ffmpeg")
                && tok[6..].chars().all(|c| c.is_ascii_digit() || c == '_')
                && !tok[6..].is_empty()
        })
        .unwrap_or_else(|| panic!("no ffmpegX_Y feature on rusty_ffmpeg line: {line}"));
    feature.to_string()
}

/// `LIB<NAME>_VERSION_MAJOR` from the vendored headers. FFmpeg keeps the
/// major in `version_major.h` for every lib except avutil (`version.h`).
fn header_major(include: &Path, lib: &str) -> u32 {
    let file = if lib == "avutil" {
        "version.h"
    } else {
        "version_major.h"
    };
    let text = read(&include.join(format!("lib{lib}")).join(file));
    let needle = format!("#define LIB{}_VERSION_MAJOR", lib.to_uppercase());
    text.lines()
        .find(|l| l.starts_with(&needle))
        .and_then(|l| l[needle.len()..].trim().parse().ok())
        .unwrap_or_else(|| panic!("no {needle} in lib{lib}/{file}"))
}

#[test]
fn feature_matches_vendored_headers_and_dlls() {
    let root = repo_root();
    let feature = declared_feature();
    let expected = expected_majors(&feature).unwrap_or_else(|| {
        panic!(
            "unknown rusty_ffmpeg feature `{feature}` — add its libav* majors to expected_majors()"
        )
    });

    let vendor = root.join("third_party/ffmpeg/win-x64");
    let include = vendor.join("include");
    for (lib, &major) in &expected {
        let got = header_major(&include, lib);
        assert_eq!(
            got, major,
            "lib{lib} header major {got} does not match {major} implied by feature `{feature}` — \
             upgrade third_party/ffmpeg and the Cargo feature together (see third_party/ffmpeg/VENDOR.md)"
        );

        let dll = vendor.join("bin").join(format!("{lib}-{major}.dll"));
        assert!(dll.is_file(), "missing runtime DLL {}", dll.display());
        let implib = vendor.join("lib").join(format!("{lib}.lib"));
        assert!(implib.is_file(), "missing import lib {}", implib.display());
    }
}

#[test]
fn cargo_config_points_at_the_vendored_libs() {
    let config = read(&Path::new(env!("CARGO_MANIFEST_DIR")).join(".cargo/config.toml"));
    let libs_dir = config
        .lines()
        .find(|l| l.trim_start().starts_with("FFMPEG_LIBS_DIR"))
        .expect("FFMPEG_LIBS_DIR in .cargo/config.toml");
    assert!(
        libs_dir.contains("third_party/ffmpeg/win-x64/lib"),
        "FFMPEG_LIBS_DIR must point at the vendored third_party/ffmpeg/win-x64/lib (no system \
         FFmpeg, no vcpkg): {libs_dir}"
    );
    assert!(
        config
            .lines()
            .any(|l| l.trim_start().starts_with("FFMPEG_LINK_MODE") && l.contains("dynamic")),
        "FFMPEG_LINK_MODE must stay `dynamic` (shared LGPL libav*)"
    );
}

#[test]
fn lockfile_and_vendored_crate_match_the_feature() {
    let root = repo_root();
    let feature = declared_feature();
    // "ffmpeg8_1" -> "8.1": the version the feature claims to bind against.
    let feature_ver = feature.trim_start_matches("ffmpeg").replace('_', ".");

    let lock = read(&root.join("Cargo.lock"));
    let locked_version = lock
        .lines()
        .skip_while(|l| *l != "name = \"rusty_ffmpeg\"")
        .find_map(|l| {
            l.strip_prefix("version = \"")
                .and_then(|v| v.strip_suffix('"'))
        })
        .expect("rusty_ffmpeg entry in Cargo.lock");
    let (_, build_meta) = locked_version.split_once("+ffmpeg.").unwrap_or_else(|| {
        panic!("rusty_ffmpeg lock version `{locked_version}` has no +ffmpeg.X.Y metadata")
    });
    assert_eq!(
        build_meta, feature_ver,
        "Cargo.lock pins rusty_ffmpeg {locked_version} but the Cargo feature is `{feature}` — \
         bump both in the same PR (see third_party/ffmpeg/VENDOR.md)"
    );

    let vendored = root
        .join("third_party/cargo-vendor")
        .join(format!("rusty_ffmpeg-{locked_version}"));
    assert!(
        vendored.is_dir(),
        "vendored crate {} missing — re-run `cargo vendor` after changing rusty_ffmpeg",
        vendored.display()
    );
}
