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

pub(crate) const TAG_SIZE: usize = 12;

#[derive(Debug, Copy, Clone, Ord, PartialOrd, Eq, PartialEq, Hash)]
pub(crate) enum Tag {
    RedXyz,
    GreenXyz,
    BlueXyz,
    RedToneReproduction,
    GreenToneReproduction,
    BlueToneReproduction,
    GreyToneReproduction,
    MediaWhitePoint,
    CodeIndependentPoints,
    ChromaticAdaptation,
    ProfileDescription,
    Copyright,
    ViewingConditionsDescription,
    DeviceManufacturer,
    DeviceModel,
    Luminance,
    ObserverConditions,
}

impl From<Tag> for u32 {
    fn from(value: Tag) -> Self {
        match value {
            Tag::RedXyz => u32::from_ne_bytes(*b"rXYZ").to_be(),
            Tag::GreenXyz => u32::from_ne_bytes(*b"gXYZ").to_be(),
            Tag::BlueXyz => u32::from_ne_bytes(*b"bXYZ").to_be(),
            Tag::RedToneReproduction => u32::from_ne_bytes(*b"rTRC").to_be(),
            Tag::GreenToneReproduction => u32::from_ne_bytes(*b"gTRC").to_be(),
            Tag::BlueToneReproduction => u32::from_ne_bytes(*b"bTRC").to_be(),
            Tag::GreyToneReproduction => u32::from_ne_bytes(*b"kTRC").to_be(),
            Tag::MediaWhitePoint => u32::from_ne_bytes(*b"wtpt").to_be(),
            Tag::CodeIndependentPoints => u32::from_ne_bytes(*b"cicp").to_be(),
            Tag::ChromaticAdaptation => u32::from_ne_bytes(*b"chad").to_be(),
            Tag::ProfileDescription => u32::from_ne_bytes(*b"desc").to_be(),
            Tag::Copyright => u32::from_ne_bytes(*b"cprt").to_be(),
            Tag::ViewingConditionsDescription => u32::from_ne_bytes(*b"vued").to_be(),
            Tag::DeviceManufacturer => u32::from_ne_bytes(*b"dmnd").to_be(),
            Tag::DeviceModel => u32::from_ne_bytes(*b"dmdd").to_be(),
            Tag::Luminance => u32::from_ne_bytes(*b"lumi").to_be(),
            Tag::ObserverConditions => u32::from_ne_bytes(*b"view").to_be(),
        }
    }
}

#[derive(Debug, Copy, Clone, Ord, PartialOrd, Eq, PartialEq, Hash)]
pub(crate) enum TagTypeDefinition {
    MultiLocalizedUnicode,
    ParametricToneCurve,
    Xyz,
    DefViewingConditions,
    Cicp,
    S15Fixed16Array,
}

impl From<TagTypeDefinition> for u32 {
    fn from(value: TagTypeDefinition) -> Self {
        match value {
            TagTypeDefinition::MultiLocalizedUnicode => u32::from_ne_bytes(*b"mluc").to_be(),
            TagTypeDefinition::ParametricToneCurve => u32::from_ne_bytes(*b"para").to_be(),
            TagTypeDefinition::Xyz => u32::from_ne_bytes(*b"XYZ ").to_be(),
            TagTypeDefinition::DefViewingConditions => u32::from_ne_bytes(*b"view").to_be(),
            TagTypeDefinition::Cicp => u32::from_ne_bytes(*b"cicp").to_be(),
            TagTypeDefinition::S15Fixed16Array => u32::from_ne_bytes(*b"sf32").to_be(),
        }
    }
}
