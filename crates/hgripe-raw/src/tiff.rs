use crate::{
    RawByteOrder, RawCameraIdentity, RawCfaPattern, RawColorMatrix, RawCompression, RawContainer,
    RawCrop, RawDataLayout, RawDataRef, RawDeferredTagRef, RawDimensions, RawDngMetadata,
    RawGridSize, RawLevelGrid, RawMatrixKind, RawPreviewKind, RawPreviewRef, RawProbeDiagnostic,
    RawProbeDiagnosticSeverity, RawProbeError, RawProbeMetrics, RawProbeReport, RawProfileIdentity,
    RawRational, RawRect, RawSourceIdentity, RAW_PROBE_SCHEMA_VERSION,
};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::time::Instant;

const TIFF_MAGIC: u16 = 42;
const BIG_TIFF_MAGIC: u16 = 43;

const MAX_IFD_DEPTH: u32 = 4;
const MAX_IFDS: u64 = 32;
const MAX_ENTRIES_PER_IFD: u64 = 512;
const MAX_TOTAL_ENTRIES: u64 = 4_096;
const MAX_SUB_IFDS: u64 = 16;
const MAX_MATERIALIZED_FIELD_BYTES: u64 = 64 * 1024;
const MAX_TOTAL_MATERIALIZED_BYTES: u64 = 256 * 1024;
const MAX_ASCII_BYTES: u64 = 4 * 1024;
const MAX_CFA_PATTERN_VALUES: u64 = 256;
const MAX_MASKED_RECTS: u64 = 64;
const MAX_DATA_RANGES: u64 = 4_096;
const MAX_SENSOR_PIXELS: u64 = 1_000_000_000;
const MAX_ESTIMATED_UNPACKED_BYTES: u64 = 16 * 1024 * 1024 * 1024;

const TAG_NEW_SUBFILE_TYPE: u16 = 254;
const TAG_IMAGE_WIDTH: u16 = 256;
const TAG_IMAGE_LENGTH: u16 = 257;
const TAG_BITS_PER_SAMPLE: u16 = 258;
const TAG_COMPRESSION: u16 = 259;
const TAG_PHOTOMETRIC_INTERPRETATION: u16 = 262;
const TAG_MAKE: u16 = 271;
const TAG_MODEL: u16 = 272;
const TAG_STRIP_OFFSETS: u16 = 273;
const TAG_ORIENTATION: u16 = 274;
const TAG_SAMPLES_PER_PIXEL: u16 = 277;
const TAG_ROWS_PER_STRIP: u16 = 278;
const TAG_STRIP_BYTE_COUNTS: u16 = 279;
const TAG_PLANAR_CONFIGURATION: u16 = 284;
const TAG_TILE_WIDTH: u16 = 322;
const TAG_TILE_LENGTH: u16 = 323;
const TAG_TILE_OFFSETS: u16 = 324;
const TAG_TILE_BYTE_COUNTS: u16 = 325;
const TAG_SUB_IFDS: u16 = 330;
const TAG_SAMPLE_FORMAT: u16 = 339;
const TAG_JPEG_INTERCHANGE_FORMAT: u16 = 513;
const TAG_JPEG_INTERCHANGE_FORMAT_LENGTH: u16 = 514;
const TAG_CFA_REPEAT_PATTERN_DIM: u16 = 33421;
const TAG_CFA_PATTERN: u16 = 33422;

const TAG_DNG_VERSION: u16 = 50706;
const TAG_DNG_BACKWARD_VERSION: u16 = 50707;
const TAG_UNIQUE_CAMERA_MODEL: u16 = 50708;
const TAG_CFA_PLANE_COLOR: u16 = 50710;
const TAG_CFA_LAYOUT: u16 = 50711;
const TAG_LINEARIZATION_TABLE: u16 = 50712;
const TAG_BLACK_LEVEL_REPEAT_DIM: u16 = 50713;
const TAG_BLACK_LEVEL: u16 = 50714;
const TAG_BLACK_LEVEL_DELTA_H: u16 = 50715;
const TAG_BLACK_LEVEL_DELTA_V: u16 = 50716;
const TAG_WHITE_LEVEL: u16 = 50717;
const TAG_DEFAULT_CROP_ORIGIN: u16 = 50719;
const TAG_DEFAULT_CROP_SIZE: u16 = 50720;
const TAG_COLOR_MATRIX_1: u16 = 50721;
const TAG_COLOR_MATRIX_2: u16 = 50722;
const TAG_CAMERA_CALIBRATION_1: u16 = 50723;
const TAG_CAMERA_CALIBRATION_2: u16 = 50724;
const TAG_REDUCTION_MATRIX_1: u16 = 50725;
const TAG_REDUCTION_MATRIX_2: u16 = 50726;
const TAG_ANALOG_BALANCE: u16 = 50727;
const TAG_AS_SHOT_NEUTRAL: u16 = 50728;
const TAG_AS_SHOT_WHITE_XY: u16 = 50729;
const TAG_CALIBRATION_ILLUMINANT_1: u16 = 50778;
const TAG_CALIBRATION_ILLUMINANT_2: u16 = 50779;
const TAG_RAW_DATA_UNIQUE_ID: u16 = 50781;
const TAG_ACTIVE_AREA: u16 = 50829;
const TAG_MASKED_AREAS: u16 = 50830;
const TAG_CAMERA_CALIBRATION_SIGNATURE: u16 = 50931;
const TAG_PROFILE_CALIBRATION_SIGNATURE: u16 = 50932;
const TAG_PROFILE_NAME: u16 = 50936;
const TAG_PROFILE_EMBED_POLICY: u16 = 50941;
const TAG_FORWARD_MATRIX_1: u16 = 50964;
const TAG_FORWARD_MATRIX_2: u16 = 50965;

const PHOTOMETRIC_CFA: u16 = 32_803;
const PHOTOMETRIC_LINEAR_RAW: u16 = 34_892;

