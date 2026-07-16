#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ByteOrder {
    Little,
    Big,
}

pub const SENSOR_WIDTH: u32 = 6;
pub const SENSOR_HEIGHT: u32 = 6;
pub const ACTIVE_AREA: [u32; 4] = [1, 1, 5, 5];
pub const DEFAULT_CROP_ORIGIN: [u32; 2] = [0, 0];
pub const DEFAULT_CROP_SIZE: [u32; 2] = [4, 4];
pub const CFA_PATTERN_RGGB: [u8; 4] = [0, 1, 1, 2];
pub const BLACK_LEVEL: u16 = 64;
pub const WHITE_LEVEL: u16 = 4095;

pub const SENSOR_SAMPLES: [u16; 36] = [
    60, 62, 64, 66, 68, 70, // masked top row
    63, 128, 256, 384, 512, 640, // masked first column, then active pixels
    65, 768, 896, 1024, 1152, 1280, 64, 1408, 1536, 1664, 1792, 1920, 66, 2048, 2304, 2560, 3072,
    4095, 68, 70, 72, 74, 76, 78,
];

const TIFF_MAGIC: u16 = 42;
const TIFF_HEADER_LEN: u32 = 8;

const TYPE_BYTE: u16 = 1;
const TYPE_ASCII: u16 = 2;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_RATIONAL: u16 = 5;
const TYPE_SRATIONAL: u16 = 10;

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
const TAG_SAMPLE_FORMAT: u16 = 339;
const TAG_SUB_IFDS: u16 = 330;
const TAG_CFA_REPEAT_PATTERN_DIM: u16 = 33421;
const TAG_CFA_PATTERN: u16 = 33422;

const TAG_DNG_VERSION: u16 = 50706;
const TAG_DNG_BACKWARD_VERSION: u16 = 50707;
const TAG_UNIQUE_CAMERA_MODEL: u16 = 50708;
const TAG_CFA_PLANE_COLOR: u16 = 50710;
const TAG_CFA_LAYOUT: u16 = 50711;
const TAG_BLACK_LEVEL_REPEAT_DIM: u16 = 50713;
const TAG_BLACK_LEVEL: u16 = 50714;
const TAG_WHITE_LEVEL: u16 = 50717;
const TAG_DEFAULT_CROP_ORIGIN: u16 = 50719;
const TAG_DEFAULT_CROP_SIZE: u16 = 50720;
const TAG_COLOR_MATRIX_1: u16 = 50721;
const TAG_AS_SHOT_NEUTRAL: u16 = 50728;
const TAG_CALIBRATION_ILLUMINANT_1: u16 = 50778;
const TAG_RAW_DATA_UNIQUE_ID: u16 = 50781;
const TAG_ACTIVE_AREA: u16 = 50829;
const TAG_MASKED_AREAS: u16 = 50830;

const PHOTOMETRIC_RGB: u16 = 2;
const PHOTOMETRIC_CFA: u16 = 32803;
const COMPRESSION_NONE: u16 = 1;
const PLANAR_CHUNKY: u16 = 1;
const SAMPLE_FORMAT_UNSIGNED: u16 = 1;
const LIGHT_SOURCE_D65: u16 = 21;
const IDENTITY_COLOR_MATRIX: [(i32, i32); 9] = [
    (1, 1),
    (0, 1),
    (0, 1),
    (0, 1),
    (1, 1),
    (0, 1),
    (0, 1),
    (0, 1),
    (1, 1),
];
const RAW_DATA_UNIQUE_ID: [u8; 16] = [
    0x48, 0x47, 0x52, 0x49, 0x50, 0x45, 0x2d, 0x52, 0x30, 0x2d, 0x46, 0x49, 0x58, 0x54, 0x55, 0x52,
];

const THUMBNAIL_WIDTH: u32 = 2;
const THUMBNAIL_HEIGHT: u32 = 2;
const THUMBNAIL_RGB: [u8; 12] = [
    255, 0, 0, 0, 255, 0, // red, green
    0, 0, 255, 255, 255, 255, // blue, white
];

