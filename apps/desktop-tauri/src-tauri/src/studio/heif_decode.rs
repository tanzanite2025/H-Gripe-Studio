//! HEIC / AVIF still-image decoding via the vendored FFmpeg libraries.
//!
//! The `image` crate cannot decode HEIF-family stills (HEIC needs an HEVC
//! decoder, AVIF an AV1 decoder). Rather than pulling a new C decoder stack
//! (libheif/libde265/dav1d) into the tree, this reuses the libav* libraries
//! already vendored under `third_party/ffmpeg` (LGPL shared, cut from upstream
//! and locally maintained) — their `mov` demuxer reads HEIF containers and
//! their built-in HEVC / dav1d AV1 decoders handle the primary image.
//!
//! Split in two layers so callers never need their own `cfg`:
//! - [`heif_kind`]: pure header sniffing (`ftyp` major/compatible brands),
//!   always compiled.
//! - [`decode_rgba_from_path`] / [`decode_rgba_from_bytes`] / [`probe_dims`]:
//!   decode through [`super::ffmpeg_native`] when the `native-ffmpeg` feature
//!   is on; otherwise they return a descriptive `Err`, which every caller
//!   already treats as "unsupported image" (same behaviour as before this
//!   module existed).

use std::path::Path;

/// The HEIF flavour of a byte stream, sniffed from the `ftyp` box. `None` for
/// anything that is not a HEIF container (including all `image`-decodable
/// formats, which never start with `ftyp`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HeifKind {
    /// HEVC-coded still (`heic`/`heix`/`heim`/`heis`/`hevc`/`hevx`, or the
    /// generic `mif1`/`msf1` structural brands).
    Heic,
    /// AV1-coded still (`avif`/`avis`).
    Avif,
}

impl HeifKind {
    pub(crate) fn label(self) -> &'static str {
        match self {
            HeifKind::Heic => "HEIC",
            HeifKind::Avif => "AVIF",
        }
    }
}

fn brand_kind(brand: &[u8]) -> Option<HeifKind> {
    match brand {
        b"avif" | b"avis" => Some(HeifKind::Avif),
        b"heic" | b"heix" | b"heim" | b"heis" | b"hevc" | b"hevx" | b"mif1" | b"msf1" => {
            Some(HeifKind::Heic)
        }
        _ => None,
    }
}

/// Sniff a HEIF container from the leading bytes: an ISO-BMFF `ftyp` box whose
/// major brand — or any compatible brand — is a HEIF still brand. AVIF brands
/// win over the generic `mif1`/`msf1` so an AVIF that also lists `mif1` is
/// classified correctly.
pub(crate) fn heif_kind(bytes: &[u8]) -> Option<HeifKind> {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return None;
    }
    let box_len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    // Major brand, then minor version (skipped), then compatible brands.
    let mut found: Option<HeifKind> = brand_kind(&bytes[8..12]);
    let end = box_len.clamp(16, 256).min(bytes.len());
    let mut at = 16;
    while at + 4 <= end {
        match (found, brand_kind(&bytes[at..at + 4])) {
            (_, Some(HeifKind::Avif)) => return Some(HeifKind::Avif),
            (None, kind) => found = kind,
            _ => {}
        }
        at += 4;
    }
    found
}

#[cfg(feature = "native-ffmpeg")]
pub(crate) fn decode_rgba_from_path(
    path: &Path,
    max_pixels: u64,
) -> Result<image::RgbaImage, String> {
    super::ffmpeg_native::decode_still_rgba(path, max_pixels)
}

#[cfg(not(feature = "native-ffmpeg"))]
pub(crate) fn decode_rgba_from_path(
    path: &Path,
    _max_pixels: u64,
) -> Result<image::RgbaImage, String> {
    Err(unsupported(path))
}

/// Decode in-memory HEIF bytes by staging them to a temp file (libav demuxes
/// from a path; the callers with only bytes are all preview-sized, ≤ 25 MB).
pub(crate) fn decode_rgba_from_bytes(
    bytes: &[u8],
    max_pixels: u64,
) -> Result<image::RgbaImage, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_nanos();
    let staged = std::env::temp_dir().join(format!("hgripe_heif_{nanos}_{}.bin", bytes.len()));
    std::fs::write(&staged, bytes).map_err(|err| format!("failed to stage HEIF bytes: {err}"))?;
    let result = decode_rgba_from_path(&staged, max_pixels);
    let _ = std::fs::remove_file(&staged);
    result
}