/// Probes classic-TIFF DNG metadata without reading or decoding pixel payloads.
pub fn probe_dng(bytes: &[u8]) -> Result<RawProbeReport, RawProbeError> {
    let started = Instant::now();
    let mut parser = TiffParser::new(bytes)?;
    parser.parse_graph()?;
    let mut report = build_report(&mut parser)?;
    report.metrics.elapsed_us = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
    Ok(report)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Endian {
    Little,
    Big,
}

impl Endian {
    fn read_u16(self, bytes: &[u8]) -> u16 {
        let bytes = [bytes[0], bytes[1]];
        match self {
            Self::Little => u16::from_le_bytes(bytes),
            Self::Big => u16::from_be_bytes(bytes),
        }
    }

    fn read_i16(self, bytes: &[u8]) -> i16 {
        let bytes = [bytes[0], bytes[1]];
        match self {
            Self::Little => i16::from_le_bytes(bytes),
            Self::Big => i16::from_be_bytes(bytes),
        }
    }

    fn read_u32(self, bytes: &[u8]) -> u32 {
        let bytes = [bytes[0], bytes[1], bytes[2], bytes[3]];
        match self {
            Self::Little => u32::from_le_bytes(bytes),
            Self::Big => u32::from_be_bytes(bytes),
        }
    }

    fn read_i32(self, bytes: &[u8]) -> i32 {
        let bytes = [bytes[0], bytes[1], bytes[2], bytes[3]];
        match self {
            Self::Little => i32::from_le_bytes(bytes),
            Self::Big => i32::from_be_bytes(bytes),
        }
    }

    fn report_value(self) -> RawByteOrder {
        match self {
            Self::Little => RawByteOrder::LittleEndian,
            Self::Big => RawByteOrder::BigEndian,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
enum FieldType {
    Byte = 1,
    Ascii = 2,
    Short = 3,
    Long = 4,
    Rational = 5,
    SByte = 6,
    Undefined = 7,
    SShort = 8,
    SLong = 9,
    SRational = 10,
    Float = 11,
    Double = 12,
    Ifd = 13,
}

impl FieldType {
    fn from_raw(value: u16) -> Option<Self> {
        Some(match value {
            1 => Self::Byte,
            2 => Self::Ascii,
            3 => Self::Short,
            4 => Self::Long,
            5 => Self::Rational,
            6 => Self::SByte,
            7 => Self::Undefined,
            8 => Self::SShort,
            9 => Self::SLong,
            10 => Self::SRational,
            11 => Self::Float,
            12 => Self::Double,
            13 => Self::Ifd,
            _ => return None,
        })
    }

    const fn width(self) -> u64 {
        match self {
            Self::Byte | Self::Ascii | Self::SByte | Self::Undefined => 1,
            Self::Short | Self::SShort => 2,
            Self::Long | Self::SLong | Self::Float | Self::Ifd => 4,
            Self::Rational | Self::SRational | Self::Double => 8,
        }
    }
}

#[derive(Debug, Clone)]
struct Entry {
    tag: u16,
    field_type_raw: u16,
    field_type: Option<FieldType>,
    count: u32,
    data_offset: u64,
    byte_length: u64,
    inline: bool,
}

#[derive(Debug)]
struct Ifd {
    offset: u64,
    entries: BTreeMap<u16, Entry>,
}

struct TiffParser<'a> {
    bytes: &'a [u8],
    file_length: u64,
    endian: Endian,
    first_ifd_offset: u64,
    ifds: Vec<Ifd>,
    visited: HashSet<u64>,
    protected_ranges: Vec<(u64, u64)>,
    total_entries: u64,
    materialized_bytes: u64,
}

impl<'a> TiffParser<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, RawProbeError> {
        let file_length = u64::try_from(bytes.len()).map_err(|_| RawProbeError::ResourceLimit {
            resource: "file_length".into(),
            actual: u64::MAX,
            limit: u64::MAX,
        })?;
        if bytes.len() < 4 {
            return Err(RawProbeError::InputTooShort {
                needed: 4,
                actual: file_length,
            });
        }
        let endian = match &bytes[0..2] {
            b"II" => Endian::Little,
            b"MM" => Endian::Big,
            marker => {
                return Err(RawProbeError::InvalidByteOrder {
                    marker: [marker[0], marker[1]],
                })
            }
        };
        let magic = endian.read_u16(&bytes[2..4]);
        if magic == BIG_TIFF_MAGIC {
            return Err(RawProbeError::BigTiffUnsupported);
        }
        if magic != TIFF_MAGIC {
            return Err(RawProbeError::InvalidTiffMagic { magic });
        }
        if bytes.len() < 8 {
            return Err(RawProbeError::InputTooShort {
                needed: 8,
                actual: file_length,
            });
        }
        let first_ifd_offset = u64::from(endian.read_u32(&bytes[4..8]));
        Ok(Self {
            bytes,
            file_length,
            endian,
            first_ifd_offset,
            ifds: Vec::new(),
            visited: HashSet::new(),
            protected_ranges: vec![(0, 8)],
            total_entries: 0,
            materialized_bytes: 0,
        })
    }

    fn parse_graph(&mut self) -> Result<(), RawProbeError> {
        let mut pending = VecDeque::from([(self.first_ifd_offset, 0_u32)]);
        while let Some((offset, depth)) = pending.pop_front() {
            if offset == 0 {
                continue;
            }
            if depth > MAX_IFD_DEPTH {
                return Err(RawProbeError::IfdDepthExceeded {
                    depth,
                    limit: MAX_IFD_DEPTH,
                });
            }
            if !self.visited.insert(offset) {
                return Err(RawProbeError::IfdCycle { offset });
            }
            if u64::try_from(self.visited.len()).unwrap_or(u64::MAX) > MAX_IFDS {
                return Err(RawProbeError::ResourceLimit {
                    resource: "ifd_count".into(),
                    actual: u64::try_from(self.visited.len()).unwrap_or(u64::MAX),
                    limit: MAX_IFDS,
                });
            }
            let (ifd, next_offset) = self.parse_ifd(offset)?;
            if let Some(entry) = ifd.entries.get(&TAG_SUB_IFDS).cloned() {
                let sub_ifds =
                    self.decode_unsigned(&ifd, &entry, &[FieldType::Long, FieldType::Ifd])?;
                if u64::try_from(sub_ifds.len()).unwrap_or(u64::MAX) > MAX_SUB_IFDS {
                    return Err(RawProbeError::ResourceLimit {
                        resource: "sub_ifd_count".into(),
                        actual: u64::try_from(sub_ifds.len()).unwrap_or(u64::MAX),
                        limit: MAX_SUB_IFDS,
                    });
                }
                for sub_ifd in sub_ifds {
                    pending.push_back((sub_ifd, depth + 1));
                }
            }
            if next_offset != 0 {
                pending.push_back((next_offset, depth));
            }
            self.ifds.push(ifd);
        }
        Ok(())
    }

    fn parse_ifd(&mut self, offset: u64) -> Result<(Ifd, u64), RawProbeError> {
        let count_bytes = self.range(offset, 2, "IFD entry count")?;
        let entry_count = u64::from(self.endian.read_u16(count_bytes));
        if entry_count > MAX_ENTRIES_PER_IFD {
            return Err(RawProbeError::ResourceLimit {
                resource: "entries_per_ifd".into(),
                actual: entry_count,
                limit: MAX_ENTRIES_PER_IFD,
            });
        }
        self.total_entries = checked_add(self.total_entries, entry_count, "total IFD entries")?;
        if self.total_entries > MAX_TOTAL_ENTRIES {
            return Err(RawProbeError::ResourceLimit {
                resource: "total_ifd_entries".into(),
                actual: self.total_entries,
                limit: MAX_TOTAL_ENTRIES,
            });
        }

        let entries_bytes = checked_mul(entry_count, 12, "IFD entry table")?;
        let table_length = checked_add(
            checked_add(2, entries_bytes, "IFD table")?,
            4,
            "IFD next pointer",
        )?;
        self.range(offset, table_length, "IFD table")?;
        self.protected_ranges.push((offset, table_length));

        let mut entries = BTreeMap::new();
        for index in 0..entry_count {
            let entry_offset = checked_add(
                checked_add(offset, 2, "IFD entry offset")?,
                checked_mul(index, 12, "IFD entry offset")?,
                "IFD entry offset",
            )?;
            let raw = self.range(entry_offset, 12, "IFD entry")?;
            let tag = self.endian.read_u16(&raw[0..2]);
            let field_type_raw = self.endian.read_u16(&raw[2..4]);
            let field_type = FieldType::from_raw(field_type_raw);
            let count = self.endian.read_u32(&raw[4..8]);
            if entries.contains_key(&tag) {
                return Err(RawProbeError::DuplicateTag {
                    ifd_offset: offset,
                    tag,
                });
            }
            if is_recognized_tag(tag) && count == 0 {
                return Err(invalid_tag(offset, tag, "value count is zero"));
            }
            if is_recognized_tag(tag) && field_type.is_none() {
                return Err(RawProbeError::UnsupportedFieldType {
                    ifd_offset: offset,
                    tag,
                    field_type: field_type_raw,
                });
            }

            let (byte_length, data_offset, inline) = if let Some(field_type) = field_type {
                let byte_length = checked_mul(
                    u64::from(count),
                    field_type.width(),
                    "TIFF field byte length",
                )?;
                let inline = byte_length <= 4;
                let data_offset = if inline {
                    checked_add(entry_offset, 8, "inline TIFF value offset")?
                } else {
                    u64::from(self.endian.read_u32(&raw[8..12]))
                };
                self.range(data_offset, byte_length, "TIFF field value")?;
                if !inline && byte_length != 0 {
                    self.protected_ranges.push((data_offset, byte_length));
                }
                (byte_length, data_offset, inline)
            } else {
                (0, 0, false)
            };
            entries.insert(
                tag,
                Entry {
                    tag,
                    field_type_raw,
                    field_type,
                    count,
                    data_offset,
                    byte_length,
                    inline,
                },
            );
        }

        let next_pointer_offset = checked_add(
            checked_add(offset, 2, "next IFD pointer")?,
            entries_bytes,
            "next IFD pointer",
        )?;
        let next_offset = u64::from(self.endian.read_u32(self.range(
            next_pointer_offset,
            4,
            "next IFD pointer",
        )?));
        Ok((Ifd { offset, entries }, next_offset))
    }

    fn range(
        &self,
        offset: u64,
        byte_length: u64,
        context: &str,
    ) -> Result<&'a [u8], RawProbeError> {
        let end = checked_add(offset, byte_length, context)?;
        if end > self.file_length {
            return Err(RawProbeError::OutOfBounds {
                context: context.into(),
                offset,
                byte_length,
                file_length: self.file_length,
            });
        }
        let start = usize::try_from(offset).map_err(|_| RawProbeError::OutOfBounds {
            context: context.into(),
            offset,
            byte_length,
            file_length: self.file_length,
        })?;
        let end = usize::try_from(end).map_err(|_| RawProbeError::OutOfBounds {
            context: context.into(),
            offset,
            byte_length,
            file_length: self.file_length,
        })?;
        Ok(&self.bytes[start..end])
    }

    fn materialize(&mut self, ifd: &Ifd, entry: &Entry) -> Result<&'a [u8], RawProbeError> {
        if entry.byte_length > MAX_MATERIALIZED_FIELD_BYTES {
            return Err(RawProbeError::ResourceLimit {
                resource: format!("tag_{}_materialized_bytes", entry.tag),
                actual: entry.byte_length,
                limit: MAX_MATERIALIZED_FIELD_BYTES,
            });
        }
        self.materialized_bytes = checked_add(
            self.materialized_bytes,
            entry.byte_length,
            "materialized metadata bytes",
        )?;
        if self.materialized_bytes > MAX_TOTAL_MATERIALIZED_BYTES {
            return Err(RawProbeError::ResourceLimit {
                resource: "total_materialized_metadata_bytes".into(),
                actual: self.materialized_bytes,
                limit: MAX_TOTAL_MATERIALIZED_BYTES,
            });
        }
        self.range(
            entry.data_offset,
            entry.byte_length,
            &format!("tag {} in IFD {}", entry.tag, ifd.offset),
        )
    }

    fn decode_unsigned(
        &mut self,
        ifd: &Ifd,
        entry: &Entry,
        allowed: &[FieldType],
    ) -> Result<Vec<u64>, RawProbeError> {
        let field_type = require_type(ifd, entry, allowed)?;
        let endian = self.endian;
        let bytes = self.materialize(ifd, entry)?;
        let values = match field_type {
            FieldType::Byte | FieldType::Undefined => {
                bytes.iter().map(|&value| u64::from(value)).collect()
            }
            FieldType::Short => bytes
                .chunks_exact(2)
                .map(|value| u64::from(endian.read_u16(value)))
                .collect(),
            FieldType::Long | FieldType::Ifd => bytes
                .chunks_exact(4)
                .map(|value| u64::from(endian.read_u32(value)))
                .collect(),
            _ => {
                return Err(invalid_tag(
                    ifd.offset,
                    entry.tag,
                    "field is not unsigned integer data",
                ))
            }
        };
        Ok(values)
    }

    fn decode_rationals(
        &mut self,
        ifd: &Ifd,
        entry: &Entry,
        allowed: &[FieldType],
    ) -> Result<Vec<RawRational>, RawProbeError> {
        let field_type = require_type(ifd, entry, allowed)?;
        let endian = self.endian;
        let bytes = self.materialize(ifd, entry)?;
        match field_type {
            FieldType::Byte | FieldType::Undefined => Ok(bytes
                .iter()
                .map(|&value| RawRational {
                    num: i64::from(value),
                    den: 1,
                })
                .collect()),
            FieldType::Short => Ok(bytes
                .chunks_exact(2)
                .map(|value| RawRational {
                    num: i64::from(endian.read_u16(value)),
                    den: 1,
                })
                .collect()),
            FieldType::Long => Ok(bytes
                .chunks_exact(4)
                .map(|value| RawRational {
                    num: i64::from(endian.read_u32(value)),
                    den: 1,
                })
                .collect()),
            FieldType::SShort => Ok(bytes
                .chunks_exact(2)
                .map(|value| RawRational {
                    num: i64::from(endian.read_i16(value)),
                    den: 1,
                })
                .collect()),
            FieldType::SLong => Ok(bytes
                .chunks_exact(4)
                .map(|value| RawRational {
                    num: i64::from(endian.read_i32(value)),
                    den: 1,
                })
                .collect()),
            FieldType::Rational => bytes
                .chunks_exact(8)
                .enumerate()
                .map(|(index, value)| {
                    normalize_rational(
                        ifd.offset,
                        entry.tag,
                        index,
                        i64::from(endian.read_u32(&value[0..4])),
                        i64::from(endian.read_u32(&value[4..8])),
                    )
                })
                .collect(),
            FieldType::SRational => bytes
                .chunks_exact(8)
                .enumerate()
                .map(|(index, value)| {
                    normalize_rational(
                        ifd.offset,
                        entry.tag,
                        index,
                        i64::from(endian.read_i32(&value[0..4])),
                        i64::from(endian.read_i32(&value[4..8])),
                    )
                })
                .collect(),
            _ => Err(invalid_tag(
                ifd.offset,
                entry.tag,
                "field is not numeric data",
            )),
        }
    }

    fn decode_ascii(&mut self, ifd: &Ifd, entry: &Entry) -> Result<String, RawProbeError> {
        require_type(ifd, entry, &[FieldType::Ascii])?;
        if entry.byte_length > MAX_ASCII_BYTES {
            return Err(RawProbeError::ResourceLimit {
                resource: format!("tag_{}_ascii_bytes", entry.tag),
                actual: entry.byte_length,
                limit: MAX_ASCII_BYTES,
            });
        }
        let bytes = self.materialize(ifd, entry)?;
        if bytes.last() != Some(&0) {
            return Err(invalid_tag(
                ifd.offset,
                entry.tag,
                "ASCII value is not NUL terminated",
            ));
        }
        let content = &bytes[..bytes.len() - 1];
        if content.contains(&0) {
            return Err(invalid_tag(
                ifd.offset,
                entry.tag,
                "ASCII value contains an interior NUL",
            ));
        }
        if !content.is_ascii() {
            return Err(invalid_tag(
                ifd.offset,
                entry.tag,
                "ASCII value contains a non-ASCII byte",
            ));
        }
        Ok(String::from_utf8(content.to_vec()).expect("validated ASCII is UTF-8"))
    }
}

