/*
 * // Copyright (c) Radzivon Bartoshyk 2/2025. All rights reserved.
 * //
 * // Redistribution and use in source and binary forms, with or without modification,
 * // are permitted provided that the following conditions are met:
 * //
 * // 1.  Redistributions of source code must retain the above copyright notice, this
 * // list of conditions and the following disclaimer.
 * //
 * // 2.  Redistributions in binary form must reproduce the above copyright notice,
 * // this list of conditions and the following disclaimer in the documentation
 * // and/or other materials provided with the distribution.
 * //
 * // 3.  Neither the name of the copyright holder nor the names of its
 * // contributors may be used to endorse or promote products derived from
 * // this software without specific prior written permission.
 * //
 * // THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * // AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * // IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * // DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * // FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * // DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * // SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * // CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * // OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * // OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
use crate::chad::BRADFORD_D;
use crate::cicp::{
    CicpColorPrimaries, ColorPrimaries, MatrixCoefficients, TransferCharacteristics,
};
use crate::dat::ColorDateTime;
use crate::err::CmsError;
use crate::matrix::{Matrix3f, Xyz};
use crate::trc::ToneReprCurve;
use crate::{Chromaticity, Layout, Matrix3d, XyY, Xyzd, adapt_to_d50_d};

#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileSignature {
    Acsp,
}

impl TryFrom<u32> for ProfileSignature {
    type Error = CmsError;
    #[inline]
    fn try_from(value: u32) -> Result<Self, Self::Error> {
        if value == u32::from_ne_bytes(*b"acsp").to_be() {
            return Ok(ProfileSignature::Acsp);
        }
        Err(CmsError::InvalidProfile)
    }
}

impl From<ProfileSignature> for u32 {
    #[inline]
    fn from(value: ProfileSignature) -> Self {
        match value {
            ProfileSignature::Acsp => u32::from_ne_bytes(*b"acsp").to_be(),
        }
    }
}

#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Ord, PartialOrd)]
pub enum ProfileVersion {
    V2_0 = 0x02000000,
    V2_1 = 0x02100000,
    V2_2 = 0x02200000,
    V2_3 = 0x02300000,
    V2_4 = 0x02400000,
    V4_0 = 0x04000000,
    V4_1 = 0x04100000,
    V4_2 = 0x04200000,
    V4_3 = 0x04300000,
    #[default]
    V4_4 = 0x04400000,
    Unknown,
}

impl TryFrom<u32> for ProfileVersion {
    type Error = CmsError;
    fn try_from(value: u32) -> Result<Self, Self::Error> {
        // First try exact match for known versions
        match value {
            0x02000000 => return Ok(ProfileVersion::V2_0),
            0x02100000 => return Ok(ProfileVersion::V2_1),
            0x02200000 => return Ok(ProfileVersion::V2_2),
            0x02300000 => return Ok(ProfileVersion::V2_3),
            0x02400000 => return Ok(ProfileVersion::V2_4),
            0x04000000 => return Ok(ProfileVersion::V4_0),
            0x04100000 => return Ok(ProfileVersion::V4_1),
            0x04200000 => return Ok(ProfileVersion::V4_2),
            0x04300000 => return Ok(ProfileVersion::V4_3),
            0x04400000 => return Ok(ProfileVersion::V4_4),
            _ => {}
        }

        // Extract major version (first byte) for range matching
        // ICC version format: major.minor.bugfix.zero in bytes [0][1][2][3]
        let major = (value >> 24) & 0xFF;
        let minor = (value >> 20) & 0x0F;

        // Accept profiles with patch versions (e.g., v2.0.2, v3.4, v4.2.9)
        // but reject invalid versions (v0.x) and unsupported versions (v5.x+ / ICC MAX)
        match major {
            0 => {
                // Version 0.x is invalid - reject
                Err(CmsError::InvalidProfile)
            }
            2 => {
                // v2.x - map to the appropriate v2 minor version or highest known
                match minor {
                    0 => Ok(ProfileVersion::V2_0),
                    1 => Ok(ProfileVersion::V2_1),
                    2 => Ok(ProfileVersion::V2_2),
                    3 => Ok(ProfileVersion::V2_3),
                    _ => Ok(ProfileVersion::V2_4), // Higher minor versions -> v2.4
                }
            }
            3 => {
                // v3.x (rare but exists) - treat as v2.4 (functionally similar)
                Ok(ProfileVersion::V2_4)
            }
            4 => {
                // v4.x - map to the appropriate v4 minor version or highest known
                match minor {
                    0 => Ok(ProfileVersion::V4_0),
                    1 => Ok(ProfileVersion::V4_1),
                    2 => Ok(ProfileVersion::V4_2),
                    3 => Ok(ProfileVersion::V4_3),
                    _ => Ok(ProfileVersion::V4_4), // Higher minor versions -> v4.4
                }
            }
            _ => {
                // v5.x+ (ICC MAX) and other unknown versions - reject
                // ICC MAX has different white point requirements and would produce wrong colors
                Err(CmsError::InvalidProfile)
            }
        }
    }
}

impl From<ProfileVersion> for u32 {
    fn from(value: ProfileVersion) -> Self {
        match value {
            ProfileVersion::V2_0 => 0x02000000,
            ProfileVersion::V2_1 => 0x02100000,
            ProfileVersion::V2_2 => 0x02200000,
            ProfileVersion::V2_3 => 0x02300000,
            ProfileVersion::V2_4 => 0x02400000,
            ProfileVersion::V4_0 => 0x04000000,
            ProfileVersion::V4_1 => 0x04100000,
            ProfileVersion::V4_2 => 0x04200000,
            ProfileVersion::V4_3 => 0x04300000,
            ProfileVersion::V4_4 => 0x04400000,
            ProfileVersion::Unknown => 0x02000000,
        }
    }
}

#[repr(u32)]
#[derive(Debug, Copy, Clone, Ord, PartialOrd, Eq, PartialEq, Default, Hash)]
pub enum DataColorSpace {
    #[default]
    Xyz,
    Lab,
    Luv,
    YCbr,
    Yxy,
    Rgb,
    Gray,
    Hsv,
    Hls,
}

impl DataColorSpace {
    #[inline]
    pub fn check_layout(self, layout: Layout) -> Result<(), CmsError> {
        let unsupported: bool = match self {
            DataColorSpace::Xyz => layout != Layout::Rgb,
            DataColorSpace::Lab => layout != Layout::Rgb && layout != Layout::Rgba,
            DataColorSpace::Luv => layout != Layout::Rgb,
            DataColorSpace::YCbr => layout != Layout::Rgb,
            DataColorSpace::Yxy => layout != Layout::Rgb,
            DataColorSpace::Rgb => layout != Layout::Rgb && layout != Layout::Rgba,
            DataColorSpace::Gray => layout != Layout::Gray && layout != Layout::GrayAlpha,
            DataColorSpace::Hsv => layout != Layout::Rgb,
            DataColorSpace::Hls => layout != Layout::Rgb,
        };
        if unsupported {
            Err(CmsError::InvalidLayout)
        } else {
            Ok(())
        }
    }
}

#[repr(u32)]
#[derive(Debug, Copy, Clone, Ord, PartialOrd, Eq, PartialEq, Default)]
pub enum ProfileClass {
    InputDevice,
    #[default]
    DisplayDevice,
    OutputDevice,
    DeviceLink,
    ColorSpace,
    Abstract,
    Named,
}

impl TryFrom<u32> for ProfileClass {
    type Error = CmsError;
    fn try_from(value: u32) -> Result<Self, Self::Error> {
        if value == u32::from_ne_bytes(*b"scnr").to_be() {
            return Ok(ProfileClass::InputDevice);
        } else if value == u32::from_ne_bytes(*b"mntr").to_be() {
            return Ok(ProfileClass::DisplayDevice);
        } else if value == u32::from_ne_bytes(*b"prtr").to_be() {
            return Ok(ProfileClass::OutputDevice);
        } else if value == u32::from_ne_bytes(*b"link").to_be() {
            return Ok(ProfileClass::DeviceLink);
        } else if value == u32::from_ne_bytes(*b"spac").to_be() {
            return Ok(ProfileClass::ColorSpace);
        } else if value == u32::from_ne_bytes(*b"abst").to_be() {
            return Ok(ProfileClass::Abstract);
        } else if value == u32::from_ne_bytes(*b"nmcl").to_be() {
            return Ok(ProfileClass::Named);
        }
        Err(CmsError::InvalidProfile)
    }
}

impl From<ProfileClass> for u32 {
    fn from(val: ProfileClass) -> Self {
        match val {
            ProfileClass::InputDevice => u32::from_ne_bytes(*b"scnr").to_be(),
            ProfileClass::DisplayDevice => u32::from_ne_bytes(*b"mntr").to_be(),
            ProfileClass::OutputDevice => u32::from_ne_bytes(*b"prtr").to_be(),
            ProfileClass::DeviceLink => u32::from_ne_bytes(*b"link").to_be(),
            ProfileClass::ColorSpace => u32::from_ne_bytes(*b"spac").to_be(),
            ProfileClass::Abstract => u32::from_ne_bytes(*b"abst").to_be(),
            ProfileClass::Named => u32::from_ne_bytes(*b"nmcl").to_be(),
        }
    }
}

impl TryFrom<u32> for DataColorSpace {
    type Error = CmsError;
    fn try_from(value: u32) -> Result<Self, Self::Error> {
        if value == u32::from_ne_bytes(*b"XYZ ").to_be() {
            return Ok(DataColorSpace::Xyz);
        } else if value == u32::from_ne_bytes(*b"Lab ").to_be() {
            return Ok(DataColorSpace::Lab);
        } else if value == u32::from_ne_bytes(*b"Luv ").to_be() {
            return Ok(DataColorSpace::Luv);
        } else if value == u32::from_ne_bytes(*b"YCbr").to_be() {
            return Ok(DataColorSpace::YCbr);
        } else if value == u32::from_ne_bytes(*b"Yxy ").to_be() {
            return Ok(DataColorSpace::Yxy);
        } else if value == u32::from_ne_bytes(*b"RGB ").to_be() {
            return Ok(DataColorSpace::Rgb);
        } else if value == u32::from_ne_bytes(*b"GRAY").to_be() {
            return Ok(DataColorSpace::Gray);
        } else if value == u32::from_ne_bytes(*b"HSV ").to_be() {
            return Ok(DataColorSpace::Hsv);
        } else if value == u32::from_ne_bytes(*b"HLS ").to_be() {
            return Ok(DataColorSpace::Hls);
        }
        Err(CmsError::InvalidProfile)
    }
}

impl From<DataColorSpace> for u32 {
    fn from(val: DataColorSpace) -> Self {
        match val {
            DataColorSpace::Xyz => u32::from_ne_bytes(*b"XYZ ").to_be(),
            DataColorSpace::Lab => u32::from_ne_bytes(*b"Lab ").to_be(),
            DataColorSpace::Luv => u32::from_ne_bytes(*b"Luv ").to_be(),
            DataColorSpace::YCbr => u32::from_ne_bytes(*b"YCbr").to_be(),
            DataColorSpace::Yxy => u32::from_ne_bytes(*b"Yxy ").to_be(),
            DataColorSpace::Rgb => u32::from_ne_bytes(*b"RGB ").to_be(),
            DataColorSpace::Gray => u32::from_ne_bytes(*b"GRAY").to_be(),
            DataColorSpace::Hsv => u32::from_ne_bytes(*b"HSV ").to_be(),
            DataColorSpace::Hls => u32::from_ne_bytes(*b"HLS ").to_be(),
        }
    }
}

#[derive(Copy, Clone, Debug, Ord, PartialOrd, Eq, PartialEq)]
pub enum TechnologySignatures {
    FilmScanner,
    DigitalCamera,
    ReflectiveScanner,
    InkJetPrinter,
    ThermalWaxPrinter,
    ElectrophotographicPrinter,
    ElectrostaticPrinter,
    DyeSublimationPrinter,
    PhotographicPaperPrinter,
    FilmWriter,
    VideoMonitor,
    VideoCamera,
    ProjectionTelevision,
    CathodeRayTubeDisplay,
    PassiveMatrixDisplay,
    ActiveMatrixDisplay,
    LiquidCrystalDisplay,
    OrganicLedDisplay,
    PhotoCd,
    PhotographicImageSetter,
    Gravure,
    OffsetLithography,
    Silkscreen,
    Flexography,
    MotionPictureFilmScanner,
    MotionPictureFilmRecorder,
    DigitalMotionPictureCamera,
    DigitalCinemaProjector,
    Unknown(u32),
}

impl From<u32> for TechnologySignatures {
    fn from(value: u32) -> Self {
        if value == u32::from_ne_bytes(*b"fscn").to_be() {
            return TechnologySignatures::FilmScanner;
        } else if value == u32::from_ne_bytes(*b"dcam").to_be() {
            return TechnologySignatures::DigitalCamera;
        } else if value == u32::from_ne_bytes(*b"rscn").to_be() {
            return TechnologySignatures::ReflectiveScanner;
        } else if value == u32::from_ne_bytes(*b"ijet").to_be() {
            return TechnologySignatures::InkJetPrinter;
        } else if value == u32::from_ne_bytes(*b"twax").to_be() {
            return TechnologySignatures::ThermalWaxPrinter;
        } else if value == u32::from_ne_bytes(*b"epho").to_be() {
            return TechnologySignatures::ElectrophotographicPrinter;
        } else if value == u32::from_ne_bytes(*b"esta").to_be() {
            return TechnologySignatures::ElectrostaticPrinter;
        } else if value == u32::from_ne_bytes(*b"dsub").to_be() {
            return TechnologySignatures::DyeSublimationPrinter;
        } else if value == u32::from_ne_bytes(*b"rpho").to_be() {
            return TechnologySignatures::PhotographicPaperPrinter;
        } else if value == u32::from_ne_bytes(*b"fprn").to_be() {
            return TechnologySignatures::FilmWriter;
        } else if value == u32::from_ne_bytes(*b"vidm").to_be() {
            return TechnologySignatures::VideoMonitor;
        } else if value == u32::from_ne_bytes(*b"vidc").to_be() {
            return TechnologySignatures::VideoCamera;
        } else if value == u32::from_ne_bytes(*b"pjtv").to_be() {
            return TechnologySignatures::ProjectionTelevision;
        } else if value == u32::from_ne_bytes(*b"CRT ").to_be() {
            return TechnologySignatures::CathodeRayTubeDisplay;
        } else if value == u32::from_ne_bytes(*b"PMD ").to_be() {
            return TechnologySignatures::PassiveMatrixDisplay;
        } else if value == u32::from_ne_bytes(*b"AMD ").to_be() {
            return TechnologySignatures::ActiveMatrixDisplay;
        } else if value == u32::from_ne_bytes(*b"LCD ").to_be() {
            return TechnologySignatures::LiquidCrystalDisplay;
        } else if value == u32::from_ne_bytes(*b"OLED").to_be() {
            return TechnologySignatures::OrganicLedDisplay;
        } else if value == u32::from_ne_bytes(*b"KPCD").to_be() {
            return TechnologySignatures::PhotoCd;
        } else if value == u32::from_ne_bytes(*b"imgs").to_be() {
            return TechnologySignatures::PhotographicImageSetter;
        } else if value == u32::from_ne_bytes(*b"grav").to_be() {
            return TechnologySignatures::Gravure;
        } else if value == u32::from_ne_bytes(*b"offs").to_be() {
            return TechnologySignatures::OffsetLithography;
        } else if value == u32::from_ne_bytes(*b"silk").to_be() {
            return TechnologySignatures::Silkscreen;
        } else if value == u32::from_ne_bytes(*b"flex").to_be() {
            return TechnologySignatures::Flexography;
        } else if value == u32::from_ne_bytes(*b"mpfs").to_be() {
            return TechnologySignatures::MotionPictureFilmScanner;
        } else if value == u32::from_ne_bytes(*b"mpfr").to_be() {
            return TechnologySignatures::MotionPictureFilmRecorder;
        } else if value == u32::from_ne_bytes(*b"dmpc").to_be() {
            return TechnologySignatures::DigitalMotionPictureCamera;
        } else if value == u32::from_ne_bytes(*b"dcpj").to_be() {
            return TechnologySignatures::DigitalCinemaProjector;
        }
        TechnologySignatures::Unknown(value)
    }
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Default, Ord, PartialOrd, Eq, PartialEq, Hash)]
pub enum RenderingIntent {
    AbsoluteColorimetric = 3,
    Saturation = 2,
    RelativeColorimetric = 1,
    #[default]
    Perceptual = 0,
}

impl TryFrom<u32> for RenderingIntent {
    type Error = CmsError;

    #[inline]
    fn try_from(value: u32) -> Result<Self, Self::Error> {
        // Rendering intent is a big-endian u32 at bytes 64-67 with valid
        // values 0-3. Non-conforming profiles (e.g. old Linotype "Lino"
        // v2.1 profiles with byte-swapped values) may have invalid values.
        // Default to Perceptual rather than rejecting the entire profile,
        // since this field is advisory — moxcms uses TransformOptions for
        // actual LUT selection.
        match value {
            0 => Ok(RenderingIntent::Perceptual),
            1 => Ok(RenderingIntent::RelativeColorimetric),
            2 => Ok(RenderingIntent::Saturation),
            3 => Ok(RenderingIntent::AbsoluteColorimetric),
            _ => Ok(RenderingIntent::Perceptual),
        }
    }
}

impl From<RenderingIntent> for u32 {
    #[inline]
    fn from(value: RenderingIntent) -> Self {
        match value {
            RenderingIntent::AbsoluteColorimetric => 3,
            RenderingIntent::Saturation => 2,
            RenderingIntent::RelativeColorimetric => 1,
            RenderingIntent::Perceptual => 0,
        }
    }
}

/// ICC Header
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub(crate) struct ProfileHeader {
    pub size: u32,                         // Size of the profile (computed)
    pub cmm_type: u32,                     // Preferred CMM type (ignored)
    pub version: ProfileVersion,           // Version (4.3 or 4.4 if CICP is included)
    pub profile_class: ProfileClass,       // Display device profile
    pub data_color_space: DataColorSpace,  // RGB input color space
    pub pcs: DataColorSpace,               // Profile connection space
    pub creation_date_time: ColorDateTime, // Date and time
    pub signature: ProfileSignature,       // Profile signature
    pub platform: u32,                     // Platform target (ignored)
    pub flags: u32,                        // Flags (not embedded, can be used independently)
    pub device_manufacturer: u32,          // Device manufacturer (ignored)
    pub device_model: u32,                 // Device model (ignored)
    pub device_attributes: [u8; 8],        // Device attributes (ignored)
    pub rendering_intent: RenderingIntent, // Relative colorimetric rendering intent
    pub illuminant: Xyz,                   // D50 standard illuminant X
    pub creator: u32,                      // Profile creator (ignored)
    pub profile_id: [u8; 16],              // Profile id checksum (ignored)
    pub reserved: [u8; 28],                // Reserved (ignored)
    pub tag_count: u32,                    // Technically not part of header, but required
}

impl ProfileHeader {
    #[allow(dead_code)]
    pub(crate) fn new(size: u32) -> Self {
        Self {
            size,
            cmm_type: 0,
            version: ProfileVersion::V4_3,
            profile_class: ProfileClass::DisplayDevice,
            data_color_space: DataColorSpace::Rgb,
            pcs: DataColorSpace::Xyz,
            creation_date_time: ColorDateTime::default(),
            signature: ProfileSignature::Acsp,
            platform: 0,
            flags: 0x00000000,
            device_manufacturer: 0,
            device_model: 0,
            device_attributes: [0; 8],
            rendering_intent: RenderingIntent::Perceptual,
            illuminant: Chromaticity::D50.to_xyz(),
            creator: 0,
            profile_id: [0; 16],
            reserved: [0; 28],
            tag_count: 0,
        }
    }
}

/// A [Coding Independent Code Point](https://en.wikipedia.org/wiki/Coding-independent_code_points).
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct CicpProfile {
    pub color_primaries: CicpColorPrimaries,
    pub transfer_characteristics: TransferCharacteristics,
    pub matrix_coefficients: MatrixCoefficients,
    pub full_range: bool,
}

#[derive(Debug, Clone)]
pub struct LocalizableString {
    /// An ISO 639-1 value is expected; any text w. more than two symbols will be truncated
    pub language: String,
    /// An ISO 3166-1 value is expected; any text w. more than two symbols will be truncated
    pub country: String,
    pub value: String,
}

impl LocalizableString {
    /// Creates new localizable string
    ///
    /// # Arguments
    ///
    /// * `language`: an ISO 639-1 value is expected, any text more than 2 symbols will be truncated
    /// * `country`: an ISO 3166-1 value is expected, any text more than 2 symbols will be truncated
    /// * `value`: String value
    ///
    pub fn new(language: String, country: String, value: String) -> Self {
        Self {
            language,
            country,
            value,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DescriptionString {
    pub ascii_string: String,
    pub unicode_language_code: u32,
    pub unicode_string: String,
    pub script_code_code: i8,
    pub mac_string: String,
}

#[derive(Debug, Clone)]
pub enum ProfileText {
    PlainString(String),
    Localizable(Vec<LocalizableString>),
    Description(DescriptionString),
}

impl ProfileText {
    pub(crate) fn has_values(&self) -> bool {
        match self {
            ProfileText::PlainString(_) => true,
            ProfileText::Localizable(lc) => !lc.is_empty(),
            ProfileText::Description(_) => true,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum StandardObserver {
    D50,
    D65,
    Unknown,
}

impl From<u32> for StandardObserver {
    fn from(value: u32) -> Self {
        if value == 1 {
            return StandardObserver::D50;
        } else if value == 2 {
            return StandardObserver::D65;
        }
        StandardObserver::Unknown
    }
}

impl From<StandardObserver> for u32 {
    fn from(value: StandardObserver) -> Self {
        match value {
            StandardObserver::D50 => 1,
            StandardObserver::D65 => 2,
            StandardObserver::Unknown => 0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ViewingConditions {
    pub illuminant: Xyz,
    pub surround: Xyz,
    pub observer: StandardObserver,
}

#[derive(Debug, Clone, Copy)]
pub enum MeasurementGeometry {
    Unknown,
    /// 0°:45° or 45°:0°
    D45to45,
    /// 0°:d or d:0°
    D0to0,
}

impl From<u32> for MeasurementGeometry {
    fn from(value: u32) -> Self {
        if value == 1 {
            Self::D45to45
        } else if value == 2 {
            Self::D0to0
        } else {
            Self::Unknown
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum StandardIlluminant {
    Unknown,
    D50,
    D65,
    D93,
    F2,
    D55,
    A,
    EquiPower,
    F8,
}

impl From<u32> for StandardIlluminant {
    fn from(value: u32) -> Self {
        match value {
            1 => StandardIlluminant::D50,
            2 => StandardIlluminant::D65,
            3 => StandardIlluminant::D93,
            4 => StandardIlluminant::F2,
            5 => StandardIlluminant::D55,
            6 => StandardIlluminant::A,
            7 => StandardIlluminant::EquiPower,
            8 => StandardIlluminant::F8,
            _ => Self::Unknown,
        }
    }
}

impl From<StandardIlluminant> for u32 {
    fn from(value: StandardIlluminant) -> Self {
        match value {
            StandardIlluminant::Unknown => 0u32,
            StandardIlluminant::D50 => 1u32,
            StandardIlluminant::D65 => 2u32,
            StandardIlluminant::D93 => 3,
            StandardIlluminant::F2 => 4,
            StandardIlluminant::D55 => 5,
            StandardIlluminant::A => 6,
            StandardIlluminant::EquiPower => 7,
            StandardIlluminant::F8 => 8,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Measurement {
    pub observer: StandardObserver,
    pub backing: Xyz,
    pub geometry: MeasurementGeometry,
    pub flare: f32,
    pub illuminant: StandardIlluminant,
}

/// ICC Profile representation
#[repr(C)]
#[derive(Debug, Clone, Default)]
pub struct ColorProfile {
    pub pcs: DataColorSpace,
    pub color_space: DataColorSpace,
    pub profile_class: ProfileClass,
    pub rendering_intent: RenderingIntent,
    pub red_colorant: Xyzd,
    pub green_colorant: Xyzd,
    pub blue_colorant: Xyzd,
    pub white_point: Xyzd,
    pub black_point: Option<Xyzd>,
    pub media_white_point: Option<Xyzd>,
    pub luminance: Option<Xyzd>,
    pub measurement: Option<Measurement>,
    pub red_trc: Option<ToneReprCurve>,
    pub green_trc: Option<ToneReprCurve>,
    pub blue_trc: Option<ToneReprCurve>,
    pub gray_trc: Option<ToneReprCurve>,
    pub cicp: Option<CicpProfile>,
    pub chromatic_adaptation: Option<Matrix3d>,
    pub copyright: Option<ProfileText>,
    pub description: Option<ProfileText>,
    pub device_manufacturer: Option<ProfileText>,
    pub device_model: Option<ProfileText>,
    pub char_target: Option<ProfileText>,
    pub viewing_conditions: Option<ViewingConditions>,
    pub viewing_conditions_description: Option<ProfileText>,
    pub technology: Option<TechnologySignatures>,
    pub calibration_date: Option<ColorDateTime>,
    pub creation_date_time: ColorDateTime,
    /// Version for internal and viewing purposes only.
    /// On encoding this is computable property which will set at least V4.
    pub(crate) version_internal: ProfileVersion,
}

impl ColorProfile {
    /// Returns profile version
    pub fn version(&self) -> ProfileVersion {
        self.version_internal
    }
}

impl ColorProfile {
    #[inline]
    pub fn colorant_matrix(&self) -> Matrix3d {
        Matrix3d {
            v: [
                [
                    self.red_colorant.x,
                    self.green_colorant.x,
                    self.blue_colorant.x,
                ],
                [
                    self.red_colorant.y,
                    self.green_colorant.y,
                    self.blue_colorant.y,
                ],
                [
                    self.red_colorant.z,
                    self.green_colorant.z,
                    self.blue_colorant.z,
                ],
            ],
        }
    }

    /// Computes colorants matrix. Returns not transposed matrix.
    ///
    /// To work on `const` context this method does have restrictions.
    /// If invalid values were provided it may return invalid matrix or NaNs.
    pub const fn colorants_matrix(white_point: XyY, primaries: ColorPrimaries) -> Matrix3d {
        let red_xyz = primaries.red.to_xyzd();
        let green_xyz = primaries.green.to_xyzd();
        let blue_xyz = primaries.blue.to_xyzd();

        let xyz_matrix = Matrix3d {
            v: [
                [red_xyz.x, green_xyz.x, blue_xyz.x],
                [red_xyz.y, green_xyz.y, blue_xyz.y],
                [red_xyz.z, green_xyz.z, blue_xyz.z],
            ],
        };
        let colorants = ColorProfile::rgb_to_xyz_d(xyz_matrix, white_point.to_xyzd());
        adapt_to_d50_d(colorants, white_point)
    }

    /// Updates RGB triple colorimetry from 3 [Chromaticity] and white point
    /// This will nullify CICP.
    pub const fn update_rgb_colorimetry(&mut self, white_point: XyY, primaries: ColorPrimaries) {
        self.cicp = None;
        let red_xyz = primaries.red.to_xyzd();
        let green_xyz = primaries.green.to_xyzd();
        let blue_xyz = primaries.blue.to_xyzd();

        self.chromatic_adaptation = Some(BRADFORD_D);
        self.update_rgb_colorimetry_triplet(white_point, red_xyz, green_xyz, blue_xyz)
    }

    /// Updates RGB triple colorimetry from 3 [Xyzd] and white point
    ///
    /// To work on `const` context this method does have restrictions.
    /// If invalid values were provided it may return invalid matrix or NaNs.
    ///
    /// This will void CICP tag.
    pub const fn update_rgb_colorimetry_triplet(
        &mut self,
        white_point: XyY,
        red_xyz: Xyzd,
        green_xyz: Xyzd,
        blue_xyz: Xyzd,
    ) {
        self.cicp = None;
        let xyz_matrix = Matrix3d {
            v: [
                [red_xyz.x, green_xyz.x, blue_xyz.x],
                [red_xyz.y, green_xyz.y, blue_xyz.y],
                [red_xyz.z, green_xyz.z, blue_xyz.z],
            ],
        };
        let colorants = ColorProfile::rgb_to_xyz_d(xyz_matrix, white_point.to_xyzd());
        let colorants = adapt_to_d50_d(colorants, white_point);

        self.update_colorants(colorants);
    }

    pub(crate) const fn update_colorants(&mut self, colorants: Matrix3d) {
        // note: there's a transpose type of operation going on here
        self.red_colorant.x = colorants.v[0][0];
        self.red_colorant.y = colorants.v[1][0];
        self.red_colorant.z = colorants.v[2][0];
        self.green_colorant.x = colorants.v[0][1];
        self.green_colorant.y = colorants.v[1][1];
        self.green_colorant.z = colorants.v[2][1];
        self.blue_colorant.x = colorants.v[0][2];
        self.blue_colorant.y = colorants.v[1][2];
        self.blue_colorant.z = colorants.v[2][2];
    }

    /// Updates RGB triple colorimetry from CICP
    pub fn update_rgb_colorimetry_from_cicp(&mut self, cicp: CicpProfile) -> bool {
        if !cicp.color_primaries.has_chromaticity()
            || !cicp.transfer_characteristics.has_transfer_curve()
        {
            return false;
        }
        let primaries_xy: ColorPrimaries = match cicp.color_primaries.try_into() {
            Ok(primaries) => primaries,
            Err(_) => return false,
        };
        let white_point: Chromaticity = match cicp.color_primaries.white_point() {
            Ok(v) => v,
            Err(_) => return false,
        };
        self.update_rgb_colorimetry(white_point.to_xyyb(), primaries_xy);
        self.cicp = Some(cicp);

        let red_trc: ToneReprCurve = match cicp.transfer_characteristics.try_into() {
            Ok(trc) => trc,
            Err(_) => return false,
        };
        self.green_trc = Some(red_trc.clone());
        self.blue_trc = Some(red_trc.clone());
        self.red_trc = Some(red_trc);
        false
    }

    pub const fn rgb_to_xyz(xyz_matrix: Matrix3f, wp: Xyz) -> Matrix3f {
        let xyz_inverse = xyz_matrix.inverse();
        let s = xyz_inverse.mul_vector(wp.to_vector());
        let mut v = xyz_matrix.mul_row_vector::<0>(s);
        v = v.mul_row_vector::<1>(s);
        v.mul_row_vector::<2>(s)
    }

    /// If Primaries is invalid will return invalid matrix on const context.
    /// This assumes not transposed matrix and returns not transposed matrix.
    pub const fn rgb_to_xyz_d(xyz_matrix: Matrix3d, wp: Xyzd) -> Matrix3d {
        let xyz_inverse = xyz_matrix.inverse();
        let s = xyz_inverse.mul_vector(wp.to_vector_d());
        let mut v = xyz_matrix.mul_row_vector::<0>(s);
        v = v.mul_row_vector::<1>(s);
        v = v.mul_row_vector::<2>(s);
        v
    }

    /// Returns the RGB to XYZ transformation matrix.
    ///
    /// Per ICC.1:2022-05 Section F.3, the computational model is:
    ///   connection = colorantMatrix × linear_rgb
    ///
    /// The colorant tags (rXYZ, gXYZ, bXYZ) are used directly as matrix columns.
    /// This matches skcms and lcms2 behavior.
    pub fn rgb_to_xyz_matrix(&self) -> Matrix3d {
        self.colorant_matrix()
    }

    /// Computes transform matrix RGB -> XYZ -> RGB
    /// Current profile is used as source, other as destination
    pub fn transform_matrix(&self, dest: &ColorProfile) -> Matrix3d {
        let source = self.rgb_to_xyz_matrix();
        let dst = dest.rgb_to_xyz_matrix();
        let dest_inverse = dst.inverse();
        dest_inverse.mat_mul(source)
    }

    /// Returns volume of colors stored in profile
    pub fn profile_volume(&self) -> Option<f32> {
        let red_prim = self.red_colorant;
        let green_prim = self.green_colorant;
        let blue_prim = self.blue_colorant;
        let tetrahedral_vertices = Matrix3d {
            v: [
                [red_prim.x, red_prim.y, red_prim.z],
                [green_prim.x, green_prim.y, green_prim.z],
                [blue_prim.x, blue_prim.y, blue_prim.z],
            ],
        };
        let det = tetrahedral_vertices.determinant()?;
        Some((det / 6.0f64) as f32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify rgb_to_xyz_matrix returns colorant_matrix directly per ICC.1:2022-05 F.3.
    ///
    /// SM245B.icc is a V2 Samsung monitor profile with D65 colorants and no CHAD tag.
    /// Source: https://skia.googlesource.com/skcms/+/refs/heads/main/profiles/misc/SM245B.icc
    #[test]
    fn test_rgb_to_xyz_matrix_equals_colorant_matrix() {
        let srgb = ColorProfile::new_srgb();
        let rgb_to_xyz = srgb.rgb_to_xyz_matrix();
        let colorants = srgb.colorant_matrix();

        for i in 0..3 {
            for j in 0..3 {
                assert!(
                    (rgb_to_xyz.v[i][j] - colorants.v[i][j]).abs() < 1e-10,
                    "sRGB: rgb_to_xyz_matrix should equal colorant_matrix at [{i}][{j}]"
                );
            }
        }
    }

    #[test]
    fn test_profile_version_parsing_standard() {
        // Standard versions should work
        assert_eq!(
            ProfileVersion::try_from(0x02000000).unwrap(),
            ProfileVersion::V2_0
        );
        assert_eq!(
            ProfileVersion::try_from(0x02400000).unwrap(),
            ProfileVersion::V2_4
        );
        assert_eq!(
            ProfileVersion::try_from(0x04000000).unwrap(),
            ProfileVersion::V4_0
        );
        assert_eq!(
            ProfileVersion::try_from(0x04400000).unwrap(),
            ProfileVersion::V4_4
        );
    }

    #[test]
    fn test_profile_version_parsing_patch_versions() {
        // Patch versions found in real ICC profiles should be accepted

        // v2.0.2 (SM245B.icc) - minor bugfix version
        assert!(
            ProfileVersion::try_from(0x02020000).is_ok(),
            "v2.0.2 should be accepted"
        );

        // v3.4 (ibm-t61.icc, new.icc) - intermediate version
        assert!(
            ProfileVersion::try_from(0x03400000).is_ok(),
            "v3.4 should be accepted"
        );

        // v4.2.9 (lcms_samsung_syncmaster.icc) - patch version
        assert!(
            ProfileVersion::try_from(0x04290000).is_ok(),
            "v4.2.9 should be accepted"
        );
    }

    #[test]
    fn test_profile_version_parsing_rejected() {
        // Invalid and unsupported versions should be rejected

        // v0.0 - invalid version (no such ICC spec exists)
        assert!(
            ProfileVersion::try_from(0x00000000).is_err(),
            "v0.0 should be rejected"
        );

        // v5.0 (iccMAX) - reject because it has different white point requirements
        assert!(
            ProfileVersion::try_from(0x05000000).is_err(),
            "v5.0 should be rejected"
        );

        // v6.0 - future/unknown version
        assert!(
            ProfileVersion::try_from(0x06000000).is_err(),
            "v6.0 should be rejected"
        );
    }

    #[test]
    fn test_profile_version_v4_4_mapping() {
        // V4.4 should map to V4_4, not V4_3 (regression test for typo)
        assert_eq!(
            ProfileVersion::try_from(0x04400000).unwrap(),
            ProfileVersion::V4_4
        );
    }

    #[test]
    fn test_rendering_intent_invalid_defaults_to_perceptual() {
        // Valid values are 0-3. Invalid values default to Perceptual
        // rather than rejecting the profile.
        assert_eq!(
            RenderingIntent::try_from(0x01000000).unwrap(),
            RenderingIntent::Perceptual
        );
        assert_eq!(
            RenderingIntent::try_from(0x04000000).unwrap(),
            RenderingIntent::Perceptual
        );
        assert_eq!(
            RenderingIntent::try_from(0xFFFFFFFF).unwrap(),
            RenderingIntent::Perceptual
        );
    }
}