#[derive(Debug)]
struct IfdEntry {
    tag: u16,
    field_type: u16,
    count: u32,
    data: Vec<u8>,
    data_offset: Option<u32>,
}

impl IfdEntry {
    fn new(tag: u16, field_type: u16, count: u32, data: Vec<u8>) -> Self {
        let expected_len = usize::try_from(count)
            .expect("fixture count fits usize")
            .checked_mul(type_width(field_type))
            .expect("fixture field byte length does not overflow");
        assert_eq!(data.len(), expected_len, "tag {tag} has inconsistent data");
        Self {
            tag,
            field_type,
            count,
            data,
            data_offset: None,
        }
    }

    fn set_long(&mut self, byte_order: ByteOrder, value: u32) {
        assert_eq!(self.field_type, TYPE_LONG);
        assert_eq!(self.count, 1);
        self.data = encode_u32(byte_order, value);
    }
}

/// Builds a deterministic classic-TIFF DNG fixture without using an image or
/// TIFF encoder. The little- and big-endian variants carry identical metadata,
/// thumbnail pixels, and 16-bit sensor samples.
pub fn minimal_dng(byte_order: ByteOrder) -> Vec<u8> {
    let mut ifd0 = thumbnail_ifd(byte_order);
    let mut raw_ifd = raw_ifd(byte_order);
    sort_and_validate(&mut ifd0);
    sort_and_validate(&mut raw_ifd);

    let ifd0_offset = TIFF_HEADER_LEN;
    let raw_ifd_offset = ifd0_offset
        .checked_add(ifd_encoded_len(ifd0.len()))
        .expect("fixture IFD offset does not overflow");
    set_long_tag(&mut ifd0, TAG_SUB_IFDS, byte_order, raw_ifd_offset);

    let mut cursor = raw_ifd_offset
        .checked_add(ifd_encoded_len(raw_ifd.len()))
        .expect("fixture auxiliary offset does not overflow");
    assign_data_offsets(&mut ifd0, &mut cursor);
    assign_data_offsets(&mut raw_ifd, &mut cursor);

    cursor = align_two(cursor);
    let thumbnail_offset = cursor;
    cursor = cursor
        .checked_add(u32::try_from(THUMBNAIL_RGB.len()).expect("thumbnail length fits u32"))
        .expect("fixture thumbnail end does not overflow");

    cursor = align_two(cursor);
    let sensor_offset = cursor;
    let sensor_byte_len = u32::try_from(SENSOR_SAMPLES.len() * size_of::<u16>())
        .expect("sensor payload length fits u32");
    cursor = cursor
        .checked_add(sensor_byte_len)
        .expect("fixture sensor end does not overflow");

    set_long_tag(&mut ifd0, TAG_STRIP_OFFSETS, byte_order, thumbnail_offset);
    set_long_tag(&mut raw_ifd, TAG_STRIP_OFFSETS, byte_order, sensor_offset);

    let mut bytes = Vec::with_capacity(usize::try_from(cursor).expect("fixture length fits usize"));
    match byte_order {
        ByteOrder::Little => bytes.extend_from_slice(b"II"),
        ByteOrder::Big => bytes.extend_from_slice(b"MM"),
    }
    push_u16(&mut bytes, byte_order, TIFF_MAGIC);
    push_u32(&mut bytes, byte_order, ifd0_offset);

    pad_to(&mut bytes, ifd0_offset);
    write_ifd(&mut bytes, byte_order, &ifd0);
    pad_to(&mut bytes, raw_ifd_offset);
    write_ifd(&mut bytes, byte_order, &raw_ifd);
    write_auxiliary_data(&mut bytes, &ifd0);
    write_auxiliary_data(&mut bytes, &raw_ifd);

    pad_to(&mut bytes, thumbnail_offset);
    bytes.extend_from_slice(&THUMBNAIL_RGB);
    pad_to(&mut bytes, sensor_offset);
    for sample in SENSOR_SAMPLES {
        push_u16(&mut bytes, byte_order, sample);
    }

    assert_eq!(bytes.len(), usize::try_from(cursor).unwrap());
    bytes
}