fn build_report(parser: &mut TiffParser<'_>) -> Result<RawProbeReport, RawProbeError> {
    let shared_ifd_index = 0;
    let dng_entry = parser
        .ifds
        .first()
        .and_then(|ifd| ifd.entries.get(&TAG_DNG_VERSION))
        .cloned()
        .ok_or(RawProbeError::NotDng)?;
    let dng_version = decode_version(parser, (shared_ifd_index, dng_entry))?;
    let dng_backward_version = parser.ifds[shared_ifd_index]
        .entries
        .get(&TAG_DNG_BACKWARD_VERSION)
        .cloned()
        .map(|entry| decode_version(parser, (shared_ifd_index, entry)))
        .transpose()?;

    let mut raw_ifds = Vec::new();
    for index in 0..parser.ifds.len() {
        if let Some(value) = optional_unsigned_scalar(
            parser,
            index,
            TAG_PHOTOMETRIC_INTERPRETATION,
            &[FieldType::Short],
        )? {
            if value == u64::from(PHOTOMETRIC_CFA) || value == u64::from(PHOTOMETRIC_LINEAR_RAW) {
                raw_ifds.push(index);
            }
        }
    }
    let raw_ifd_index = match raw_ifds.as_slice() {
        [] => return Err(RawProbeError::MissingRawIfd),
        [index] => *index,
        many => {
            return Err(RawProbeError::AmbiguousRawIfd {
                count: u32::try_from(many.len()).unwrap_or(u32::MAX),
            })
        }
    };

    let width = required_u32(
        parser,
        raw_ifd_index,
        TAG_IMAGE_WIDTH,
        &[FieldType::Short, FieldType::Long],
    )?;
    let height = required_u32(
        parser,
        raw_ifd_index,
        TAG_IMAGE_LENGTH,
        &[FieldType::Short, FieldType::Long],
    )?;
    if width == 0 || height == 0 {
        return Err(invalid_tag(
            parser.ifds[raw_ifd_index].offset,
            if width == 0 {
                TAG_IMAGE_WIDTH
            } else {
                TAG_IMAGE_LENGTH
            },
            "sensor dimension is zero",
        ));
    }
    let dimensions = RawDimensions { width, height };
    let sensor_pixels = checked_mul(u64::from(width), u64::from(height), "sensor pixel count")?;
    if sensor_pixels > MAX_SENSOR_PIXELS {
        return Err(RawProbeError::ResourceLimit {
            resource: "sensor_pixels".into(),
            actual: sensor_pixels,
            limit: MAX_SENSOR_PIXELS,
        });
    }

    let samples_per_pixel = optional_unsigned_scalar(
        parser,
        raw_ifd_index,
        TAG_SAMPLES_PER_PIXEL,
        &[FieldType::Short],
    )?
    .unwrap_or(1);
    let samples_per_pixel = u16::try_from(samples_per_pixel).map_err(|_| {
        invalid_tag(
            parser.ifds[raw_ifd_index].offset,
            TAG_SAMPLES_PER_PIXEL,
            "value does not fit u16",
        )
    })?;
    if samples_per_pixel == 0 {
        return Err(invalid_tag(
            parser.ifds[raw_ifd_index].offset,
            TAG_SAMPLES_PER_PIXEL,
            "value is zero",
        ));
    }
    let bits = required_unsigned(
        parser,
        raw_ifd_index,
        TAG_BITS_PER_SAMPLE,
        &[FieldType::Short],
    )?;
    if bits.len() != 1 && bits.len() != usize::from(samples_per_pixel) {
        return Err(invalid_tag(
            parser.ifds[raw_ifd_index].offset,
            TAG_BITS_PER_SAMPLE,
            "count must be one or SamplesPerPixel",
        ));
    }
    let bits_per_sample = bits
        .into_iter()
        .map(|value| {
            u16::try_from(value).map_err(|_| {
                invalid_tag(
                    parser.ifds[raw_ifd_index].offset,
                    TAG_BITS_PER_SAMPLE,
                    "value does not fit u16",
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if bits_per_sample
        .iter()
        .any(|&value| value == 0 || value > 32)
    {
        return Err(invalid_tag(
            parser.ifds[raw_ifd_index].offset,
            TAG_BITS_PER_SAMPLE,
            "supported bit depth is 1 through 32",
        ));
    }
    let compression_code =
        required_u16(parser, raw_ifd_index, TAG_COMPRESSION, &[FieldType::Short])?;
    let compression = tiff_compression(compression_code);

    let active_area = optional_rect(parser, raw_ifd_index, TAG_ACTIVE_AREA, dimensions)?;
    let masked_areas = masked_rects(parser, raw_ifd_index, dimensions)?;
    let default_crop = default_crop(
        parser,
        raw_ifd_index,
        active_area.unwrap_or(RawRect {
            top: 0,
            left: 0,
            bottom: height,
            right: width,
        }),
    )?;
    let cfa = cfa_pattern(parser, raw_ifd_index)?;
    let color_planes = cfa
        .as_ref()
        .map_or(usize::from(samples_per_pixel), |value| {
            value.plane_colors.len()
        });
    if color_planes == 0 {
        return Err(invalid_tag(
            parser.ifds[raw_ifd_index].offset,
            TAG_CFA_PLANE_COLOR,
            "colour-plane count is zero",
        ));
    }

    let black_level = black_level(parser, raw_ifd_index, samples_per_pixel)?;
    let white_level = required_rationals(
        parser,
        raw_ifd_index,
        TAG_WHITE_LEVEL,
        &[FieldType::Short, FieldType::Long],
    )?;
    if white_level.len() != 1 && white_level.len() != usize::from(samples_per_pixel) {
        return Err(invalid_tag(
            parser.ifds[raw_ifd_index].offset,
            TAG_WHITE_LEVEL,
            "count must be one or SamplesPerPixel",
        ));
    }
    validate_levels(
        parser.ifds[raw_ifd_index].offset,
        &bits_per_sample,
        samples_per_pixel,
        black_level.as_ref(),
        &white_level,
    )?;

    let as_shot_neutral = optional_rationals(
        parser,
        shared_ifd_index,
        TAG_AS_SHOT_NEUTRAL,
        &[FieldType::Short, FieldType::Rational],
    )?;
    if as_shot_neutral
        .as_ref()
        .is_some_and(|values| values.len() != color_planes)
    {
        return Err(invalid_tag(
            parser.ifds[shared_ifd_index].offset,
            TAG_AS_SHOT_NEUTRAL,
            "count must match colour-plane count",
        ));
    }
    let as_shot_white_xy = optional_rationals(
        parser,
        shared_ifd_index,
        TAG_AS_SHOT_WHITE_XY,
        &[FieldType::Rational],
    )?
    .map(|values| {
        vec_to_array_2(
            parser.ifds[shared_ifd_index].offset,
            TAG_AS_SHOT_WHITE_XY,
            values,
        )
    })
    .transpose()?;
    if as_shot_neutral.is_some() && as_shot_white_xy.is_some() {
        return Err(invalid_tag(
            parser.ifds[shared_ifd_index].offset,
            TAG_AS_SHOT_WHITE_XY,
            "AsShotNeutral and AsShotWhiteXY are mutually exclusive",
        ));
    }
    let analog_balance = optional_rationals(
        parser,
        shared_ifd_index,
        TAG_ANALOG_BALANCE,
        &[FieldType::Rational],
    )?;
    if analog_balance
        .as_ref()
        .is_some_and(|values| values.len() != color_planes)
    {
        return Err(invalid_tag(
            parser.ifds[shared_ifd_index].offset,
            TAG_ANALOG_BALANCE,
            "count must match colour-plane count",
        ));
    }

    let color_matrices = color_matrices(parser, shared_ifd_index, color_planes)?;
    let profile = profile_identity(parser, shared_ifd_index)?;
    let raw_data = data_refs(parser, raw_ifd_index, true)?;
    if raw_data.is_empty() {
        return Err(invalid_tag(
            parser.ifds[raw_ifd_index].offset,
            TAG_STRIP_OFFSETS,
            "raw IFD has no strip or tile data references",
        ));
    }
    validate_raw_storage(
        parser,
        raw_ifd_index,
        dimensions,
        samples_per_pixel,
        &raw_data,
    )?;
    let previews = preview_refs(parser, raw_ifd_index)?;
    let deferred_metadata = deferred_tags(parser)?;

    let max_bits = u64::from(
        *bits_per_sample
            .iter()
            .max()
            .expect("validated non-empty bits"),
    );
    let bytes_per_sample = max_bits.div_ceil(8);
    let estimated_unpacked_bytes = checked_mul(
        checked_mul(
            sensor_pixels,
            u64::from(samples_per_pixel),
            "unpacked sample count",
        )?,
        bytes_per_sample,
        "estimated unpacked bytes",
    )?;
    if estimated_unpacked_bytes > MAX_ESTIMATED_UNPACKED_BYTES {
        return Err(RawProbeError::ResourceLimit {
            resource: "estimated_unpacked_bytes".into(),
            actual: estimated_unpacked_bytes,
            limit: MAX_ESTIMATED_UNPACKED_BYTES,
        });
    }

    let camera = RawCameraIdentity {
        make: optional_ascii_from_preferred(parser, shared_ifd_index, TAG_MAKE)?,
        model: optional_ascii_from_preferred(parser, shared_ifd_index, TAG_MODEL)?,
        unique_camera_model: optional_ascii_from_preferred(
            parser,
            shared_ifd_index,
            TAG_UNIQUE_CAMERA_MODEL,
        )?,
    };
    let raw_data_unique_id =
        optional_hex_from_preferred(parser, shared_ifd_index, TAG_RAW_DATA_UNIQUE_ID, 16)?;
    let orientation = optional_unsigned_from_preferred(
        parser,
        shared_ifd_index,
        TAG_ORIENTATION,
        &[FieldType::Short],
    )?
    .map(|value| {
        u16::try_from(value).map_err(|_| {
            invalid_tag(
                parser.ifds[shared_ifd_index].offset,
                TAG_ORIENTATION,
                "value does not fit u16",
            )
        })
    })
    .transpose()?;
    if orientation.is_some_and(|value| !(1..=8).contains(&value)) {
        return Err(invalid_tag(
            parser.ifds[shared_ifd_index].offset,
            TAG_ORIENTATION,
            "orientation must be 1 through 8",
        ));
    }

    let mut diagnostics = Vec::new();
    add_missing_diagnostic(
        &mut diagnostics,
        active_area.is_none(),
        "missing_active_area",
        "DNG does not declare ActiveArea",
        TAG_ACTIVE_AREA,
        parser.ifds[raw_ifd_index].offset,
    );
    add_missing_diagnostic(
        &mut diagnostics,
        as_shot_neutral.is_none() && as_shot_white_xy.is_none(),
        "missing_as_shot_white_balance",
        "DNG does not declare AsShotNeutral or AsShotWhiteXY",
        TAG_AS_SHOT_NEUTRAL,
        parser.ifds[shared_ifd_index].offset,
    );
    add_missing_diagnostic(
        &mut diagnostics,
        color_matrices.is_empty(),
        "missing_camera_matrix",
        "DNG does not declare a camera colour matrix",
        TAG_COLOR_MATRIX_1,
        parser.ifds[shared_ifd_index].offset,
    );

    Ok(RawProbeReport {
        schema_version: RAW_PROBE_SCHEMA_VERSION,
        container: RawContainer::DngTiff,
        byte_order: Some(parser.endian.report_value()),
        source: RawSourceIdentity {
            byte_length: parser.file_length,
            embedded_unique_id: raw_data_unique_id,
        },
        camera,
        dng: Some(RawDngMetadata {
            version: dng_version,
            backward_version: dng_backward_version,
        }),
        dimensions,
        active_area,
        masked_areas,
        default_crop,
        orientation,
        bits_per_sample,
        compression,
        samples_per_pixel,
        cfa,
        black_level,
        white_level,
        as_shot_neutral,
        as_shot_white_xy,
        analog_balance,
        color_matrices,
        profile,
        raw_data,
        previews,
        deferred_metadata,
        metrics: RawProbeMetrics {
            elapsed_us: 0,
            metadata_bytes_materialized: parser.materialized_bytes,
            estimated_unpacked_bytes,
        },
        diagnostics,
    })
}

fn decode_version(
    parser: &mut TiffParser<'_>,
    location: (usize, Entry),
) -> Result<[u8; 4], RawProbeError> {
    let (ifd_index, entry) = location;
    let ifd = ifd_copy(parser, ifd_index);
    let values = parser.decode_unsigned(&ifd, &entry, &[FieldType::Byte])?;
    if values.len() != 4 {
        return Err(invalid_tag(
            ifd.offset,
            entry.tag,
            "DNG version must contain four bytes",
        ));
    }
    Ok([
        values[0] as u8,
        values[1] as u8,
        values[2] as u8,
        values[3] as u8,
    ])
}

fn required_unsigned(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    tag: u16,
    allowed: &[FieldType],
) -> Result<Vec<u64>, RawProbeError> {
    let ifd = ifd_copy(parser, ifd_index);
    let entry = ifd
        .entries
        .get(&tag)
        .cloned()
        .ok_or_else(|| invalid_tag(ifd.offset, tag, "required tag is missing"))?;
    parser.decode_unsigned(&ifd, &entry, allowed)
}

fn optional_unsigned(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    tag: u16,
    allowed: &[FieldType],
) -> Result<Option<Vec<u64>>, RawProbeError> {
    let ifd = ifd_copy(parser, ifd_index);
    if let Some(entry) = ifd.entries.get(&tag).cloned() {
        parser.decode_unsigned(&ifd, &entry, allowed).map(Some)
    } else {
        Ok(None)
    }
}

fn optional_unsigned_scalar(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    tag: u16,
    allowed: &[FieldType],
) -> Result<Option<u64>, RawProbeError> {
    optional_unsigned(parser, ifd_index, tag, allowed)?
        .map(|values| scalar(parser.ifds[ifd_index].offset, tag, values))
        .transpose()
}

fn required_u32(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    tag: u16,
    allowed: &[FieldType],
) -> Result<u32, RawProbeError> {
    let value = scalar(
        parser.ifds[ifd_index].offset,
        tag,
        required_unsigned(parser, ifd_index, tag, allowed)?,
    )?;
    u32::try_from(value)
        .map_err(|_| invalid_tag(parser.ifds[ifd_index].offset, tag, "value does not fit u32"))
}

fn required_u16(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    tag: u16,
    allowed: &[FieldType],
) -> Result<u16, RawProbeError> {
    let value = scalar(
        parser.ifds[ifd_index].offset,
        tag,
        required_unsigned(parser, ifd_index, tag, allowed)?,
    )?;
    u16::try_from(value)
        .map_err(|_| invalid_tag(parser.ifds[ifd_index].offset, tag, "value does not fit u16"))
}

fn optional_rationals(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    tag: u16,
    allowed: &[FieldType],
) -> Result<Option<Vec<RawRational>>, RawProbeError> {
    let ifd = ifd_copy(parser, ifd_index);
    if let Some(entry) = ifd.entries.get(&tag).cloned() {
        parser.decode_rationals(&ifd, &entry, allowed).map(Some)
    } else {
        Ok(None)
    }
}

fn required_rationals(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    tag: u16,
    allowed: &[FieldType],
) -> Result<Vec<RawRational>, RawProbeError> {
    optional_rationals(parser, ifd_index, tag, allowed)?.ok_or_else(|| {
        invalid_tag(
            parser.ifds[ifd_index].offset,
            tag,
            "required tag is missing",
        )
    })
}

fn optional_ascii(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    tag: u16,
) -> Result<Option<String>, RawProbeError> {
    let ifd = ifd_copy(parser, ifd_index);
    if let Some(entry) = ifd.entries.get(&tag).cloned() {
        parser.decode_ascii(&ifd, &entry).map(Some)
    } else {
        Ok(None)
    }
}

fn optional_ascii_from_preferred(
    parser: &mut TiffParser<'_>,
    raw_ifd_index: usize,
    tag: u16,
) -> Result<Option<String>, RawProbeError> {
    if parser.ifds[raw_ifd_index].entries.contains_key(&tag) {
        return optional_ascii(parser, raw_ifd_index, tag);
    }
    for index in 0..parser.ifds.len() {
        if parser.ifds[index].entries.contains_key(&tag) {
            return optional_ascii(parser, index, tag);
        }
    }
    Ok(None)
}

fn optional_hex_from_preferred(
    parser: &mut TiffParser<'_>,
    raw_ifd_index: usize,
    tag: u16,
    expected_count: usize,
) -> Result<Option<String>, RawProbeError> {
    let index = if parser.ifds[raw_ifd_index].entries.contains_key(&tag) {
        Some(raw_ifd_index)
    } else {
        (0..parser.ifds.len()).find(|&index| parser.ifds[index].entries.contains_key(&tag))
    };
    let Some(index) = index else {
        return Ok(None);
    };
    let values = required_unsigned(parser, index, tag, &[FieldType::Byte, FieldType::Undefined])?;
    if values.len() != expected_count {
        return Err(invalid_tag(
            parser.ifds[index].offset,
            tag,
            &format!("count must be {expected_count}"),
        ));
    }
    let mut encoded = String::with_capacity(expected_count * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for value in values {
        let value = u8::try_from(value).map_err(|_| {
            invalid_tag(
                parser.ifds[index].offset,
                tag,
                "identifier byte does not fit u8",
            )
        })?;
        encoded.push(char::from(HEX[usize::from(value >> 4)]));
        encoded.push(char::from(HEX[usize::from(value & 0x0f)]));
    }
    Ok(Some(encoded))
}

fn optional_unsigned_from_preferred(
    parser: &mut TiffParser<'_>,
    raw_ifd_index: usize,
    tag: u16,
    allowed: &[FieldType],
) -> Result<Option<u64>, RawProbeError> {
    if parser.ifds[raw_ifd_index].entries.contains_key(&tag) {
        return optional_unsigned_scalar(parser, raw_ifd_index, tag, allowed);
    }
    for index in 0..parser.ifds.len() {
        if parser.ifds[index].entries.contains_key(&tag) {
            return optional_unsigned_scalar(parser, index, tag, allowed);
        }
    }
    Ok(None)
}

fn optional_rect(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    tag: u16,
    dimensions: RawDimensions,
) -> Result<Option<RawRect>, RawProbeError> {
    optional_unsigned(parser, ifd_index, tag, &[FieldType::Short, FieldType::Long])?
        .map(|values| rect_from_values(parser.ifds[ifd_index].offset, tag, values, dimensions))
        .transpose()
}

fn masked_rects(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    dimensions: RawDimensions,
) -> Result<Vec<RawRect>, RawProbeError> {
    let Some(values) = optional_unsigned(
        parser,
        ifd_index,
        TAG_MASKED_AREAS,
        &[FieldType::Short, FieldType::Long],
    )?
    else {
        return Ok(Vec::new());
    };
    if values.len() % 4 != 0 {
        return Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_MASKED_AREAS,
            "count must be a multiple of four",
        ));
    }
    let rect_count = u64::try_from(values.len() / 4).unwrap_or(u64::MAX);
    if rect_count > MAX_MASKED_RECTS {
        return Err(RawProbeError::ResourceLimit {
            resource: "masked_area_count".into(),
            actual: rect_count,
            limit: MAX_MASKED_RECTS,
        });
    }
    values
        .chunks_exact(4)
        .map(|values| {
            rect_from_values(
                parser.ifds[ifd_index].offset,
                TAG_MASKED_AREAS,
                values.to_vec(),
                dimensions,
            )
        })
        .collect()
}

fn rect_from_values(
    ifd_offset: u64,
    tag: u16,
    values: Vec<u64>,
    dimensions: RawDimensions,
) -> Result<RawRect, RawProbeError> {
    if values.len() != 4 {
        return Err(invalid_tag(
            ifd_offset,
            tag,
            "rectangle must contain top, left, bottom, right",
        ));
    }
    let converted = values
        .into_iter()
        .map(|value| {
            u32::try_from(value)
                .map_err(|_| invalid_tag(ifd_offset, tag, "coordinate does not fit u32"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let rect = RawRect {
        top: converted[0],
        left: converted[1],
        bottom: converted[2],
        right: converted[3],
    };
    if rect.top >= rect.bottom || rect.left >= rect.right {
        return Err(invalid_tag(
            ifd_offset,
            tag,
            "rectangle is empty or reversed",
        ));
    }
    if rect.bottom > dimensions.height || rect.right > dimensions.width {
        return Err(invalid_tag(
            ifd_offset,
            tag,
            "rectangle exceeds sensor dimensions",
        ));
    }
    Ok(rect)
}

fn default_crop(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    active: RawRect,
) -> Result<Option<RawCrop>, RawProbeError> {
    let origin = optional_rationals(
        parser,
        ifd_index,
        TAG_DEFAULT_CROP_ORIGIN,
        &[FieldType::Short, FieldType::Long, FieldType::Rational],
    )?;
    let size = optional_rationals(
        parser,
        ifd_index,
        TAG_DEFAULT_CROP_SIZE,
        &[FieldType::Short, FieldType::Long, FieldType::Rational],
    )?;
    match (origin, size) {
        (None, None) => Ok(None),
        (Some(_), None) => Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_DEFAULT_CROP_SIZE,
            "crop origin requires crop size",
        )),
        (None, Some(_)) => Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_DEFAULT_CROP_ORIGIN,
            "crop size requires crop origin",
        )),
        (Some(origin), Some(size)) => {
            let origin = vec_to_array_2(
                parser.ifds[ifd_index].offset,
                TAG_DEFAULT_CROP_ORIGIN,
                origin,
            )?;
            let size = vec_to_array_2(parser.ifds[ifd_index].offset, TAG_DEFAULT_CROP_SIZE, size)?;
            for value in &origin {
                if rational_cmp(*value, RawRational { num: 0, den: 1 }).is_lt() {
                    return Err(invalid_tag(
                        parser.ifds[ifd_index].offset,
                        TAG_DEFAULT_CROP_ORIGIN,
                        "crop origin is negative",
                    ));
                }
            }
            for value in &size {
                if !rational_cmp(*value, RawRational { num: 0, den: 1 }).is_gt() {
                    return Err(invalid_tag(
                        parser.ifds[ifd_index].offset,
                        TAG_DEFAULT_CROP_SIZE,
                        "crop size is not positive",
                    ));
                }
            }
            let available = [
                u64::from(active.right - active.left),
                u64::from(active.bottom - active.top),
            ];
            for axis in 0..2 {
                let end = rational_add(origin[axis], size[axis]).ok_or_else(|| {
                    RawProbeError::ArithmeticOverflow {
                        context: "default crop extent".into(),
                    }
                })?;
                if rational_cmp(
                    end,
                    RawRational {
                        num: i64::try_from(available[axis]).unwrap_or(i64::MAX),
                        den: 1,
                    },
                )
                .is_gt()
                {
                    return Err(invalid_tag(
                        parser.ifds[ifd_index].offset,
                        TAG_DEFAULT_CROP_SIZE,
                        "crop exceeds ActiveArea",
                    ));
                }
            }
            Ok(Some(RawCrop { origin, size }))
        }
    }
}

fn cfa_pattern(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
) -> Result<Option<RawCfaPattern>, RawProbeError> {
    let photometric = required_u16(
        parser,
        ifd_index,
        TAG_PHOTOMETRIC_INTERPRETATION,
        &[FieldType::Short],
    )?;
    if photometric == PHOTOMETRIC_LINEAR_RAW {
        return Ok(None);
    }
    let repeat = required_unsigned(
        parser,
        ifd_index,
        TAG_CFA_REPEAT_PATTERN_DIM,
        &[FieldType::Short],
    )?;
    if repeat.len() != 2 {
        return Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_CFA_REPEAT_PATTERN_DIM,
            "count must be two",
        ));
    }
    let rows = u32::try_from(repeat[0]).map_err(|_| {
        invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_CFA_REPEAT_PATTERN_DIM,
            "row count does not fit u32",
        )
    })?;
    let columns = u32::try_from(repeat[1]).map_err(|_| {
        invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_CFA_REPEAT_PATTERN_DIM,
            "column count does not fit u32",
        )
    })?;
    if rows == 0 || columns == 0 {
        return Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_CFA_REPEAT_PATTERN_DIM,
            "repeat dimensions are zero",
        ));
    }
    let area = checked_mul(u64::from(rows), u64::from(columns), "CFA repeat area")?;
    if area > MAX_CFA_PATTERN_VALUES {
        return Err(RawProbeError::ResourceLimit {
            resource: "cfa_pattern_values".into(),
            actual: area,
            limit: MAX_CFA_PATTERN_VALUES,
        });
    }
    let pattern = required_unsigned(parser, ifd_index, TAG_CFA_PATTERN, &[FieldType::Byte])?;
    if u64::try_from(pattern.len()).unwrap_or(u64::MAX) != area {
        return Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_CFA_PATTERN,
            "count does not match CFA repeat area",
        ));
    }
    let plane_colors =
        required_unsigned(parser, ifd_index, TAG_CFA_PLANE_COLOR, &[FieldType::Byte])?;
    if plane_colors.is_empty() || plane_colors.len() > 16 {
        return Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_CFA_PLANE_COLOR,
            "colour-plane count must be 1 through 16",
        ));
    }
    if pattern
        .iter()
        .any(|&index| usize::try_from(index).unwrap_or(usize::MAX) >= plane_colors.len())
    {
        return Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_CFA_PATTERN,
            "pattern contains an out-of-range colour-plane index",
        ));
    }
    let layout = optional_unsigned_scalar(parser, ifd_index, TAG_CFA_LAYOUT, &[FieldType::Short])?
        .map(|value| {
            u16::try_from(value).map_err(|_| {
                invalid_tag(
                    parser.ifds[ifd_index].offset,
                    TAG_CFA_LAYOUT,
                    "value does not fit u16",
                )
            })
        })
        .transpose()?;
    Ok(Some(RawCfaPattern {
        repeat: RawGridSize { rows, columns },
        pattern: pattern.into_iter().map(|value| value as u8).collect(),
        plane_colors: plane_colors.into_iter().map(|value| value as u8).collect(),
        layout,
    }))
}

