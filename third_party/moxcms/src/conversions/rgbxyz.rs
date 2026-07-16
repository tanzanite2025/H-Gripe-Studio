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
#[cfg(feature = "in_place")]
use crate::InPlaceTransformExecutor;
use crate::{CmsError, Layout, Matrix3, Matrix3f, TransformExecutor};
use num_traits::AsPrimitive;
use std::sync::Arc;

pub(crate) struct TransformMatrixShaper<T: Clone, const BUCKET: usize> {
    pub(crate) r_linear: Box<[f32; BUCKET]>,
    pub(crate) g_linear: Box<[f32; BUCKET]>,
    pub(crate) b_linear: Box<[f32; BUCKET]>,
    pub(crate) r_gamma: Box<[T; 65536]>,
    pub(crate) g_gamma: Box<[T; 65536]>,
    pub(crate) b_gamma: Box<[T; 65536]>,
    pub(crate) adaptation_matrix: Matrix3f,
}

impl<T: Clone, const BUCKET: usize> TransformMatrixShaper<T, BUCKET> {
    #[inline(never)]
    #[allow(dead_code)]
    fn convert_to_v(self) -> TransformMatrixShaperV<T> {
        TransformMatrixShaperV {
            r_linear: self.r_linear.iter().copied().collect(),
            g_linear: self.g_linear.iter().copied().collect(),
            b_linear: self.b_linear.iter().copied().collect(),
            r_gamma: self.r_gamma,
            g_gamma: self.g_gamma,
            b_gamma: self.b_gamma,
            adaptation_matrix: self.adaptation_matrix,
        }
    }
}

#[allow(dead_code)]
pub(crate) struct TransformMatrixShaperV<T: Clone> {
    pub(crate) r_linear: Vec<f32>,
    pub(crate) g_linear: Vec<f32>,
    pub(crate) b_linear: Vec<f32>,
    pub(crate) r_gamma: Box<[T; 65536]>,
    pub(crate) g_gamma: Box<[T; 65536]>,
    pub(crate) b_gamma: Box<[T; 65536]>,
    pub(crate) adaptation_matrix: Matrix3f,
}

/// Low memory footprint optimized routine for matrix shaper profiles with the same
/// Gamma and linear curves.
pub(crate) struct TransformMatrixShaperOptimized<T: Clone, const BUCKET: usize> {
    pub(crate) linear: Box<[f32; BUCKET]>,
    pub(crate) gamma: Box<[T; 65536]>,
    pub(crate) adaptation_matrix: Matrix3f,
}

#[allow(dead_code)]
impl<T: Clone, const BUCKET: usize> TransformMatrixShaperOptimized<T, BUCKET> {
    fn convert_to_v(self) -> TransformMatrixShaperOptimizedV<T> {
        TransformMatrixShaperOptimizedV {
            linear: self.linear.iter().copied().collect::<Vec<_>>(),
            gamma: self.gamma,
            adaptation_matrix: self.adaptation_matrix,
        }
    }
}

/// Low memory footprint optimized routine for matrix shaper profiles with the same
/// Gamma and linear curves.
#[allow(dead_code)]
pub(crate) struct TransformMatrixShaperOptimizedV<T: Clone> {
    pub(crate) linear: Vec<f32>,
    pub(crate) gamma: Box<[T; 65536]>,
    pub(crate) adaptation_matrix: Matrix3f,
}