fn thumbnail_ifd(byte_order: ByteOrder) -> Vec<IfdEntry> {
    vec![
        long_entry(byte_order, TAG_NEW_SUBFILE_TYPE, 1),
        long_entry(byte_order, TAG_IMAGE_WIDTH, THUMBNAIL_WIDTH),
        long_entry(byte_order, TAG_IMAGE_LENGTH, THUMBNAIL_HEIGHT),
        short_vec_entry(byte_order, TAG_BITS_PER_SAMPLE, &[8, 8, 8]),
        short_entry(byte_order, TAG_COMPRESSION, COMPRESSION_NONE),
        short_entry(byte_order, TAG_PHOTOMETRIC_INTERPRETATION, PHOTOMETRIC_RGB),
        ascii_entry(TAG_MAKE, "H-Gripe"),
        ascii_entry(TAG_MODEL, "Synthetic Bayer"),
        long_entry(byte_order, TAG_STRIP_OFFSETS, 0),
        short_entry(byte_order, TAG_ORIENTATION, 1),
        short_entry(byte_order, TAG_SAMPLES_PER_PIXEL, 3),
        long_entry(byte_order, TAG_ROWS_PER_STRIP, THUMBNAIL_HEIGHT),
        long_entry(
            byte_order,
            TAG_STRIP_BYTE_COUNTS,
            u32::try_from(THUMBNAIL_RGB.len()).unwrap(),
        ),
        short_entry(byte_order, TAG_PLANAR_CONFIGURATION, PLANAR_CHUNKY),
        long_entry(byte_order, TAG_SUB_IFDS, 0),
        byte_vec_entry(TAG_DNG_VERSION, &[1, 4, 0, 0]),
        byte_vec_entry(TAG_DNG_BACKWARD_VERSION, &[1, 1, 0, 0]),
        ascii_entry(TAG_UNIQUE_CAMERA_MODEL, "H-Gripe Synthetic Bayer"),
        srational_vec_entry(byte_order, TAG_COLOR_MATRIX_1, &IDENTITY_COLOR_MATRIX),
        rational_vec_entry(byte_order, TAG_AS_SHOT_NEUTRAL, &[(1, 2), (1, 1), (2, 3)]),
        short_entry(byte_order, TAG_CALIBRATION_ILLUMINANT_1, LIGHT_SOURCE_D65),
        byte_vec_entry(TAG_RAW_DATA_UNIQUE_ID, &RAW_DATA_UNIQUE_ID),
    ]
}

fn raw_ifd(byte_order: ByteOrder) -> Vec<IfdEntry> {
    let masked_areas = [0, 0, 1, SENSOR_WIDTH, 1, 0, 5, 1];
    let raw_byte_len = u32::try_from(SENSOR_SAMPLES.len() * size_of::<u16>()).unwrap();

    vec![
        long_entry(byte_order, TAG_NEW_SUBFILE_TYPE, 0),
        long_entry(byte_order, TAG_IMAGE_WIDTH, SENSOR_WIDTH),
        long_entry(byte_order, TAG_IMAGE_LENGTH, SENSOR_HEIGHT),
        short_entry(byte_order, TAG_BITS_PER_SAMPLE, 16),
        short_entry(byte_order, TAG_COMPRESSION, COMPRESSION_NONE),
        short_entry(byte_order, TAG_PHOTOMETRIC_INTERPRETATION, PHOTOMETRIC_CFA),
        long_entry(byte_order, TAG_STRIP_OFFSETS, 0),
        short_entry(byte_order, TAG_SAMPLES_PER_PIXEL, 1),
        long_entry(byte_order, TAG_ROWS_PER_STRIP, SENSOR_HEIGHT),
        long_entry(byte_order, TAG_STRIP_BYTE_COUNTS, raw_byte_len),
        short_entry(byte_order, TAG_PLANAR_CONFIGURATION, PLANAR_CHUNKY),
        short_entry(byte_order, TAG_SAMPLE_FORMAT, SAMPLE_FORMAT_UNSIGNED),
        short_vec_entry(byte_order, TAG_CFA_REPEAT_PATTERN_DIM, &[2, 2]),
        byte_vec_entry(TAG_CFA_PATTERN, &CFA_PATTERN_RGGB),
        byte_vec_entry(TAG_CFA_PLANE_COLOR, &[0, 1, 2]),
        short_entry(byte_order, TAG_CFA_LAYOUT, 1),
        short_vec_entry(byte_order, TAG_BLACK_LEVEL_REPEAT_DIM, &[1, 1]),
        short_entry(byte_order, TAG_BLACK_LEVEL, BLACK_LEVEL),
        short_entry(byte_order, TAG_WHITE_LEVEL, WHITE_LEVEL),
        long_vec_entry(byte_order, TAG_DEFAULT_CROP_ORIGIN, &DEFAULT_CROP_ORIGIN),
        long_vec_entry(byte_order, TAG_DEFAULT_CROP_SIZE, &DEFAULT_CROP_SIZE),
        long_vec_entry(byte_order, TAG_ACTIVE_AREA, &ACTIVE_AREA),
        long_vec_entry(byte_order, TAG_MASKED_AREAS, &masked_areas),
    ]
}