fn black_level(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    samples_per_pixel: u16,
) -> Result<Option<RawLevelGrid>, RawProbeError> {
    let repeat_values = optional_unsigned(
        parser,
        ifd_index,
        TAG_BLACK_LEVEL_REPEAT_DIM,
        &[FieldType::Short],
    )?;
    let repeat = if let Some(values) = repeat_values {
        if values.len() != 2 {
            return Err(invalid_tag(
                parser.ifds[ifd_index].offset,
                TAG_BLACK_LEVEL_REPEAT_DIM,
                "count must be two",
            ));
        }
        RawGridSize {
            rows: u32::try_from(values[0]).map_err(|_| {
                invalid_tag(
                    parser.ifds[ifd_index].offset,
                    TAG_BLACK_LEVEL_REPEAT_DIM,
                    "row count does not fit u32",
                )
            })?,
            columns: u32::try_from(values[1]).map_err(|_| {
                invalid_tag(
                    parser.ifds[ifd_index].offset,
                    TAG_BLACK_LEVEL_REPEAT_DIM,
                    "column count does not fit u32",
                )
            })?,
        }
    } else {
        RawGridSize {
            rows: 1,
            columns: 1,
        }
    };
    if repeat.rows == 0 || repeat.columns == 0 {
        return Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_BLACK_LEVEL_REPEAT_DIM,
            "repeat dimensions are zero",
        ));
    }
    let Some(values) = optional_rationals(
        parser,
        ifd_index,
        TAG_BLACK_LEVEL,
        &[FieldType::Short, FieldType::Long, FieldType::Rational],
    )?
    else {
        return Ok(None);
    };
    let expected = checked_mul(
        checked_mul(
            u64::from(repeat.rows),
            u64::from(repeat.columns),
            "black-level repeat area",
        )?,
        u64::from(samples_per_pixel),
        "black-level value count",
    )?;
    if u64::try_from(values.len()).unwrap_or(u64::MAX) != expected {
        return Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_BLACK_LEVEL,
            "count does not match repeat area times SamplesPerPixel",
        ));
    }
    Ok(Some(RawLevelGrid { repeat, values }))
}