impl<T: Clone + PointeeSizeExpressible, const BUCKET: usize> TransformMatrixShaper<T, BUCKET> {
    #[inline(never)]
    #[allow(dead_code)]
    pub(crate) fn to_q2_13_i<R: Copy + 'static + Default, const PRECISION: i32>(
        &self,
        gamma_lut: usize,
        bit_depth: usize,
    ) -> TransformMatrixShaperFp<R, T>
    where
        f32: AsPrimitive<R>,
    {
        let linear_scale = if T::FINITE {
            let lut_scale = (gamma_lut - 1) as f32 / ((1 << bit_depth) - 1) as f32;
            ((1 << bit_depth) - 1) as f32 * lut_scale
        } else {
            let lut_scale = (gamma_lut - 1) as f32 / (T::NOT_FINITE_LINEAR_TABLE_SIZE - 1) as f32;
            (T::NOT_FINITE_LINEAR_TABLE_SIZE - 1) as f32 * lut_scale
        };
        let new_box_r = self
            .r_linear
            .iter()
            .map(|&x| (x * linear_scale).round().as_())
            .collect::<Vec<R>>();
        let new_box_g = self
            .g_linear
            .iter()
            .map(|&x| (x * linear_scale).round().as_())
            .collect::<Vec<R>>();
        let new_box_b = self
            .b_linear
            .iter()
            .map(|&x| (x * linear_scale).round().as_())
            .collect::<Vec<_>>();
        let scale: f32 = (1i32 << PRECISION) as f32;
        let source_matrix = self.adaptation_matrix;
        let mut dst_matrix = Matrix3::<i16> { v: [[0i16; 3]; 3] };
        for i in 0..3 {
            for j in 0..3 {
                dst_matrix.v[i][j] = (source_matrix.v[i][j] * scale) as i16;
            }
        }
        TransformMatrixShaperFp {
            r_linear: new_box_r,
            g_linear: new_box_g,
            b_linear: new_box_b,
            r_gamma: self.r_gamma.clone(),
            g_gamma: self.g_gamma.clone(),
            b_gamma: self.b_gamma.clone(),
            adaptation_matrix: dst_matrix,
        }
    }
}

