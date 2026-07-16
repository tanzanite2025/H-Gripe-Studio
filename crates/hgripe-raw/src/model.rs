use serde::{Deserialize, Serialize};

pub const RAW_PROBE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawContainer {
    DngTiff,
    CanonCr2,
    CanonCr3,
    NikonNef,
    SonyArw,
    FujifilmRaf,
    OlympusOrf,
    PanasonicRw2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawByteOrder {
    LittleEndian,
    BigEndian,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawSourceIdentity {
    #[serde(with = "decimal_u64")]
    pub byte_length: u64,
    pub embedded_unique_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawDngMetadata {
    pub version: [u8; 4],
    pub backward_version: Option<[u8; 4]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RawCameraIdentity {
    pub make: Option<String>,
    pub model: Option<String>,
    pub unique_camera_model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawDimensions {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawRect {
    pub top: u32,
    pub left: u32,
    pub bottom: u32,
    pub right: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawGridSize {
    pub rows: u32,
    pub columns: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawRational {
    pub num: i64,
    pub den: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawCrop {
    pub origin: [RawRational; 2],
    pub size: [RawRational; 2],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawCfaPattern {
    pub repeat: RawGridSize,
    pub pattern: Vec<u8>,
    pub plane_colors: Vec<u8>,
    pub layout: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawLevelGrid {
    pub repeat: RawGridSize,
    pub values: Vec<RawRational>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawCompression {
    pub code: u32,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawMatrixKind {
    ColorMatrix1,
    ColorMatrix2,
    CameraCalibration1,
    CameraCalibration2,
    ReductionMatrix1,
    ReductionMatrix2,
    ForwardMatrix1,
    ForwardMatrix2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawColorMatrix {
    pub kind: RawMatrixKind,
    pub rows: u32,
    pub columns: u32,
    pub calibration_illuminant: Option<u16>,
    pub values: Vec<RawRational>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RawProfileIdentity {
    pub camera_calibration_signature: Option<String>,
    pub profile_calibration_signature: Option<String>,
    pub profile_name: Option<String>,
    pub profile_embed_policy: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawDataLayout {
    Strip,
    Tile,
    JpegInterchange,
    ContainerSegment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawDataRef {
    pub layout: RawDataLayout,
    pub index: u32,
    #[serde(with = "decimal_u64")]
    pub offset: u64,
    #[serde(with = "decimal_u64")]
    pub byte_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawPreviewKind {
    Thumbnail,
    Preview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawPreviewRef {
    #[serde(with = "decimal_u64")]
    pub ifd_offset: u64,
    pub kind: RawPreviewKind,
    pub dimensions: Option<RawDimensions>,
    pub compression: Option<RawCompression>,
    pub photometric_interpretation: Option<u16>,
    pub data: Vec<RawDataRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawDeferredTagRef {
    #[serde(with = "decimal_u64")]
    pub ifd_offset: u64,
    pub tag: u16,
    pub field_type: u16,
    #[serde(with = "decimal_u64")]
    pub count: u64,
    #[serde(with = "decimal_u64")]
    pub value_offset: u64,
    #[serde(with = "decimal_u64")]
    pub value_byte_length: u64,
    pub inline: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawProbeDiagnosticSeverity {
    Info,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawProbeDiagnostic {
    pub severity: RawProbeDiagnosticSeverity,
    pub code: String,
    pub message: String,
    pub tag: Option<u16>,
    #[serde(with = "decimal_u64_option")]
    pub ifd_offset: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawProbeMetrics {
    #[serde(with = "decimal_u64")]
    pub elapsed_us: u64,
    #[serde(with = "decimal_u64")]
    pub metadata_bytes_materialized: u64,
    #[serde(with = "decimal_u64")]
    pub estimated_unpacked_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawProbeReport {
    pub schema_version: u32,
    pub container: RawContainer,
    pub byte_order: Option<RawByteOrder>,
    pub source: RawSourceIdentity,
    pub camera: RawCameraIdentity,
    pub dng: Option<RawDngMetadata>,
    pub dimensions: RawDimensions,
    pub active_area: Option<RawRect>,
    pub masked_areas: Vec<RawRect>,
    pub default_crop: Option<RawCrop>,
    pub orientation: Option<u16>,
    pub bits_per_sample: Vec<u16>,
    pub compression: RawCompression,
    pub samples_per_pixel: u16,
    pub cfa: Option<RawCfaPattern>,
    pub black_level: Option<RawLevelGrid>,
    pub white_level: Vec<RawRational>,
    pub as_shot_neutral: Option<Vec<RawRational>>,
    pub as_shot_white_xy: Option<[RawRational; 2]>,
    pub analog_balance: Option<Vec<RawRational>>,
    pub color_matrices: Vec<RawColorMatrix>,
    pub profile: RawProfileIdentity,
    pub raw_data: Vec<RawDataRef>,
    pub previews: Vec<RawPreviewRef>,
    pub deferred_metadata: Vec<RawDeferredTagRef>,
    pub metrics: RawProbeMetrics,
    pub diagnostics: Vec<RawProbeDiagnostic>,
}

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

mod decimal_u64_option {
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
        let value = Option::<String>::deserialize(deserializer)?;
        value
            .map(|value| value.parse().map_err(serde::de::Error::custom))
            .transpose()
    }
}
