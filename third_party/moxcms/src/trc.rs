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
use crate::cicp::create_rec709_parametric;
use crate::math::m_clamp;
use crate::transform::PointeeSizeExpressible;
use crate::{CmsError, ColorProfile, DataColorSpace, Rgb, TransferCharacteristics};
use num_traits::AsPrimitive;
use pxfm::f_powf;

#[derive(Clone, Debug, PartialEq)]
pub enum ToneReprCurve {
    Parametric(Vec<f32>),
}

impl ToneReprCurve {
    pub fn inverse(&self) -> Result<ToneReprCurve, CmsError> {
        match self {
            ToneReprCurve::Parametric(parametric) => ParametricCurve::new(parametric)
                .and_then(|x| x.invert())
                .map(|x| ToneReprCurve::Parametric([x.g, x.a, x.b, x.c, x.d, x.e, x.f].to_vec()))
                .ok_or(CmsError::BuildTransferFunction),
        }
    }

    /// Creates tone curve evaluator
    pub fn make_linear_evaluator(
        &self,
    ) -> Result<Box<dyn ToneCurveEvaluator + Send + Sync>, CmsError> {
        match self {
            ToneReprCurve::Parametric(parametric) => {
                let parametric_curve =
                    ParametricCurve::new(parametric).ok_or(CmsError::BuildTransferFunction)?;
                Ok(Box::new(ToneCurveParametricEvaluator {
                    parametric: parametric_curve,
                }))
            }
        }
    }

    /// Creates tone curve evaluator from transfer characteristics
    pub fn make_cicp_linear_evaluator(
        transfer_characteristics: TransferCharacteristics,
    ) -> Result<Box<dyn ToneCurveEvaluator + Send + Sync>, CmsError> {
        if !transfer_characteristics.has_transfer_curve() {
            return Err(CmsError::BuildTransferFunction);
        }
        Ok(Box::new(ToneCurveCicpLinearEvaluator {
            trc: transfer_characteristics,
        }))
    }

    /// Creates tone curve inverse evaluator
    pub fn make_gamma_evaluator(
        &self,
    ) -> Result<Box<dyn ToneCurveEvaluator + Send + Sync>, CmsError> {
        match self {
            ToneReprCurve::Parametric(parametric) => {
                let parametric_curve = ParametricCurve::new(parametric)
                    .and_then(|x| x.invert())
                    .ok_or(CmsError::BuildTransferFunction)?;
                Ok(Box::new(ToneCurveParametricEvaluator {
                    parametric: parametric_curve,
                }))
            }
        }
    }

    /// Creates tone curve inverse evaluator from transfer characteristics
    pub fn make_cicp_gamma_evaluator(
        transfer_characteristics: TransferCharacteristics,
    ) -> Result<Box<dyn ToneCurveEvaluator + Send + Sync>, CmsError> {
        if !transfer_characteristics.has_transfer_curve() {
            return Err(CmsError::BuildTransferFunction);
        }
        Ok(Box::new(ToneCurveCicpGammaEvaluator {
            trc: transfer_characteristics,
        }))
    }
}

struct ToneCurveCicpLinearEvaluator {
    trc: TransferCharacteristics,
}

struct ToneCurveCicpGammaEvaluator {
    trc: TransferCharacteristics,
}

impl ToneCurveEvaluator for ToneCurveCicpLinearEvaluator {
    fn evaluate_tristimulus(&self, rgb: Rgb<f32>) -> Rgb<f32> {
        Rgb::new(
            self.trc.linearize(rgb.r as f64) as f32,
            self.trc.linearize(rgb.g as f64) as f32,
            self.trc.linearize(rgb.b as f64) as f32,
        )
    }

    fn evaluate_value(&self, value: f32) -> f32 {
        self.trc.linearize(value as f64) as f32
    }
}

impl ToneCurveEvaluator for ToneCurveCicpGammaEvaluator {
    fn evaluate_tristimulus(&self, rgb: Rgb<f32>) -> Rgb<f32> {
        Rgb::new(
            self.trc.gamma(rgb.r as f64) as f32,
            self.trc.gamma(rgb.g as f64) as f32,
            self.trc.gamma(rgb.b as f64) as f32,
        )
    }