impl<T: Clone + PointeeSizeExpressible, const BUCKET: usize>
    TransformMatrixShaperOptimized<T, BUCKET>
{
    #[allow(dead_code)]
    pub(crate) fn to_q2_13_n<
        R: Copy + 'static + Default,
        const PRECISION: i32,
        const LINEAR_CAP: usize,
    >(
        &self,
        gamma_lut: usize,
        bit_depth: usize,
    ) -> TransformMatrixShaperFixedPointOpt<R, i16, T, BUCKET>
    where
        f32: AsPrimitive<R>,
    {
        let linear_scale = if T::FINITE {
            let lut_scale = (gamma_lut - 1) as f32 / ((1 << bit_depth) - 1) as f32;
            ((1 << bit_depth) - 1) as f32 * lut_scale
        } else {
            let lut_scale = (gamma_lut - 1) as f32 / (T::NOT_FINITE_LINEAR_TABLE_SIZE - 1) as f32;
            (T::NOT_FINITE_LINEAR_TABLE_SIZE - 1) as f32 * lut_scale
        };
        let mut new_box_linear = Box::new([R::default(); BUCKET]);
        for (dst, src) in new_box_linear.iter_mut().zip(self.linear.iter()) {
            *dst = (*src * linear_scale).round().as_();
        }
        let scale: f32 = (1i32 << PRECISION) as f32;
        let source_matrix = self.adaptation_matrix;
        let mut dst_matrix = Matrix3::<i16> {
            v: [[i16::default(); 3]; 3],
        };
        for i in 0..3 {
            for j in 0..3 {
                dst_matrix.v[i][j] = (source_matrix.v[i][j] * scale) as i16;
            }
        }
        TransformMatrixShaperFixedPointOpt {
            linear: new_box_linear,
            gamma: self.gamma.clone(),
            adaptation_matrix: dst_matrix,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn to_q2_13_i<R: Copy + 'static + Default, const PRECISION: i32>(
        &self,
        gamma_lut: usize,
        bit_depth: usize,
    ) -> TransformMatrixShaperFpOptVec<R, i16, T>
    where
        f32: AsPrimitive<R>,
    {
        let linear_scale = if T::FINITE {
            let lut_scale = (gamma_lut - 1) as f32 / ((1 << bit_depth) - 1) as f32;
            ((1 << bit_depth) - 1) as f32 * lut_scale
        } else {
            let lut_scale = (gamma_lut - 1) as f32 / (T::NOT_FINITE_LINEAR_TABLE_SIZE - 1) as f32;
            (T::NOT_FINITE_LINEAR_TABLE_SIZE - 1) as f32 * lut_scale
        };
        let new_box_linear = self
            .linear
            .iter()
            .map(|&x| (x * linear_scale).round().as_())
            .collect::<Vec<R>>();
        let scale: f32 = (1i32 << PRECISION) as f32;
        let source_matrix = self.adaptation_matrix;
        let mut dst_matrix = Matrix3::<i16> {
            v: [[i16::default(); 3]; 3],
        };
        for i in 0..3 {
            for j in 0..3 {
                dst_matrix.v[i][j] = (source_matrix.v[i][j] * scale) as i16;
            }
        }
        TransformMatrixShaperFpOptVec {
            linear: new_box_linear,
            gamma: self.gamma.clone(),
            adaptation_matrix: dst_matrix,
        }
    }
}

#[allow(unused)]
struct TransformMatrixShaperScalar<
    T: Clone,
    const SRC_LAYOUT: u8,
    const DST_LAYOUT: u8,
    const LINEAR_CAP: usize,
> {
    pub(crate) profile: TransformMatrixShaper<T, LINEAR_CAP>,
    pub(crate) gamma_lut: usize,
    pub(crate) bit_depth: usize,
}

#[allow(unused)]
struct TransformMatrixShaperOptScalar<
    T: Clone,
    const SRC_LAYOUT: u8,
    const DST_LAYOUT: u8,
    const LINEAR_CAP: usize,
> {
    pub(crate) profile: TransformMatrixShaperOptimized<T, LINEAR_CAP>,
    pub(crate) gamma_lut: usize,
    pub(crate) bit_depth: usize,
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[allow(unused)]
macro_rules! create_rgb_xyz_dependant_executor {
    ($dep_name: ident, $dependant: ident, $shaper: ident) => {
        pub(crate) fn $dep_name<
            T: Clone + Send + Sync + Default + PointeeSizeExpressible + Copy + 'static,
            const LINEAR_CAP: usize,
        >(
            src_layout: Layout,
            dst_layout: Layout,
            profile: $shaper<T, LINEAR_CAP>,
            gamma_lut: usize,
            bit_depth: usize,
        ) -> Result<Arc<dyn TransformExecutor<T> + Send + Sync>, CmsError>
        where
            u32: AsPrimitive<T>,
        {
            if (src_layout == Layout::Rgba) && (dst_layout == Layout::Rgba) {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgba as u8 },
                    { Layout::Rgba as u8 },
                    LINEAR_CAP,
                > {
                    profile,
                    bit_depth,
                    gamma_lut,
                }));
            } else if (src_layout == Layout::Rgb) && (dst_layout == Layout::Rgba) {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgb as u8 },
                    { Layout::Rgba as u8 },
                    LINEAR_CAP,
                > {
                    profile,
                    bit_depth,
                    gamma_lut,
                }));
            } else if (src_layout == Layout::Rgba) && (dst_layout == Layout::Rgb) {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgba as u8 },
                    { Layout::Rgb as u8 },
                    LINEAR_CAP,
                > {
                    profile,
                    bit_depth,
                    gamma_lut,
                }));
            } else if (src_layout == Layout::Rgb) && (dst_layout == Layout::Rgb) {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgb as u8 },
                    { Layout::Rgb as u8 },
                    LINEAR_CAP,
                > {
                    profile,
                    bit_depth,
                    gamma_lut,
                }));
            }
            Err(CmsError::UnsupportedProfileConnection)
        }
    };
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[allow(unused)]
macro_rules! create_rgb_xyz_dependant_executor_to_v {
    ($dep_name: ident, $dependant: ident, $shaper: ident) => {
        pub(crate) fn $dep_name<
            T: Clone + Send + Sync + Default + PointeeSizeExpressible + Copy + 'static,
            const LINEAR_CAP: usize,
        >(
            src_layout: Layout,
            dst_layout: Layout,
            profile: $shaper<T, LINEAR_CAP>,
            gamma_lut: usize,
            bit_depth: usize,
        ) -> Result<Arc<dyn TransformExecutor<T> + Send + Sync>, CmsError>
        where
            u32: AsPrimitive<T>,
        {
            let profile = profile.convert_to_v();
            if (src_layout == Layout::Rgba) && (dst_layout == Layout::Rgba) {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgba as u8 },
                    { Layout::Rgba as u8 },
                > {
                    profile,
                    bit_depth,
                    gamma_lut,
                }));
            } else if (src_layout == Layout::Rgb) && (dst_layout == Layout::Rgba) {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgb as u8 },
                    { Layout::Rgba as u8 },
                > {
                    profile,
                    bit_depth,
                    gamma_lut,
                }));
            } else if (src_layout == Layout::Rgba) && (dst_layout == Layout::Rgb) {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgba as u8 },
                    { Layout::Rgb as u8 },
                > {
                    profile,
                    bit_depth,
                    gamma_lut,
                }));
            } else if (src_layout == Layout::Rgb) && (dst_layout == Layout::Rgb) {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgb as u8 },
                    { Layout::Rgb as u8 },
                > {
                    profile,
                    bit_depth,
                    gamma_lut,
                }));
            }
            Err(CmsError::UnsupportedProfileConnection)
        }
    };
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[allow(unused)]
macro_rules! create_in_place_opt_rgb_xyz_fp_to_v {
    ($dep_name: ident, $dependant: ident, $resolution: ident, $shaper: ident) => {
        pub(crate) fn $dep_name<
            T: Clone + Send + Sync + Default + PointeeSizeExpressible + Copy + 'static,
            const LINEAR_CAP: usize,
            const PRECISION: i32,
        >(
            layout: Layout,
            profile: $shaper<T, LINEAR_CAP>,
            gamma_lut: usize,
            bit_depth: usize,
        ) -> Result<Arc<dyn InPlaceTransformExecutor<T> + Send + Sync>, CmsError>
        where
            u32: AsPrimitive<T>,
        {
            let q2_13_profile = profile.to_q2_13_i::<$resolution, PRECISION>(gamma_lut, bit_depth);
            if layout == Layout::Rgba {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgba as u8 },
                    { Layout::Rgba as u8 },
                    PRECISION,
                > {
                    profile: q2_13_profile,
                    bit_depth,
                    gamma_lut,
                }));
            } else if layout == Layout::Rgb {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgb as u8 },
                    { Layout::Rgb as u8 },
                    PRECISION,
                > {
                    profile: q2_13_profile,
                    bit_depth,
                    gamma_lut,
                }));
            }
            Err(CmsError::UnsupportedProfileConnection)
        }
    };
}