fn byte_vec_entry(tag: u16, values: &[u8]) -> IfdEntry {
    IfdEntry::new(
        tag,
        TYPE_BYTE,
        u32::try_from(values.len()).unwrap(),
        values.to_vec(),
    )
}

fn ascii_entry(tag: u16, value: &str) -> IfdEntry {
    assert!(value.is_ascii());
    let mut bytes = value.as_bytes().to_vec();
    bytes.push(0);
    IfdEntry::new(tag, TYPE_ASCII, u32::try_from(bytes.len()).unwrap(), bytes)
}

fn short_entry(byte_order: ByteOrder, tag: u16, value: u16) -> IfdEntry {
    short_vec_entry(byte_order, tag, &[value])
}

fn short_vec_entry(byte_order: ByteOrder, tag: u16, values: &[u16]) -> IfdEntry {
    let mut data = Vec::with_capacity(size_of_val(values));
    for &value in values {
        push_u16(&mut data, byte_order, value);
    }
    IfdEntry::new(tag, TYPE_SHORT, u32::try_from(values.len()).unwrap(), data)
}

fn long_entry(byte_order: ByteOrder, tag: u16, value: u32) -> IfdEntry {
    long_vec_entry(byte_order, tag, &[value])
}

fn long_vec_entry(byte_order: ByteOrder, tag: u16, values: &[u32]) -> IfdEntry {
    let mut data = Vec::with_capacity(size_of_val(values));
    for &value in values {
        push_u32(&mut data, byte_order, value);
    }
    IfdEntry::new(tag, TYPE_LONG, u32::try_from(values.len()).unwrap(), data)
}

fn rational_vec_entry(byte_order: ByteOrder, tag: u16, values: &[(u32, u32)]) -> IfdEntry {
    let mut data = Vec::with_capacity(values.len() * 2 * size_of::<u32>());
    for &(numerator, denominator) in values {
        assert_ne!(denominator, 0);
        push_u32(&mut data, byte_order, numerator);
        push_u32(&mut data, byte_order, denominator);
    }
    IfdEntry::new(
        tag,
        TYPE_RATIONAL,
        u32::try_from(values.len()).unwrap(),
        data,
    )
}

fn srational_vec_entry(byte_order: ByteOrder, tag: u16, values: &[(i32, i32)]) -> IfdEntry {
    let mut data = Vec::with_capacity(values.len() * 2 * size_of::<i32>());
    for &(numerator, denominator) in values {
        assert_ne!(denominator, 0);
        push_i32(&mut data, byte_order, numerator);
        push_i32(&mut data, byte_order, denominator);
    }
    IfdEntry::new(
        tag,
        TYPE_SRATIONAL,
        u32::try_from(values.len()).unwrap(),
        data,
    )
}

fn type_width(field_type: u16) -> usize {
    match field_type {
        TYPE_BYTE | TYPE_ASCII => 1,
        TYPE_SHORT => 2,
        TYPE_LONG => 4,
        TYPE_RATIONAL | TYPE_SRATIONAL => 8,
        _ => panic!("unsupported fixture TIFF field type {field_type}"),
    }
}