/// `width x height` of the primary image, from the container header only.
#[cfg(feature = "native-ffmpeg")]
pub(crate) fn probe_dims(path: &Path) -> Result<(u32, u32), String> {
    super::ffmpeg_native::probe_still_dims(path)
}

#[cfg(not(feature = "native-ffmpeg"))]
pub(crate) fn probe_dims(path: &Path) -> Result<(u32, u32), String> {
    Err(unsupported(path))
}

#[cfg(not(feature = "native-ffmpeg"))]
fn unsupported(path: &Path) -> String {
    format!(
        "HEIC/AVIF decoding requires the `native-ffmpeg` build (vendored libav decoders): {}",
        path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ftyp(major: &[u8; 4], compat: &[&[u8; 4]]) -> Vec<u8> {
        let len = 16 + compat.len() * 4;
        let mut bytes = (len as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(major);
        bytes.extend_from_slice(&[0, 0, 0, 0]); // minor version
        for c in compat {
            bytes.extend_from_slice(*c);
        }
        bytes
    }

    #[test]
    fn sniffs_major_brands() {
        assert_eq!(heif_kind(&ftyp(b"avif", &[])), Some(HeifKind::Avif));
        assert_eq!(heif_kind(&ftyp(b"heic", &[])), Some(HeifKind::Heic));
        assert_eq!(heif_kind(&ftyp(b"mif1", &[b"heic"])), Some(HeifKind::Heic));
    }

    #[test]
    fn avif_wins_over_generic_structural_brand() {
        assert_eq!(
            heif_kind(&ftyp(b"mif1", &[b"miaf", b"avif"])),
            Some(HeifKind::Avif)
        );
    }

    #[test]
    fn rejects_non_heif() {
        assert_eq!(heif_kind(&ftyp(b"isom", &[b"mp42"])), None);
        assert_eq!(heif_kind(b"\x89PNG\r\n\x1a\n____"), None);
        assert_eq!(heif_kind(b""), None);
    }

    #[test]
    fn real_fixtures_sniff_correctly() {
        let avif = include_bytes!("../../tests/fixtures/tiny_still.avif");
        let heic = include_bytes!("../../tests/fixtures/tiny_still.heic");
        assert_eq!(heif_kind(avif), Some(HeifKind::Avif));
        assert_eq!(heif_kind(heic), Some(HeifKind::Heic));
    }

    #[cfg(not(feature = "native-ffmpeg"))]
    #[test]
    fn decode_without_feature_reports_requirement() {
        let err = decode_rgba_from_path(Path::new("x.heic"), 0).unwrap_err();
        assert!(err.contains("native-ffmpeg"), "{err}");
    }

    #[cfg(feature = "native-ffmpeg")]
    mod native {
        use super::*;

        #[test]
        fn decodes_avif_fixture() {
            let path = Path::new(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/tiny_still.avif"
            ));
            let image = decode_rgba_from_path(path, 0).unwrap();
            assert_eq!((image.width(), image.height()), (32, 24));
            // The fixture is solid red (chroma-subsampled, so allow slack).
            let px = image.get_pixel(16, 12);
            assert!(px[0] > 200 && px[1] < 60 && px[2] < 60, "{px:?}");
        }

        #[test]
        fn decodes_heic_fixture() {
            let path = Path::new(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/tiny_still.heic"
            ));
            let image = decode_rgba_from_path(path, 0).unwrap();
            assert!(image.width() > 0 && image.height() > 0);
            let (w, h) = probe_dims(path).unwrap();
            assert_eq!((w, h), (image.width(), image.height()));
        }

        #[test]
        fn decode_from_bytes_matches_path() {
            let bytes = include_bytes!("../../tests/fixtures/tiny_still.avif");
            let image = decode_rgba_from_bytes(bytes, 0).unwrap();
            assert_eq!((image.width(), image.height()), (32, 24));
        }

        #[test]
        fn oversized_decode_is_rejected() {
            let path = Path::new(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/tiny_still.avif"
            ));
            let err = decode_rgba_from_path(path, 16).unwrap_err();
            assert!(err.contains("too large"), "{err}");
        }
    }
}