#[allow(unused)]
macro_rules! create_in_place_rgb_xyz {
    ($dep_name: ident, $dependant: ident, $shaper: ident) => {
        pub(crate) fn $dep_name<
            T: Clone + Send + Sync + Default + PointeeSizeExpressible + Copy + 'static,
            const LINEAR_CAP: usize,
        >(
            layout: Layout,
            profile: $shaper<T, LINEAR_CAP>,
            gamma_lut: usize,
            bit_depth: usize,
        ) -> Result<Arc<dyn InPlaceTransformExecutor<T> + Send + Sync>, CmsError>
        where
            u32: AsPrimitive<T>,
        {
            if layout == Layout::Rgba {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgba as u8 },
                    { Layout::Rgba as u8 },
                    LINEAR_CAP,
                > {
                    profile,
                    bit_depth,
                    gamma_lut,
                }));
            } else if layout == Layout::Rgb {
                return Ok(Arc::new($dependant::<
                    T,
                    { Layout::Rgb as u8 },
                    { Layout::Rgb as u8 },
                    LINEAR_CAP,
                > {
                    profile,
                    bit_depth,
                    gamma_lut,
                }));
            }
            Err(CmsError::UnsupportedProfileConnection)
        }
    };
}

#[cfg(all(
    any(target_arch = "x86", target_arch = "x86_64"),
    feature = "sse_shaper_optimized_paths"
))]
use crate::conversions::sse::TransformShaperRgbOptSse;

#[cfg(all(
    any(target_arch = "x86", target_arch = "x86_64"),
    feature = "sse_shaper_paths"
))]
use crate::conversions::sse::TransformShaperRgbSse;

#[cfg(all(target_arch = "x86_64", feature = "avx_shaper_paths"))]
use crate::conversions::avx::TransformShaperRgbAvx;
#[cfg(all(target_arch = "x86_64", feature = "avx_shaper_optimized_paths"))]
use crate::conversions::avx::TransformShaperRgbOptAvx;

#[cfg(all(
    any(target_arch = "x86", target_arch = "x86_64"),
    feature = "sse_shaper_paths"
))]
create_rgb_xyz_dependant_executor!(
    make_rgb_xyz_rgb_transform_sse_41,
    TransformShaperRgbSse,
    TransformMatrixShaper
);

#[cfg(all(
    any(target_arch = "x86", target_arch = "x86_64"),
    feature = "sse_shaper_optimized_paths"
))]
create_rgb_xyz_dependant_executor_to_v!(
    make_rgb_xyz_rgb_transform_sse_41_opt,
    TransformShaperRgbOptSse,
    TransformMatrixShaperOptimized
);

#[cfg(all(target_arch = "x86_64", feature = "avx_shaper_paths"))]
create_rgb_xyz_dependant_executor!(
    make_rgb_xyz_rgb_transform_avx2,
    TransformShaperRgbAvx,
    TransformMatrixShaper
);

