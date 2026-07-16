use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum RawProbeError {
    InputTooShort {
        #[serde(with = "decimal_u64")]
        needed: u64,
        #[serde(with = "decimal_u64")]
        actual: u64,
    },
    InvalidByteOrder {
        marker: [u8; 2],
    },
    InvalidTiffMagic {
        magic: u16,
    },
    BigTiffUnsupported,
    ArithmeticOverflow {
        context: String,
    },
    OutOfBounds {
        context: String,
        #[serde(with = "decimal_u64")]
        offset: u64,
        #[serde(with = "decimal_u64")]
        byte_length: u64,
        #[serde(with = "decimal_u64")]
        file_length: u64,
    },
    ResourceLimit {
        resource: String,
        #[serde(with = "decimal_u64")]
        actual: u64,
        #[serde(with = "decimal_u64")]
        limit: u64,
    },
    IfdCycle {
        #[serde(with = "decimal_u64")]
        offset: u64,
    },
    IfdDepthExceeded {
        depth: u32,
        limit: u32,
    },
    DuplicateTag {
        #[serde(with = "decimal_u64")]
        ifd_offset: u64,
        tag: u16,
    },
    UnsupportedFieldType {
        #[serde(with = "decimal_u64")]
        ifd_offset: u64,
        tag: u16,
        field_type: u16,
    },
    InvalidTag {
        #[serde(with = "decimal_u64")]
        ifd_offset: u64,
        tag: u16,
        reason: String,
    },
    ZeroRationalDenominator {
        #[serde(with = "decimal_u64")]
        ifd_offset: u64,
        tag: u16,
        index: u32,
    },
    NotDng,
    MissingRawIfd,
    AmbiguousRawIfd {
        count: u32,
    },
}

impl fmt::Display for RawProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooShort { needed, actual } => {
                write!(
                    formatter,
                    "input is truncated: need {needed} bytes, got {actual}"
                )
            }
            Self::InvalidByteOrder { marker } => {
                write!(formatter, "invalid TIFF byte-order marker: {marker:02x?}")
            }
            Self::InvalidTiffMagic { magic } => write!(formatter, "invalid TIFF magic {magic}"),
            Self::BigTiffUnsupported => write!(formatter, "BigTIFF is not supported by R0-A"),
            Self::ArithmeticOverflow { context } => {
                write!(formatter, "arithmetic overflow while calculating {context}")
            }
            Self::OutOfBounds {
                context,
                offset,
                byte_length,
                file_length,
            } => write!(
                formatter,
                "{context} range {offset}+{byte_length} exceeds file length {file_length}"
            ),
            Self::ResourceLimit {
                resource,
                actual,
                limit,
            } => write!(formatter, "{resource} {actual} exceeds limit {limit}"),
            Self::IfdCycle { offset } => write!(formatter, "IFD cycle at offset {offset}"),
            Self::IfdDepthExceeded { depth, limit } => {
                write!(formatter, "IFD depth {depth} exceeds limit {limit}")
            }
            Self::DuplicateTag { ifd_offset, tag } => {
                write!(formatter, "duplicate TIFF tag {tag} in IFD {ifd_offset}")
            }
            Self::UnsupportedFieldType {
                ifd_offset,
                tag,
                field_type,
            } => write!(
                formatter,
                "unsupported field type {field_type} for tag {tag} in IFD {ifd_offset}"
            ),
            Self::InvalidTag {
                ifd_offset,
                tag,
                reason,
            } => write!(formatter, "invalid tag {tag} in IFD {ifd_offset}: {reason}"),
            Self::ZeroRationalDenominator {
                ifd_offset,
                tag,
                index,
            } => write!(
                formatter,
                "zero denominator at value {index} for tag {tag} in IFD {ifd_offset}"
            ),
            Self::NotDng => write!(formatter, "TIFF container has no DNGVersion tag"),
            Self::MissingRawIfd => write!(formatter, "DNG has no CFA or LinearRaw IFD"),
            Self::AmbiguousRawIfd { count } => {
                write!(formatter, "DNG has {count} candidate raw IFDs")
            }
        }
    }
}

impl std::error::Error for RawProbeError {}

mod decimal_u64 {
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