    fn evaluate_value(&self, value: f32) -> f32 {
        self.trc.gamma(value as f64) as f32
    }
}

/// Creates Tone Reproduction curve from gamma
pub fn curve_from_gamma(gamma: f32) -> ToneReprCurve {
    ToneReprCurve::Parametric(vec![gamma])
}

#[derive(Debug)]
pub struct ParametricCurve {
    pub g: f32,
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub e: f32,
    pub f: f32,
}

impl ParametricCurve {
    #[allow(clippy::many_single_char_names)]
    pub fn new(params: &[f32]) -> Option<ParametricCurve> {
        // convert from the variable number of parameters
        // contained in profiles to a unified representation.
        let g: f32 = params[0];
        match params[1..] {
            [] => Some(ParametricCurve {
                g,
                a: 1.,
                b: 0.,
                c: 0.,
                d: 0.,
                e: 0.,
                f: 0.,
            }),
            [a, b] => Some(ParametricCurve {
                g,
                a,
                b,
                c: 0.,
                d: -b / a,
                e: 0.,
                f: 0.,
            }),
            [a, b, c] => Some(ParametricCurve {
                g,
                a,
                b,
                c: 0.,
                d: -b / a,
                e: c,
                f: c,
            }),
            [a, b, c, d] => Some(ParametricCurve {
                g,
                a,
                b,
                c,
                d,
                e: 0.,
                f: 0.,
            }),
            [a, b, c, d, e, f] => Some(ParametricCurve {
                g,
                a,
                b,
                c,
                d,
                e,
                f,
            }),
            _ => None,
        }
    }

    pub fn eval(&self, x: f32) -> f32 {
        if x < self.d {
            self.c * x + self.f
        } else {
            f_powf(self.a * x + self.b, self.g) + self.e
        }
    }

    #[allow(dead_code)]
    #[allow(clippy::many_single_char_names)]
    pub fn invert(&self) -> Option<ParametricCurve> {
        // First check if the function is continuous at the cross-over point d.
        let d1 = f_powf(self.a * self.d + self.b, self.g) + self.e;
        let d2 = self.c * self.d + self.f;

        if (d1 - d2).abs() > 0.1 {
            return None;
        }
        let d = d1;

        // y = (a * x + b)^g + e
        // y - e = (a * x + b)^g
        // (y - e)^(1/g) = a*x + b
        // (y - e)^(1/g) - b = a*x
        // (y - e)^(1/g)/a - b/a = x
        // ((y - e)/a^g)^(1/g) - b/a = x
        // ((1/(a^g)) * y - e/(a^g))^(1/g) - b/a = x
        let a = 1. / f_powf(self.a, self.g);
        let b = -self.e / f_powf(self.a, self.g);
        let g = 1. / self.g;
        let e = -self.b / self.a;

        // y = c * x + f
        // y - f = c * x
        // y/c - f/c = x
        let (c, f);
        if d <= 0. {
            c = 1.;
            f = 0.;
        } else {
            c = 1. / self.c;
            f = -self.f / self.c;
        }

        // if self.d > 0. and self.c == 0 as is likely with type 1 and 2 parametric function
        // then c and f will not be finite.
        if !(g.is_finite()
            && a.is_finite()
            && b.is_finite()
            && c.is_finite()
            && d.is_finite()
            && e.is_finite()
            && f.is_finite())
        {
            return None;
        }

        Some(ParametricCurve {
            g,
            a,
            b,
            c,
            d,
            e,
            f,
        })
    }
}

fn linear_curve_parametric<T: PointeeSizeExpressible, const N: usize, const BIT_DEPTH: usize>(
    params: &[f32],
) -> Option<Box<[f32; N]>> {
    let params = ParametricCurve::new(params)?;
    let mut gamma_table = Box::new([0f32; N]);
    let max_value = if T::FINITE {
        (1 << BIT_DEPTH) - 1
    } else {
        T::NOT_FINITE_LINEAR_TABLE_SIZE - 1
    };
    let cap_value = if T::FINITE {
        1 << BIT_DEPTH
    } else {
        T::NOT_FINITE_LINEAR_TABLE_SIZE
    };
    let scale_value = 1f32 / max_value as f32;
    for (i, g) in gamma_table.iter_mut().enumerate().take(cap_value) {
        let x = i as f32 * scale_value;
        *g = m_clamp(params.eval(x), 0.0, 1.0);
    }
    Some(gamma_table)
}