#[cfg(all(target_arch = "x86_64", feature = "avx_shaper_optimized_paths"))]
create_rgb_xyz_dependant_executor_to_v!(
    make_rgb_xyz_rgb_transform_avx2_opt,
    TransformShaperRgbOptAvx,
    TransformMatrixShaperOptimized
);

pub(crate) fn make_rgb_xyz_rgb_transform<
    T: Clone + Send + Sync + PointeeSizeExpressible + 'static + Copy + Default,
    const LINEAR_CAP: usize,
>(
    src_layout: Layout,
    dst_layout: Layout,
    profile: TransformMatrixShaper<T, LINEAR_CAP>,
    gamma_lut: usize,
    bit_depth: usize,
) -> Result<Arc<dyn TransformExecutor<T> + Send + Sync>, CmsError>
where
    u32: AsPrimitive<T>,
{
    #[cfg(all(feature = "avx_shaper_paths", target_arch = "x86_64"))]
    if std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma") {
        return make_rgb_xyz_rgb_transform_avx2::<T, LINEAR_CAP>(
            src_layout, dst_layout, profile, gamma_lut, bit_depth,
        );
    }
    #[cfg(all(
        feature = "sse_shaper_paths",
        any(target_arch = "x86", target_arch = "x86_64")
    ))]
    if std::arch::is_x86_feature_detected!("sse4.1") {
        return make_rgb_xyz_rgb_transform_sse_41::<T, LINEAR_CAP>(
            src_layout, dst_layout, profile, gamma_lut, bit_depth,
        );
    }
    if (src_layout == Layout::Rgba) && (dst_layout == Layout::Rgba) {
        return Ok(Arc::new(TransformMatrixShaperScalar::<
            T,
            { Layout::Rgba as u8 },
            { Layout::Rgba as u8 },
            LINEAR_CAP,
        > {
            profile,
            gamma_lut,
            bit_depth,
        }));
    } else if (src_layout == Layout::Rgb) && (dst_layout == Layout::Rgba) {
        return Ok(Arc::new(TransformMatrixShaperScalar::<
            T,
            { Layout::Rgb as u8 },
            { Layout::Rgba as u8 },
            LINEAR_CAP,
        > {
            profile,
            gamma_lut,
            bit_depth,
        }));
    } else if (src_layout == Layout::Rgba) && (dst_layout == Layout::Rgb) {
        return Ok(Arc::new(TransformMatrixShaperScalar::<
            T,
            { Layout::Rgba as u8 },
            { Layout::Rgb as u8 },
            LINEAR_CAP,
        > {
            profile,
            gamma_lut,
            bit_depth,
        }));
    } else if (src_layout == Layout::Rgb) && (dst_layout == Layout::Rgb) {
        return Ok(Arc::new(TransformMatrixShaperScalar::<
            T,
            { Layout::Rgb as u8 },
            { Layout::Rgb as u8 },
            LINEAR_CAP,
        > {
            profile,
            gamma_lut,
            bit_depth,
        }));
    }
    Err(CmsError::UnsupportedProfileConnection)
}

pub(crate) fn make_rgb_xyz_rgb_transform_opt<
    T: Clone + Send + Sync + PointeeSizeExpressible + 'static + Copy + Default,
    const LINEAR_CAP: usize,