fn validate_levels(
    ifd_offset: u64,
    bits: &[u16],
    samples_per_pixel: u16,
    black: Option<&RawLevelGrid>,
    white: &[RawRational],
) -> Result<(), RawProbeError> {
    for (index, value) in white.iter().copied().enumerate() {
        if !rational_cmp(value, RawRational { num: 0, den: 1 }).is_gt() {
            return Err(invalid_tag(
                ifd_offset,
                TAG_WHITE_LEVEL,
                "white level is not positive",
            ));
        }
        let bit_depth = if white.len() == 1 {
            *bits.iter().min().expect("validated non-empty bit depths")
        } else {
            bits[if bits.len() == 1 {
                0
            } else {
                index.min(bits.len() - 1)
            }]
        };
        let maximum = (1_u64 << u32::from(bit_depth)) - 1;
        if rational_cmp(
            value,
            RawRational {
                num: i64::try_from(maximum).unwrap_or(i64::MAX),
                den: 1,
            },
        )
        .is_gt()
        {
            return Err(invalid_tag(
                ifd_offset,
                TAG_WHITE_LEVEL,
                "white level exceeds declared bit depth",
            ));
        }
    }
    if let Some(black) = black {
        for (index, value) in black.values.iter().copied().enumerate() {
            let channel = index % usize::from(samples_per_pixel);
            let white = white[if white.len() == 1 { 0 } else { channel }];
            if !rational_cmp(value, white).is_lt() {
                return Err(invalid_tag(
                    ifd_offset,
                    TAG_BLACK_LEVEL,
                    "black level must be below white level",
                ));
            }
        }
    }
    Ok(())
}

