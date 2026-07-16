#[inline]
pub(crate) const fn s15_fixed16_number_to_double(value: i32) -> f64 {
    value as f64 / 65536.0
}