>(
    src_layout: Layout,
    dst_layout: Layout,
    profile: TransformMatrixShaperOptimized<T, LINEAR_CAP>,
    gamma_lut: usize,
    bit_depth: usize,
) -> Result<Arc<dyn TransformExecutor<T> + Send + Sync>, CmsError>
where
    u32: AsPrimitive<T>,
{
    #[cfg(all(feature = "avx_shaper_optimized_paths", target_arch = "x86_64"))]
    if std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma") {
        return make_rgb_xyz_rgb_transform_avx2_opt::<T, LINEAR_CAP>(
            src_layout, dst_layout, profile, gamma_lut, bit_depth,
        );
    }
    #[cfg(all(
        feature = "sse_shaper_optimized_paths",
        any(target_arch = "x86", target_arch = "x86_64")
    ))]
    if std::arch::is_x86_feature_detected!("sse4.1") {
        return make_rgb_xyz_rgb_transform_sse_41_opt::<T, LINEAR_CAP>(
            src_layout, dst_layout, profile, gamma_lut, bit_depth,
        );
    }
    if (src_layout == Layout::Rgba) && (dst_layout == Layout::Rgba) {
        return Ok(Arc::new(TransformMatrixShaperOptScalar::<
            T,
            { Layout::Rgba as u8 },
            { Layout::Rgba as u8 },
            LINEAR_CAP,
        > {
            profile,
            gamma_lut,
            bit_depth,
        }));
    } else if (src_layout == Layout::Rgb) && (dst_layout == Layout::Rgba) {
        return Ok(Arc::new(TransformMatrixShaperOptScalar::<
            T,
            { Layout::Rgb as u8 },
            { Layout::Rgba as u8 },
            LINEAR_CAP,
        > {
            profile,
            gamma_lut,
            bit_depth,
        }));
    } else if (src_layout == Layout::Rgba) && (dst_layout == Layout::Rgb) {
        return Ok(Arc::new(TransformMatrixShaperOptScalar::<
            T,
            { Layout::Rgba as u8 },
            { Layout::Rgb as u8 },
            LINEAR_CAP,
        > {
            profile,
            gamma_lut,
            bit_depth,
        }));
    } else if (src_layout == Layout::Rgb) && (dst_layout == Layout::Rgb) {
        return Ok(Arc::new(TransformMatrixShaperOptScalar::<
            T,
            { Layout::Rgb as u8 },
            { Layout::Rgb as u8 },
            LINEAR_CAP,
        > {
            profile,
            gamma_lut,
            bit_depth,
        }));
    }
    Err(CmsError::UnsupportedProfileConnection)
}

use crate::conversions::rgbxyz_fixed::TransformMatrixShaperFpOptVec;
use crate::conversions::rgbxyz_fixed::{
    TransformMatrixShaperFixedPointOpt, TransformMatrixShaperFp,
};
use crate::transform::PointeeSizeExpressible;

#[cfg(feature = "in_place")]
create_in_place_rgb_xyz!(
    make_in_place_rgb_xyz_transform,
    TransformMatrixShaperScalar,
    TransformMatrixShaper
);

#[cfg(feature = "in_place")]
create_in_place_rgb_xyz!(
    make_rgb_xyz_in_place_transform_opt,
    TransformMatrixShaperOptScalar,
    TransformMatrixShaperOptimized
);

#[cfg(all(
    any(target_arch = "x86_64", target_arch = "x86"),
    feature = "in_place",
    feature = "sse_shaper_fixed_point_paths"
))]
use crate::conversions::sse::TransformShaperQ2_13OptSse;

#[cfg(all(
    any(target_arch = "x86_64", target_arch = "x86"),
    feature = "in_place",
    feature = "sse_shaper_fixed_point_paths"
))]
create_in_place_opt_rgb_xyz_fp_to_v!(
    make_sse_rgb_xyz_in_place_transform_q2_13_opt,
    TransformShaperQ2_13OptSse,
    i32,
    TransformMatrixShaperOptimized
);

#[cfg(all(
    target_arch = "x86_64",
    feature = "in_place",
    feature = "avx_shaper_fixed_point_paths"
))]
use crate::conversions::avx::TransformShaperRgbQ2_13OptAvx;

#[cfg(all(
    target_arch = "x86_64",
    feature = "in_place",
    feature = "avx_shaper_fixed_point_paths"
))]
create_in_place_opt_rgb_xyz_fp_to_v!(
    make_avx_rgb_xyz_in_place_transform_q2_13_opt,
    TransformShaperRgbQ2_13OptAvx,
    i32,
    TransformMatrixShaperOptimized
);

#[allow(unused)]
impl<
    T: Clone + PointeeSizeExpressible + Copy + Default + 'static,
    const SRC_LAYOUT: u8,
    const DST_LAYOUT: u8,
    const LINEAR_CAP: usize,