fn make_gamma_parametric_table<
    T: Default + Copy + 'static + PointeeSizeExpressible,
    const BUCKET: usize,
    const N: usize,
    const BIT_DEPTH: usize,
>(
    parametric_curve: ParametricCurve,
) -> Box<[T; BUCKET]>
where
    f32: AsPrimitive<T>,
{
    let mut table = Box::new([T::default(); BUCKET]);
    let scale = 1f32 / (N - 1) as f32;
    let cap = ((1 << BIT_DEPTH) - 1) as f32;
    if T::FINITE {
        for (v, output) in table.iter_mut().take(N).enumerate() {
            *output = (cap * parametric_curve.eval(v as f32 * scale))
                .round()
                .as_();
        }
    } else {
        for (v, output) in table.iter_mut().take(N).enumerate() {
            *output = (cap * parametric_curve.eval(v as f32 * scale)).as_();
        }
    }
    table
}

#[inline]
fn compare_parametric(src: &[f32], dst: &[f32]) -> bool {
    for (src, dst) in src.iter().zip(dst.iter()) {
        if (src - dst).abs() > 1e-4 {
            return false;
        }
    }
    true
}

impl ToneReprCurve {
    pub(crate) fn build_linearize_table<
        T: PointeeSizeExpressible,
        const N: usize,
        const BIT_DEPTH: usize,
    >(
        &self,
    ) -> Option<Box<[f32; N]>> {
        match self {
            ToneReprCurve::Parametric(params) => linear_curve_parametric::<T, N, BIT_DEPTH>(params),
        }
    }

    pub(crate) fn build_gamma_table<
        T: Default + Copy + 'static + PointeeSizeExpressible,
        const BUCKET: usize,
        const N: usize,
        const BIT_DEPTH: usize,
    >(
        &self,
    ) -> Option<Box<[T; BUCKET]>>
    where
        f32: AsPrimitive<T>,
        u32: AsPrimitive<T>,
    {
        match self {
            ToneReprCurve::Parametric(params) => {
                if params.len() == 5 {
                    let srgb_params = vec![2.4, 1. / 1.055, 0.055 / 1.055, 1. / 12.92, 0.04045];
                    let rec709_params = create_rec709_parametric();

                    let mut lc_params: [f32; 5] = [0.; 5];
                    for (dst, src) in lc_params.iter_mut().zip(params.iter()) {
                        *dst = *src;
                    }

                    if compare_parametric(lc_params.as_slice(), srgb_params.as_slice()) {
                        return Some(
                            TransferCharacteristics::Srgb
                                .make_gamma_table::<T, BUCKET, N>(BIT_DEPTH),
                        );
                    }

                    if compare_parametric(lc_params.as_slice(), rec709_params.as_slice()) {
                        return Some(
                            TransferCharacteristics::Bt709
                                .make_gamma_table::<T, BUCKET, N>(BIT_DEPTH),
                        );
                    }
                }

                ParametricCurve::new(params)?
                    .invert()
                    .map(|x| make_gamma_parametric_table::<T, BUCKET, N, BIT_DEPTH>(x))
            }
        }
    }
}

impl ColorProfile {
    /// Produces LUT for 8 bit tone linearization
    pub fn build_8bit_lin_table(
        &self,
        trc: &Option<ToneReprCurve>,
    ) -> Result<Box<[f32; 256]>, CmsError> {
        trc.as_ref()
            .and_then(|trc| trc.build_linearize_table::<u8, 256, 8>())
            .ok_or(CmsError::BuildTransferFunction)
    }

    /// Produces LUT for Gray transfer curve with N depth
    pub fn build_gray_linearize_table<
        T: PointeeSizeExpressible,
        const N: usize,
        const BIT_DEPTH: usize,
    >(
        &self,
    ) -> Result<Box<[f32; N]>, CmsError> {
        self.gray_trc
            .as_ref()
            .and_then(|trc| trc.build_linearize_table::<T, N, BIT_DEPTH>())
            .ok_or(CmsError::BuildTransferFunction)
    }