fn color_matrices(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    color_planes: usize,
) -> Result<Vec<RawColorMatrix>, RawProbeError> {
    let illuminant_1 = optional_unsigned_scalar(
        parser,
        ifd_index,
        TAG_CALIBRATION_ILLUMINANT_1,
        &[FieldType::Short],
    )?
    .map(|value| {
        u16::try_from(value).map_err(|_| {
            invalid_tag(
                parser.ifds[ifd_index].offset,
                TAG_CALIBRATION_ILLUMINANT_1,
                "value does not fit u16",
            )
        })
    })
    .transpose()?;
    let illuminant_2 = optional_unsigned_scalar(
        parser,
        ifd_index,
        TAG_CALIBRATION_ILLUMINANT_2,
        &[FieldType::Short],
    )?
    .map(|value| {
        u16::try_from(value).map_err(|_| {
            invalid_tag(
                parser.ifds[ifd_index].offset,
                TAG_CALIBRATION_ILLUMINANT_2,
                "value does not fit u16",
            )
        })
    })
    .transpose()?;
    let specifications = [
        (
            TAG_COLOR_MATRIX_1,
            RawMatrixKind::ColorMatrix1,
            color_planes,
            3,
            illuminant_1,
        ),
        (
            TAG_COLOR_MATRIX_2,
            RawMatrixKind::ColorMatrix2,
            color_planes,
            3,
            illuminant_2,
        ),
        (
            TAG_CAMERA_CALIBRATION_1,
            RawMatrixKind::CameraCalibration1,
            color_planes,
            color_planes,
            illuminant_1,
        ),
        (
            TAG_CAMERA_CALIBRATION_2,
            RawMatrixKind::CameraCalibration2,
            color_planes,
            color_planes,
            illuminant_2,
        ),
        (
            TAG_REDUCTION_MATRIX_1,
            RawMatrixKind::ReductionMatrix1,
            3,
            color_planes,
            illuminant_1,
        ),
        (
            TAG_REDUCTION_MATRIX_2,
            RawMatrixKind::ReductionMatrix2,
            3,
            color_planes,
            illuminant_2,
        ),
        (
            TAG_FORWARD_MATRIX_1,
            RawMatrixKind::ForwardMatrix1,
            3,
            color_planes,
            illuminant_1,
        ),
        (
            TAG_FORWARD_MATRIX_2,
            RawMatrixKind::ForwardMatrix2,
            3,
            color_planes,
            illuminant_2,
        ),
    ];
    let mut matrices = Vec::new();
    for (tag, kind, rows, columns, calibration_illuminant) in specifications {
        if let Some(values) = optional_rationals(parser, ifd_index, tag, &[FieldType::SRational])? {
            let expected =
                rows.checked_mul(columns)
                    .ok_or_else(|| RawProbeError::ArithmeticOverflow {
                        context: "matrix dimensions".into(),
                    })?;
            if values.len() != expected {
                return Err(invalid_tag(
                    parser.ifds[ifd_index].offset,
                    tag,
                    "matrix count does not match colour-plane dimensions",
                ));
            }
            matrices.push(RawColorMatrix {
                kind,
                rows: u32::try_from(rows).map_err(|_| RawProbeError::ArithmeticOverflow {
                    context: "matrix rows".into(),
                })?,
                columns: u32::try_from(columns).map_err(|_| RawProbeError::ArithmeticOverflow {
                    context: "matrix columns".into(),
                })?,
                calibration_illuminant,
                values,
            });
        }
    }
    Ok(matrices)
}

fn profile_identity(
    parser: &mut TiffParser<'_>,
    raw_ifd_index: usize,
) -> Result<RawProfileIdentity, RawProbeError> {
    Ok(RawProfileIdentity {
        camera_calibration_signature: optional_ascii_from_preferred(
            parser,
            raw_ifd_index,
            TAG_CAMERA_CALIBRATION_SIGNATURE,
        )?,
        profile_calibration_signature: optional_ascii_from_preferred(
            parser,
            raw_ifd_index,
            TAG_PROFILE_CALIBRATION_SIGNATURE,
        )?,
        profile_name: optional_ascii_from_preferred(parser, raw_ifd_index, TAG_PROFILE_NAME)?,
        profile_embed_policy: optional_unsigned_from_preferred(
            parser,
            raw_ifd_index,
            TAG_PROFILE_EMBED_POLICY,
            &[FieldType::Long],
        )?
        .map(|value| {
            u32::try_from(value).map_err(|_| {
                invalid_tag(
                    parser.ifds[raw_ifd_index].offset,
                    TAG_PROFILE_EMBED_POLICY,
                    "value does not fit u32",
                )
            })
        })
        .transpose()?,
    })
}

fn data_refs(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    raw: bool,
) -> Result<Vec<RawDataRef>, RawProbeError> {
    let strips = paired_data_refs(
        parser,
        ifd_index,
        TAG_STRIP_OFFSETS,
        TAG_STRIP_BYTE_COUNTS,
        RawDataLayout::Strip,
    )?;
    let tiles = paired_data_refs(
        parser,
        ifd_index,
        TAG_TILE_OFFSETS,
        TAG_TILE_BYTE_COUNTS,
        RawDataLayout::Tile,
    )?;
    if !strips.is_empty() && !tiles.is_empty() {
        return Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_TILE_OFFSETS,
            "IFD declares both strip and tile payloads",
        ));
    }
    let jpeg_offset = optional_unsigned_scalar(
        parser,
        ifd_index,
        TAG_JPEG_INTERCHANGE_FORMAT,
        &[FieldType::Long],
    )?;
    let jpeg_length = optional_unsigned_scalar(
        parser,
        ifd_index,
        TAG_JPEG_INTERCHANGE_FORMAT_LENGTH,
        &[FieldType::Long],
    )?;
    let mut refs = if strips.is_empty() { tiles } else { strips };
    match (jpeg_offset, jpeg_length) {
        (None, None) => {}
        (Some(_), None) | (None, Some(_)) => {
            return Err(invalid_tag(
                parser.ifds[ifd_index].offset,
                TAG_JPEG_INTERCHANGE_FORMAT,
                "JPEG offset and length must both be present",
            ))
        }
        (Some(offset), Some(byte_count)) => {
            validate_payload_range(
                parser,
                parser.ifds[ifd_index].offset,
                TAG_JPEG_INTERCHANGE_FORMAT,
                offset,
                byte_count,
            )?;
            refs.push(RawDataRef {
                layout: RawDataLayout::JpegInterchange,
                index: 0,
                offset,
                byte_count,
            });
        }
    }
    if raw
        && refs
            .iter()
            .any(|value| value.layout == RawDataLayout::JpegInterchange)
    {
        return Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            TAG_JPEG_INTERCHANGE_FORMAT,
            "raw payload cannot use the preview JPEG reference",
        ));
    }
    Ok(refs)
}