> TransformExecutor<T> for TransformMatrixShaperScalar<T, SRC_LAYOUT, DST_LAYOUT, LINEAR_CAP>
where
    u32: AsPrimitive<T>,
{
    fn transform(&self, src: &[T], dst: &mut [T]) -> Result<(), CmsError> {
        use crate::mlaf::mlaf;
        let src_cn = Layout::from(SRC_LAYOUT);
        let dst_cn = Layout::from(DST_LAYOUT);
        let src_channels = src_cn.channels();
        let dst_channels = dst_cn.channels();

        if src.len() / src_channels != dst.len() / dst_channels {
            return Err(CmsError::LaneSizeMismatch);
        }
        if src.len() % src_channels != 0 {
            return Err(CmsError::LaneMultipleOfChannels);
        }
        if dst.len() % dst_channels != 0 {
            return Err(CmsError::LaneMultipleOfChannels);
        }

        let transform = self.profile.adaptation_matrix;
        let scale = (self.gamma_lut - 1) as f32;
        let max_colors: T = ((1 << self.bit_depth) - 1).as_();

        for (src, dst) in src
            .chunks_exact(src_channels)
            .zip(dst.chunks_exact_mut(dst_channels))
        {
            let r = self.profile.r_linear[src[src_cn.r_i()]._as_usize()];
            let g = self.profile.g_linear[src[src_cn.g_i()]._as_usize()];
            let b = self.profile.b_linear[src[src_cn.b_i()]._as_usize()];
            let a = if src_channels == 4 {
                src[src_cn.a_i()]
            } else {
                max_colors
            };

            let new_r = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[0][0], g, transform.v[0][1]),
                    b,
                    transform.v[0][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            let new_g = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[1][0], g, transform.v[1][1]),
                    b,
                    transform.v[1][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            let new_b = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[2][0], g, transform.v[2][1]),
                    b,
                    transform.v[2][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            dst[dst_cn.r_i()] = self.profile.r_gamma[(new_r as u16) as usize];
            dst[dst_cn.g_i()] = self.profile.g_gamma[(new_g as u16) as usize];
            dst[dst_cn.b_i()] = self.profile.b_gamma[(new_b as u16) as usize];
            if dst_channels == 4 {
                dst[dst_cn.a_i()] = a;
            }
        }

        Ok(())
    }
}

#[cfg(feature = "in_place")]
impl<
    T: Clone + PointeeSizeExpressible + Copy + Default + 'static,
    const SRC_LAYOUT: u8,
    const DST_LAYOUT: u8,
    const LINEAR_CAP: usize,
> InPlaceTransformExecutor<T> for TransformMatrixShaperScalar<T, SRC_LAYOUT, DST_LAYOUT, LINEAR_CAP>
where
    u32: AsPrimitive<T>,
{
    fn transform(&self, dst: &mut [T]) -> Result<(), CmsError> {
        use crate::mlaf::mlaf;
        assert_eq!(
            SRC_LAYOUT, DST_LAYOUT,
            "This is in-place transform, layout must not diverge"
        );
        let src_cn = Layout::from(SRC_LAYOUT);
        let src_channels = src_cn.channels();

        if dst.len() % src_channels != 0 {
            return Err(CmsError::LaneMultipleOfChannels);
        }

        let transform = self.profile.adaptation_matrix;
        let scale = (self.gamma_lut - 1) as f32;
        let max_colors: T = ((1 << self.bit_depth) - 1).as_();

        for dst in dst.chunks_exact_mut(src_channels) {
            let r = self.profile.r_linear[dst[src_cn.r_i()]._as_usize()];
            let g = self.profile.g_linear[dst[src_cn.g_i()]._as_usize()];
            let b = self.profile.b_linear[dst[src_cn.b_i()]._as_usize()];
            let a = if src_channels == 4 {
                dst[src_cn.a_i()]
            } else {
                max_colors
            };

            let new_r = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[0][0], g, transform.v[0][1]),
                    b,
                    transform.v[0][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            let new_g = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[1][0], g, transform.v[1][1]),
                    b,
                    transform.v[1][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            let new_b = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[2][0], g, transform.v[2][1]),
                    b,
                    transform.v[2][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            dst[src_cn.r_i()] = self.profile.r_gamma[(new_r as u16) as usize];
            dst[src_cn.g_i()] = self.profile.g_gamma[(new_g as u16) as usize];
            dst[src_cn.b_i()] = self.profile.b_gamma[(new_b as u16) as usize];
            if src_channels == 4 {
                dst[src_cn.a_i()] = a;
            }
        }

        Ok(())
    }
}

#[allow(unused)]
impl<
    T: Clone + PointeeSizeExpressible + Copy + Default + 'static,
    const SRC_LAYOUT: u8,
    const DST_LAYOUT: u8,
    const LINEAR_CAP: usize,