    /// Produces LUT for Red transfer curve with N depth
    pub fn build_r_linearize_table<
        T: PointeeSizeExpressible,
        const N: usize,
        const BIT_DEPTH: usize,
    >(
        &self,
        use_cicp: bool,
    ) -> Result<Box<[f32; N]>, CmsError> {
        if use_cicp {
            if let Some(tc) = self.cicp.as_ref().map(|c| c.transfer_characteristics) {
                if tc.has_transfer_curve() {
                    return Ok(tc.make_linear_table::<T, N, BIT_DEPTH>());
                }
            }
        }
        self.red_trc
            .as_ref()
            .and_then(|trc| trc.build_linearize_table::<T, N, BIT_DEPTH>())
            .ok_or(CmsError::BuildTransferFunction)
    }

    /// Produces LUT for Green transfer curve with N depth
    pub fn build_g_linearize_table<
        T: PointeeSizeExpressible,
        const N: usize,
        const BIT_DEPTH: usize,
    >(
        &self,
        use_cicp: bool,
    ) -> Result<Box<[f32; N]>, CmsError> {
        if use_cicp {
            if let Some(tc) = self.cicp.as_ref().map(|c| c.transfer_characteristics) {
                if tc.has_transfer_curve() {
                    return Ok(tc.make_linear_table::<T, N, BIT_DEPTH>());
                }
            }
        }
        self.green_trc
            .as_ref()
            .and_then(|trc| trc.build_linearize_table::<T, N, BIT_DEPTH>())
            .ok_or(CmsError::BuildTransferFunction)
    }

    /// Produces LUT for Blue transfer curve with N depth
    pub fn build_b_linearize_table<
        T: PointeeSizeExpressible,
        const N: usize,
        const BIT_DEPTH: usize,
    >(
        &self,
        use_cicp: bool,
    ) -> Result<Box<[f32; N]>, CmsError> {
        if use_cicp {
            if let Some(tc) = self.cicp.as_ref().map(|c| c.transfer_characteristics) {
                if tc.has_transfer_curve() {
                    return Ok(tc.make_linear_table::<T, N, BIT_DEPTH>());
                }
            }
        }
        self.blue_trc
            .as_ref()
            .and_then(|trc| trc.build_linearize_table::<T, N, BIT_DEPTH>())
            .ok_or(CmsError::BuildTransferFunction)
    }

    /// Build gamma table for 8 bit depth
    /// Only 4092 first bins are used and values scaled in 0..255
    pub fn build_8bit_gamma_table(
        &self,
        trc: &Option<ToneReprCurve>,
        use_cicp: bool,
    ) -> Result<Box<[u16; 65536]>, CmsError> {
        self.build_gamma_table::<u16, 65536, 4092, 8>(trc, use_cicp)
    }

    /// Build gamma table for 10 bit depth
    /// Only 8192 first bins are used and values scaled in 0..1023
    pub fn build_10bit_gamma_table(
        &self,
        trc: &Option<ToneReprCurve>,
        use_cicp: bool,
    ) -> Result<Box<[u16; 65536]>, CmsError> {
        self.build_gamma_table::<u16, 65536, 8192, 10>(trc, use_cicp)
    }

    /// Build gamma table for 12 bit depth
    /// Only 16384 first bins are used and values scaled in 0..4095
    pub fn build_12bit_gamma_table(
        &self,
        trc: &Option<ToneReprCurve>,
        use_cicp: bool,
    ) -> Result<Box<[u16; 65536]>, CmsError> {
        self.build_gamma_table::<u16, 65536, 16384, 12>(trc, use_cicp)
    }

    /// Build gamma table for 16 bit depth
    /// Only 16384 first bins are used and values scaled in 0..65535
    pub fn build_16bit_gamma_table(
        &self,
        trc: &Option<ToneReprCurve>,
        use_cicp: bool,
    ) -> Result<Box<[u16; 65536]>, CmsError> {
        self.build_gamma_table::<u16, 65536, 65536, 16>(trc, use_cicp)
    }