fn ifd_encoded_len(entry_count: usize) -> u32 {
    let entries = u32::try_from(entry_count).expect("fixture IFD entry count fits u32");
    2_u32
        .checked_add(
            entries
                .checked_mul(12)
                .expect("fixture IFD length fits u32"),
        )
        .and_then(|length| length.checked_add(4))
        .expect("fixture IFD length fits u32")
}

fn sort_and_validate(entries: &mut [IfdEntry]) {
    entries.sort_unstable_by_key(|entry| entry.tag);
    for pair in entries.windows(2) {
        assert_ne!(pair[0].tag, pair[1].tag, "duplicate fixture TIFF tag");
    }
    assert!(entries.len() <= usize::from(u16::MAX));
}

fn set_long_tag(entries: &mut [IfdEntry], tag: u16, byte_order: ByteOrder, value: u32) {
    entries
        .iter_mut()
        .find(|entry| entry.tag == tag)
        .unwrap_or_else(|| panic!("missing fixture tag {tag}"))
        .set_long(byte_order, value);
}

fn assign_data_offsets(entries: &mut [IfdEntry], cursor: &mut u32) {
    for entry in entries {
        if entry.data.len() <= 4 {
            continue;
        }
        *cursor = align_two(*cursor);
        entry.data_offset = Some(*cursor);
        *cursor = cursor
            .checked_add(u32::try_from(entry.data.len()).expect("fixture field length fits u32"))
            .expect("fixture field end does not overflow");
    }
}

fn write_ifd(bytes: &mut Vec<u8>, byte_order: ByteOrder, entries: &[IfdEntry]) {
    push_u16(
        bytes,
        byte_order,
        u16::try_from(entries.len()).expect("fixture IFD entry count fits u16"),
    );
    for entry in entries {
        push_u16(bytes, byte_order, entry.tag);
        push_u16(bytes, byte_order, entry.field_type);
        push_u32(bytes, byte_order, entry.count);
        if let Some(offset) = entry.data_offset {
            push_u32(bytes, byte_order, offset);
        } else {
            assert!(entry.data.len() <= 4);
            bytes.extend_from_slice(&entry.data);
            bytes.resize(bytes.len() + (4 - entry.data.len()), 0);
        }
    }
    push_u32(bytes, byte_order, 0);
}

fn write_auxiliary_data(bytes: &mut Vec<u8>, entries: &[IfdEntry]) {
    for entry in entries {
        if let Some(offset) = entry.data_offset {
            pad_to(bytes, offset);
            bytes.extend_from_slice(&entry.data);
        }
    }
}

fn pad_to(bytes: &mut Vec<u8>, offset: u32) {
    let target = usize::try_from(offset).expect("fixture offset fits usize");
    assert!(bytes.len() <= target, "fixture regions overlap");
    bytes.resize(target, 0);
}

const fn align_two(value: u32) -> u32 {
    value + (value & 1)
}

fn encode_u32(byte_order: ByteOrder, value: u32) -> Vec<u8> {
    match byte_order {
        ByteOrder::Little => value.to_le_bytes().to_vec(),
        ByteOrder::Big => value.to_be_bytes().to_vec(),
    }
}

fn push_u16(bytes: &mut Vec<u8>, byte_order: ByteOrder, value: u16) {
    match byte_order {
        ByteOrder::Little => bytes.extend_from_slice(&value.to_le_bytes()),
        ByteOrder::Big => bytes.extend_from_slice(&value.to_be_bytes()),
    }
}

fn push_u32(bytes: &mut Vec<u8>, byte_order: ByteOrder, value: u32) {
    match byte_order {
        ByteOrder::Little => bytes.extend_from_slice(&value.to_le_bytes()),
        ByteOrder::Big => bytes.extend_from_slice(&value.to_be_bytes()),
    }
}

fn push_i32(bytes: &mut Vec<u8>, byte_order: ByteOrder, value: i32) {
    match byte_order {
        ByteOrder::Little => bytes.extend_from_slice(&value.to_le_bytes()),
        ByteOrder::Big => bytes.extend_from_slice(&value.to_be_bytes()),
    }
}