fn validate_raw_storage(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    dimensions: RawDimensions,
    samples_per_pixel: u16,
    data: &[RawDataRef],
) -> Result<(), RawProbeError> {
    let ifd_offset = parser.ifds[ifd_index].offset;
    let planar_configuration = optional_unsigned_scalar(
        parser,
        ifd_index,
        TAG_PLANAR_CONFIGURATION,
        &[FieldType::Short],
    )?
    .unwrap_or(1);
    if !matches!(planar_configuration, 1 | 2) {
        return Err(invalid_tag(
            ifd_offset,
            TAG_PLANAR_CONFIGURATION,
            "value must be chunky (1) or planar (2)",
        ));
    }

    if let Some(sample_format) =
        optional_unsigned(parser, ifd_index, TAG_SAMPLE_FORMAT, &[FieldType::Short])?
    {
        if sample_format.len() != 1 && sample_format.len() != usize::from(samples_per_pixel) {
            return Err(invalid_tag(
                ifd_offset,
                TAG_SAMPLE_FORMAT,
                "count must be one or SamplesPerPixel",
            ));
        }
        if sample_format.iter().any(|&value| value != 1) {
            return Err(invalid_tag(
                ifd_offset,
                TAG_SAMPLE_FORMAT,
                "R0-A accepts only unsigned integer sensor samples",
            ));
        }
    }

    let planes = if planar_configuration == 2 {
        u64::from(samples_per_pixel)
    } else {
        1
    };
    let expected_ranges = match data.first().map(|value| value.layout) {
        Some(RawDataLayout::Strip) => {
            let rows = optional_unsigned_scalar(
                parser,
                ifd_index,
                TAG_ROWS_PER_STRIP,
                &[FieldType::Short, FieldType::Long],
            )?
            .unwrap_or(u64::from(dimensions.height));
            if rows == 0 {
                return Err(invalid_tag(ifd_offset, TAG_ROWS_PER_STRIP, "value is zero"));
            }
            u64::from(dimensions.height).div_ceil(rows) * planes
        }
        Some(RawDataLayout::Tile) => {
            let tile_width = optional_unsigned_scalar(
                parser,
                ifd_index,
                TAG_TILE_WIDTH,
                &[FieldType::Short, FieldType::Long],
            )?
            .ok_or_else(|| {
                invalid_tag(ifd_offset, TAG_TILE_WIDTH, "tiled IFD is missing TileWidth")
            })?;
            let tile_height = optional_unsigned_scalar(
                parser,
                ifd_index,
                TAG_TILE_LENGTH,
                &[FieldType::Short, FieldType::Long],
            )?
            .ok_or_else(|| {
                invalid_tag(
                    ifd_offset,
                    TAG_TILE_LENGTH,
                    "tiled IFD is missing TileLength",
                )
            })?;
            if tile_width == 0 || tile_height == 0 {
                return Err(invalid_tag(
                    ifd_offset,
                    if tile_width == 0 {
                        TAG_TILE_WIDTH
                    } else {
                        TAG_TILE_LENGTH
                    },
                    "tile dimension is zero",
                ));
            }
            checked_mul(
                u64::from(dimensions.width).div_ceil(tile_width),
                u64::from(dimensions.height).div_ceil(tile_height),
                "tile grid",
            )?
            .checked_mul(planes)
            .ok_or_else(|| RawProbeError::ArithmeticOverflow {
                context: "planar tile count".into(),
            })?
        }
        Some(RawDataLayout::JpegInterchange | RawDataLayout::ContainerSegment) => {
            return Err(invalid_tag(
                ifd_offset,
                TAG_JPEG_INTERCHANGE_FORMAT,
                "raw IFD cannot use a preview JPEG reference",
            ))
        }
        None => return Ok(()),
    };
    let actual_ranges = u64::try_from(data.len()).unwrap_or(u64::MAX);
    if actual_ranges != expected_ranges {
        return Err(invalid_tag(
            ifd_offset,
            match data[0].layout {
                RawDataLayout::Strip => TAG_STRIP_OFFSETS,
                RawDataLayout::Tile => TAG_TILE_OFFSETS,
                RawDataLayout::JpegInterchange | RawDataLayout::ContainerSegment => {
                    TAG_JPEG_INTERCHANGE_FORMAT
                }
            },
            "payload range count does not match the declared image geometry",
        ));
    }
    let mut ordered_ranges = data
        .iter()
        .map(|value| (value.offset, value.byte_count))
        .collect::<Vec<_>>();
    ordered_ranges.sort_unstable_by_key(|value| value.0);
    for pair in ordered_ranges.windows(2) {
        if ranges_overlap(pair[0].0, pair[0].1, pair[1].0, pair[1].1)? {
            return Err(invalid_tag(
                ifd_offset,
                match data[0].layout {
                    RawDataLayout::Strip => TAG_STRIP_OFFSETS,
                    RawDataLayout::Tile => TAG_TILE_OFFSETS,
                    RawDataLayout::JpegInterchange | RawDataLayout::ContainerSegment => {
                        TAG_JPEG_INTERCHANGE_FORMAT
                    }
                },
                "image payload ranges overlap",
            ));
        }
    }
    Ok(())
}

fn paired_data_refs(
    parser: &mut TiffParser<'_>,
    ifd_index: usize,
    offsets_tag: u16,
    counts_tag: u16,
    layout: RawDataLayout,
) -> Result<Vec<RawDataRef>, RawProbeError> {
    let offsets = optional_unsigned(
        parser,
        ifd_index,
        offsets_tag,
        &[FieldType::Short, FieldType::Long],
    )?;
    let counts = optional_unsigned(
        parser,
        ifd_index,
        counts_tag,
        &[FieldType::Short, FieldType::Long],
    )?;
    let (offsets, counts) = match (offsets, counts) {
        (None, None) => return Ok(Vec::new()),
        (Some(_), None) | (None, Some(_)) => {
            return Err(invalid_tag(
                parser.ifds[ifd_index].offset,
                offsets_tag,
                "offset and byte-count arrays must both be present",
            ))
        }
        (Some(offsets), Some(counts)) => (offsets, counts),
    };
    if offsets.len() != counts.len() {
        return Err(invalid_tag(
            parser.ifds[ifd_index].offset,
            offsets_tag,
            "offset and byte-count arrays have different lengths",
        ));
    }
    let count = u64::try_from(offsets.len()).unwrap_or(u64::MAX);
    if count > MAX_DATA_RANGES {
        return Err(RawProbeError::ResourceLimit {
            resource: "strip_or_tile_ranges".into(),
            actual: count,
            limit: MAX_DATA_RANGES,
        });
    }
    offsets
        .into_iter()
        .zip(counts)
        .enumerate()
        .map(|(index, (offset, byte_count))| {
            validate_payload_range(
                parser,
                parser.ifds[ifd_index].offset,
                offsets_tag,
                offset,
                byte_count,
            )?;
            Ok(RawDataRef {
                layout,
                index: u32::try_from(index).unwrap_or(u32::MAX),
                offset,
                byte_count,
            })
        })
        .collect()
}

fn validate_payload_range(
    parser: &TiffParser<'_>,
    ifd_offset: u64,
    tag: u16,
    offset: u64,
    byte_count: u64,
) -> Result<(), RawProbeError> {
    if byte_count == 0 {
        return Err(invalid_tag(ifd_offset, tag, "payload byte count is zero"));
    }
    parser.range(offset, byte_count, "referenced image payload")?;
    for &(protected_offset, protected_length) in &parser.protected_ranges {
        if ranges_overlap(offset, byte_count, protected_offset, protected_length)? {
            return Err(invalid_tag(
                ifd_offset,
                tag,
                "referenced image payload overlaps TIFF metadata",
            ));
        }
    }
    Ok(())
}

fn preview_refs(
    parser: &mut TiffParser<'_>,
    raw_ifd_index: usize,
) -> Result<Vec<RawPreviewRef>, RawProbeError> {
    let mut previews = Vec::new();
    for index in 0..parser.ifds.len() {
        if index == raw_ifd_index {
            continue;
        }
        let data = data_refs(parser, index, false)?;
        if data.is_empty() {
            continue;
        }
        let width = optional_unsigned_scalar(
            parser,
            index,
            TAG_IMAGE_WIDTH,
            &[FieldType::Short, FieldType::Long],
        )?;
        let height = optional_unsigned_scalar(
            parser,
            index,
            TAG_IMAGE_LENGTH,
            &[FieldType::Short, FieldType::Long],
        )?;
        let dimensions = match (width, height) {
            (None, None) => None,
            (Some(_), None) | (None, Some(_)) => {
                return Err(invalid_tag(
                    parser.ifds[index].offset,
                    TAG_IMAGE_WIDTH,
                    "preview width and height must both be present",
                ))
            }
            (Some(width), Some(height)) => {
                let width = u32::try_from(width).map_err(|_| {
                    invalid_tag(
                        parser.ifds[index].offset,
                        TAG_IMAGE_WIDTH,
                        "value does not fit u32",
                    )
                })?;
                let height = u32::try_from(height).map_err(|_| {
                    invalid_tag(
                        parser.ifds[index].offset,
                        TAG_IMAGE_LENGTH,
                        "value does not fit u32",
                    )
                })?;
                if width == 0 || height == 0 {
                    return Err(invalid_tag(
                        parser.ifds[index].offset,
                        TAG_IMAGE_WIDTH,
                        "preview dimension is zero",
                    ));
                }
                Some(RawDimensions { width, height })
            }
        };
        let new_subfile_type =
            optional_unsigned_scalar(parser, index, TAG_NEW_SUBFILE_TYPE, &[FieldType::Long])?
                .unwrap_or(0);
        let compression =
            optional_unsigned_scalar(parser, index, TAG_COMPRESSION, &[FieldType::Short])?
                .map(|value| {
                    u16::try_from(value).map(tiff_compression).map_err(|_| {
                        invalid_tag(
                            parser.ifds[index].offset,
                            TAG_COMPRESSION,
                            "value does not fit u16",
                        )
                    })
                })
                .transpose()?;
        let photometric_interpretation = optional_unsigned_scalar(
            parser,
            index,
            TAG_PHOTOMETRIC_INTERPRETATION,
            &[FieldType::Short],
        )?
        .map(|value| {
            u16::try_from(value).map_err(|_| {
                invalid_tag(
                    parser.ifds[index].offset,
                    TAG_PHOTOMETRIC_INTERPRETATION,
                    "value does not fit u16",
                )
            })
        })
        .transpose()?;
        previews.push(RawPreviewRef {
            ifd_offset: parser.ifds[index].offset,
            kind: if new_subfile_type & 1 != 0 {
                RawPreviewKind::Thumbnail
            } else {
                RawPreviewKind::Preview
            },
            dimensions,
            compression,
            photometric_interpretation,
            data,
        });
    }
    Ok(previews)
}