    /// Builds gamma table checking CICP for Transfer characteristics first.
    pub fn build_gamma_table<
        T: Default + Copy + 'static + PointeeSizeExpressible,
        const BUCKET: usize,
        const N: usize,
        const BIT_DEPTH: usize,
    >(
        &self,
        trc: &Option<ToneReprCurve>,
        use_cicp: bool,
    ) -> Result<Box<[T; BUCKET]>, CmsError>
    where
        f32: AsPrimitive<T>,
        u32: AsPrimitive<T>,
    {
        if use_cicp {
            if let Some(tc) = self.cicp.as_ref().map(|c| c.transfer_characteristics) {
                if tc.has_transfer_curve() {
                    return Ok(tc.make_gamma_table::<T, BUCKET, N>(BIT_DEPTH));
                }
            }
        }
        trc.as_ref()
            .and_then(|trc| trc.build_gamma_table::<T, BUCKET, N, BIT_DEPTH>())
            .ok_or(CmsError::BuildTransferFunction)
    }

    #[cfg(feature = "extended_range")]
    /// Checks if profile gamma can work in extended precision and we have implementation for this
    pub(crate) fn try_extended_gamma_evaluator(
        &self,
    ) -> Option<Box<dyn ToneCurveEvaluator + Send + Sync>> {
        if let Some(tc) = self.cicp.as_ref().map(|c| c.transfer_characteristics) {
            if tc.has_transfer_curve() {
                return Some(Box::new(ToneCurveCicpEvaluator {
                    rgb_trc: tc.extended_gamma_tristimulus(),
                    trc: tc.extended_gamma_single(),
                }));
            }
        }
        if !self.are_all_trc_the_same() {
            return None;
        }
        let reference_trc = if self.color_space == DataColorSpace::Gray {
            self.gray_trc.as_ref()
        } else {
            self.red_trc.as_ref()
        };
        if let Some(red_trc) = reference_trc {
            return Self::make_gamma_evaluator_all_the_same(red_trc);
        }
        None
    }

    #[cfg(feature = "extended_range")]
    fn make_gamma_evaluator_all_the_same(
        red_trc: &ToneReprCurve,
    ) -> Option<Box<dyn ToneCurveEvaluator + Send + Sync>> {
        match red_trc {
            ToneReprCurve::Parametric(params) => {
                if params.len() == 5 {
                    let srgb_params = vec![2.4, 1. / 1.055, 0.055 / 1.055, 1. / 12.92, 0.04045];
                    let rec709_params = create_rec709_parametric();

                    let mut lc_params: [f32; 5] = [0.; 5];
                    for (dst, src) in lc_params.iter_mut().zip(params.iter()) {
                        *dst = *src;
                    }

                    #[cfg(feature = "extended_range")]
                    if compare_parametric(lc_params.as_slice(), srgb_params.as_slice()) {
                        return Some(Box::new(ToneCurveCicpEvaluator {
                            rgb_trc: TransferCharacteristics::Srgb.extended_gamma_tristimulus(),
                            trc: TransferCharacteristics::Srgb.extended_gamma_single(),
                        }));
                    }

                    #[cfg(feature = "extended_range")]
                    if compare_parametric(lc_params.as_slice(), rec709_params.as_slice()) {
                        return Some(Box::new(ToneCurveCicpEvaluator {
                            rgb_trc: TransferCharacteristics::Bt709.extended_gamma_tristimulus(),
                            trc: TransferCharacteristics::Bt709.extended_gamma_single(),
                        }));
                    }
                }

                let parametric_curve = ParametricCurve::new(params);
                if let Some(v) = parametric_curve?.invert() {
                    return Some(Box::new(ToneCurveParametricEvaluator { parametric: v }));
                }
                None
            }
        }
    }

    /// Check if all TRC are the same
    pub(crate) fn are_all_trc_the_same(&self) -> bool {
        if self.color_space == DataColorSpace::Gray {
            return true;
        }
        if let (Some(red_trc), Some(green_trc), Some(blue_trc)) =
            (&self.red_trc, &self.green_trc, &self.blue_trc)
        {
            return red_trc == green_trc || green_trc == blue_trc;
        }
        false
    }