> TransformExecutor<T> for TransformMatrixShaperOptScalar<T, SRC_LAYOUT, DST_LAYOUT, LINEAR_CAP>
where
    u32: AsPrimitive<T>,
{
    fn transform(&self, src: &[T], dst: &mut [T]) -> Result<(), CmsError> {
        use crate::mlaf::mlaf;
        let src_cn = Layout::from(SRC_LAYOUT);
        let dst_cn = Layout::from(DST_LAYOUT);
        let src_channels = src_cn.channels();
        let dst_channels = dst_cn.channels();

        if src.len() / src_channels != dst.len() / dst_channels {
            return Err(CmsError::LaneSizeMismatch);
        }
        if src.len() % src_channels != 0 {
            return Err(CmsError::LaneMultipleOfChannels);
        }
        if dst.len() % dst_channels != 0 {
            return Err(CmsError::LaneMultipleOfChannels);
        }

        let transform = self.profile.adaptation_matrix;
        let scale = (self.gamma_lut - 1) as f32;
        let max_colors: T = ((1 << self.bit_depth) - 1).as_();

        for (src, dst) in src
            .chunks_exact(src_channels)
            .zip(dst.chunks_exact_mut(dst_channels))
        {
            let r = self.profile.linear[src[src_cn.r_i()]._as_usize()];
            let g = self.profile.linear[src[src_cn.g_i()]._as_usize()];
            let b = self.profile.linear[src[src_cn.b_i()]._as_usize()];
            let a = if src_channels == 4 {
                src[src_cn.a_i()]
            } else {
                max_colors
            };

            let new_r = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[0][0], g, transform.v[0][1]),
                    b,
                    transform.v[0][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            let new_g = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[1][0], g, transform.v[1][1]),
                    b,
                    transform.v[1][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            let new_b = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[2][0], g, transform.v[2][1]),
                    b,
                    transform.v[2][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            dst[dst_cn.r_i()] = self.profile.gamma[(new_r as u16) as usize];
            dst[dst_cn.g_i()] = self.profile.gamma[(new_g as u16) as usize];
            dst[dst_cn.b_i()] = self.profile.gamma[(new_b as u16) as usize];
            if dst_channels == 4 {
                dst[dst_cn.a_i()] = a;
            }
        }

        Ok(())
    }
}

#[cfg(feature = "in_place")]
impl<
    T: Clone + PointeeSizeExpressible + Copy + Default + 'static,
    const SRC_LAYOUT: u8,
    const DST_LAYOUT: u8,
    const LINEAR_CAP: usize,
> InPlaceTransformExecutor<T>
    for TransformMatrixShaperOptScalar<T, SRC_LAYOUT, DST_LAYOUT, LINEAR_CAP>
where
    u32: AsPrimitive<T>,
{
    fn transform(&self, dst: &mut [T]) -> Result<(), CmsError> {
        use crate::mlaf::mlaf;
        assert_eq!(
            SRC_LAYOUT, DST_LAYOUT,
            "This is in-place transform, layout must not diverge"
        );
        let dst_cn = Layout::from(DST_LAYOUT);
        let dst_channels = dst_cn.channels();

        if dst.len() % dst_channels != 0 {
            return Err(CmsError::LaneMultipleOfChannels);
        }

        let transform = self.profile.adaptation_matrix;
        let scale = (self.gamma_lut - 1) as f32;
        let max_colors: T = ((1 << self.bit_depth) - 1).as_();

        for dst in dst.chunks_exact_mut(dst_channels) {
            let r = self.profile.linear[dst[dst_cn.r_i()]._as_usize()];
            let g = self.profile.linear[dst[dst_cn.g_i()]._as_usize()];
            let b = self.profile.linear[dst[dst_cn.b_i()]._as_usize()];
            let a = if dst_channels == 4 {
                dst[dst_cn.a_i()]
            } else {
                max_colors
            };

            let new_r = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[0][0], g, transform.v[0][1]),
                    b,
                    transform.v[0][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            let new_g = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[1][0], g, transform.v[1][1]),
                    b,
                    transform.v[1][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            let new_b = mlaf(
                0.5f32,
                mlaf(
                    mlaf(r * transform.v[2][0], g, transform.v[2][1]),
                    b,
                    transform.v[2][2],
                )
                .max(0f32)
                .min(1f32),
                scale,
            );

            dst[dst_cn.r_i()] = self.profile.gamma[(new_r as u16) as usize];
            dst[dst_cn.g_i()] = self.profile.gamma[(new_g as u16) as usize];
            dst[dst_cn.b_i()] = self.profile.gamma[(new_b as u16) as usize];
            if dst_channels == 4 {
                dst[dst_cn.a_i()] = a;
            }
        }

        Ok(())
    }
}