fn deferred_tags(parser: &TiffParser<'_>) -> Result<Vec<RawDeferredTagRef>, RawProbeError> {
    let mut values = Vec::new();
    for ifd in &parser.ifds {
        for tag in [
            TAG_LINEARIZATION_TABLE,
            TAG_BLACK_LEVEL_DELTA_H,
            TAG_BLACK_LEVEL_DELTA_V,
        ] {
            if let Some(entry) = ifd.entries.get(&tag) {
                let expected_type = if tag == TAG_LINEARIZATION_TABLE {
                    FieldType::Short
                } else {
                    FieldType::SRational
                };
                require_type(ifd, entry, &[expected_type])?;
                values.push(RawDeferredTagRef {
                    ifd_offset: ifd.offset,
                    tag,
                    field_type: entry.field_type_raw,
                    count: u64::from(entry.count),
                    value_offset: entry.data_offset,
                    value_byte_length: entry.byte_length,
                    inline: entry.inline,
                });
            }
        }
    }
    Ok(values)
}

fn ifd_copy(parser: &TiffParser<'_>, index: usize) -> Ifd {
    Ifd {
        offset: parser.ifds[index].offset,
        entries: parser.ifds[index].entries.clone(),
    }
}

fn require_type(
    ifd: &Ifd,
    entry: &Entry,
    allowed: &[FieldType],
) -> Result<FieldType, RawProbeError> {
    let Some(field_type) = entry.field_type else {
        return Err(RawProbeError::UnsupportedFieldType {
            ifd_offset: ifd.offset,
            tag: entry.tag,
            field_type: entry.field_type_raw,
        });
    };
    if !allowed.contains(&field_type) {
        return Err(invalid_tag(
            ifd.offset,
            entry.tag,
            &format!("field type {} is not allowed", entry.field_type_raw),
        ));
    }
    Ok(field_type)
}

fn scalar(ifd_offset: u64, tag: u16, values: Vec<u64>) -> Result<u64, RawProbeError> {
    if values.len() != 1 {
        return Err(invalid_tag(ifd_offset, tag, "count must be one"));
    }
    Ok(values[0])
}

fn vec_to_array_2(
    ifd_offset: u64,
    tag: u16,
    values: Vec<RawRational>,
) -> Result<[RawRational; 2], RawProbeError> {
    values
        .try_into()
        .map_err(|_| invalid_tag(ifd_offset, tag, "count must be two"))
}

fn normalize_rational(
    ifd_offset: u64,
    tag: u16,
    index: usize,
    mut num: i64,
    mut den: i64,
) -> Result<RawRational, RawProbeError> {
    if den == 0 {
        return Err(RawProbeError::ZeroRationalDenominator {
            ifd_offset,
            tag,
            index: u32::try_from(index).unwrap_or(u32::MAX),
        });
    }
    if den < 0 {
        num = -num;
        den = -den;
    }
    Ok(RawRational { num, den })
}

fn rational_cmp(left: RawRational, right: RawRational) -> std::cmp::Ordering {
    (i128::from(left.num) * i128::from(right.den))
        .cmp(&(i128::from(right.num) * i128::from(left.den)))
}

fn rational_add(left: RawRational, right: RawRational) -> Option<RawRational> {
    let num = i128::from(left.num)
        .checked_mul(i128::from(right.den))?
        .checked_add(i128::from(right.num).checked_mul(i128::from(left.den))?)?;
    let den = i128::from(left.den).checked_mul(i128::from(right.den))?;
    Some(RawRational {
        num: i64::try_from(num).ok()?,
        den: i64::try_from(den).ok()?,
    })
}

fn add_missing_diagnostic(
    diagnostics: &mut Vec<RawProbeDiagnostic>,
    missing: bool,
    code: &str,
    message: &str,
    tag: u16,
    ifd_offset: u64,
) {
    if missing {
        diagnostics.push(RawProbeDiagnostic {
            severity: RawProbeDiagnosticSeverity::Warning,
            code: code.into(),
            message: message.into(),
            tag: Some(tag),
            ifd_offset: Some(ifd_offset),
        });
    }
}

fn is_recognized_tag(tag: u16) -> bool {
    matches!(
        tag,
        TAG_NEW_SUBFILE_TYPE
            | TAG_IMAGE_WIDTH
            | TAG_IMAGE_LENGTH
            | TAG_BITS_PER_SAMPLE
            | TAG_COMPRESSION
            | TAG_PHOTOMETRIC_INTERPRETATION
            | TAG_MAKE
            | TAG_MODEL
            | TAG_STRIP_OFFSETS
            | TAG_ORIENTATION
            | TAG_SAMPLES_PER_PIXEL
            | TAG_ROWS_PER_STRIP
            | TAG_STRIP_BYTE_COUNTS
            | TAG_PLANAR_CONFIGURATION
            | TAG_TILE_WIDTH
            | TAG_TILE_LENGTH
            | TAG_TILE_OFFSETS
            | TAG_TILE_BYTE_COUNTS
            | TAG_SUB_IFDS
            | TAG_SAMPLE_FORMAT
            | TAG_JPEG_INTERCHANGE_FORMAT
            | TAG_JPEG_INTERCHANGE_FORMAT_LENGTH
            | TAG_CFA_REPEAT_PATTERN_DIM
            | TAG_CFA_PATTERN
            | TAG_DNG_VERSION
            | TAG_DNG_BACKWARD_VERSION
            | TAG_UNIQUE_CAMERA_MODEL
            | TAG_CFA_PLANE_COLOR
            | TAG_CFA_LAYOUT
            | TAG_LINEARIZATION_TABLE
            | TAG_BLACK_LEVEL_REPEAT_DIM
            | TAG_BLACK_LEVEL
            | TAG_BLACK_LEVEL_DELTA_H
            | TAG_BLACK_LEVEL_DELTA_V
            | TAG_WHITE_LEVEL
            | TAG_DEFAULT_CROP_ORIGIN
            | TAG_DEFAULT_CROP_SIZE
            | TAG_COLOR_MATRIX_1
            | TAG_COLOR_MATRIX_2
            | TAG_CAMERA_CALIBRATION_1
            | TAG_CAMERA_CALIBRATION_2
            | TAG_REDUCTION_MATRIX_1
            | TAG_REDUCTION_MATRIX_2
            | TAG_ANALOG_BALANCE
            | TAG_AS_SHOT_NEUTRAL
            | TAG_AS_SHOT_WHITE_XY
            | TAG_CALIBRATION_ILLUMINANT_1
            | TAG_CALIBRATION_ILLUMINANT_2
            | TAG_RAW_DATA_UNIQUE_ID
            | TAG_ACTIVE_AREA
            | TAG_MASKED_AREAS
            | TAG_CAMERA_CALIBRATION_SIGNATURE
            | TAG_PROFILE_CALIBRATION_SIGNATURE
            | TAG_PROFILE_NAME
            | TAG_PROFILE_EMBED_POLICY
            | TAG_FORWARD_MATRIX_1
            | TAG_FORWARD_MATRIX_2
    )
}

fn checked_add(left: u64, right: u64, context: &str) -> Result<u64, RawProbeError> {
    left.checked_add(right)
        .ok_or_else(|| RawProbeError::ArithmeticOverflow {
            context: context.into(),
        })
}

fn tiff_compression(code: u16) -> RawCompression {
    let description = match code {
        1 => Some("uncompressed"),
        7 => Some("jpeg"),
        8 => Some("deflate"),
        34_892 => Some("lossy_jpeg"),
        _ => None,
    };
    RawCompression {
        code: u32::from(code),
        description: description.map(str::to_owned),
    }
}

fn checked_mul(left: u64, right: u64, context: &str) -> Result<u64, RawProbeError> {
    left.checked_mul(right)
        .ok_or_else(|| RawProbeError::ArithmeticOverflow {
            context: context.into(),
        })
}

fn ranges_overlap(
    left_offset: u64,
    left_length: u64,
    right_offset: u64,
    right_length: u64,
) -> Result<bool, RawProbeError> {
    let left_end = checked_add(left_offset, left_length, "payload range end")?;
    let right_end = checked_add(right_offset, right_length, "metadata range end")?;
    Ok(left_offset < right_end && right_offset < left_end)
}

fn invalid_tag(ifd_offset: u64, tag: u16, reason: &str) -> RawProbeError {
    RawProbeError::InvalidTag {
        ifd_offset,
        tag,
        reason: reason.into(),
    }
}