    #[cfg(feature = "extended_range")]
    /// Checks if profile linearization can work in extended precision and we have implementation for this
    pub(crate) fn try_extended_linearizing_evaluator(
        &self,
    ) -> Option<Box<dyn ToneCurveEvaluator + Send + Sync>> {
        if let Some(tc) = self.cicp.as_ref().map(|c| c.transfer_characteristics) {
            if tc.has_transfer_curve() {
                return Some(Box::new(ToneCurveCicpEvaluator {
                    rgb_trc: tc.extended_linear_tristimulus(),
                    trc: tc.extended_linear_single(),
                }));
            }
        }
        if !self.are_all_trc_the_same() {
            return None;
        }
        let reference_trc = if self.color_space == DataColorSpace::Gray {
            self.gray_trc.as_ref()
        } else {
            self.red_trc.as_ref()
        };
        if let Some(red_trc) = reference_trc {
            if let Some(value) = Self::make_linear_curve_evaluator_all_the_same(red_trc) {
                return value;
            }
        }
        None
    }

    #[cfg(feature = "extended_range")]
    fn make_linear_curve_evaluator_all_the_same(
        evaluator_curve: &ToneReprCurve,
    ) -> Option<Option<Box<dyn ToneCurveEvaluator + Send + Sync>>> {
        match evaluator_curve {
            ToneReprCurve::Parametric(params) => {
                if params.len() == 5 {
                    let srgb_params = vec![2.4, 1. / 1.055, 0.055 / 1.055, 1. / 12.92, 0.04045];
                    let rec709_params = create_rec709_parametric();

                    let mut lc_params: [f32; 5] = [0.; 5];
                    for (dst, src) in lc_params.iter_mut().zip(params.iter()) {
                        *dst = *src;
                    }

                    if compare_parametric(lc_params.as_slice(), srgb_params.as_slice()) {
                        return Some(Some(Box::new(ToneCurveCicpEvaluator {
                            rgb_trc: TransferCharacteristics::Srgb.extended_linear_tristimulus(),
                            trc: TransferCharacteristics::Srgb.extended_linear_single(),
                        })));
                    }

                    if compare_parametric(lc_params.as_slice(), rec709_params.as_slice()) {
                        return Some(Some(Box::new(ToneCurveCicpEvaluator {
                            rgb_trc: TransferCharacteristics::Bt709.extended_linear_tristimulus(),
                            trc: TransferCharacteristics::Bt709.extended_linear_single(),
                        })));
                    }
                }

                let parametric_curve = ParametricCurve::new(params);
                if let Some(v) = parametric_curve {
                    return Some(Some(Box::new(ToneCurveParametricEvaluator {
                        parametric: v,
                    })));
                }
            }
        }
        None
    }
}

#[cfg(feature = "extended_range")]
pub(crate) struct ToneCurveCicpEvaluator {
    rgb_trc: fn(Rgb<f32>) -> Rgb<f32>,
    trc: fn(f32) -> f32,
}

pub(crate) struct ToneCurveParametricEvaluator {
    parametric: ParametricCurve,
}

#[cfg(feature = "extended_range")]
impl ToneCurveEvaluator for ToneCurveCicpEvaluator {
    fn evaluate_tristimulus(&self, rgb: Rgb<f32>) -> Rgb<f32> {
        (self.rgb_trc)(rgb)
    }

    fn evaluate_value(&self, value: f32) -> f32 {
        (self.trc)(value)
    }
}

impl ToneCurveEvaluator for ToneCurveParametricEvaluator {
    fn evaluate_tristimulus(&self, rgb: Rgb<f32>) -> Rgb<f32> {
        Rgb::new(
            self.parametric.eval(rgb.r),
            self.parametric.eval(rgb.g),
            self.parametric.eval(rgb.b),
        )
    }

    fn evaluate_value(&self, value: f32) -> f32 {
        self.parametric.eval(value)
    }
}

pub trait ToneCurveEvaluator {
    fn evaluate_tristimulus(&self, rgb: Rgb<f32>) -> Rgb<f32>;
    fn evaluate_value(&self, value: f32) -> f32;
}
