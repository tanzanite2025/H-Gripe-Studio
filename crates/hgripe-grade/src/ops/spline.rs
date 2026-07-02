// The kernel's curve primitives: the Fritsch–Carlson monotone spline every
// tone/HSL curve is built on, plus the hue-periodic and multiplier wrappers.

/// Fritsch–Carlson monotone piecewise-cubic interpolation: passes through
/// every control point, never overshoots, and is flat outside the endpoints.
/// Fewer than 2 points degenerate to identity / a constant.
pub struct MonotoneSpline {
    xs: Vec<f32>,
    ys: Vec<f32>,
    tangents: Vec<f32>,
}

impl MonotoneSpline {
    pub fn new(points: &[[f32; 2]]) -> Self {
        let mut pts: Vec<[f32; 2]> = points.to_vec();
        pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).expect("finite control points"));
        let xs: Vec<f32> = pts.iter().map(|p| p[0]).collect();
        let ys: Vec<f32> = pts.iter().map(|p| p[1]).collect();
        let n = xs.len();
        let mut tangents = vec![0.0f32; n];
        if n >= 2 {
            // Secant slopes, then Fritsch–Carlson tangent limiting.
            let d: Vec<f32> = (0..n - 1)
                .map(|i| (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]).max(1e-6))
                .collect();
            tangents[0] = d[0];
            tangents[n - 1] = d[n - 2];
            for i in 1..n - 1 {
                tangents[i] = if d[i - 1] * d[i] <= 0.0 {
                    0.0
                } else {
                    (d[i - 1] + d[i]) / 2.0
                };
            }
            for i in 0..n - 1 {
                if d[i] == 0.0 {
                    tangents[i] = 0.0;
                    tangents[i + 1] = 0.0;
                } else {
                    let a = tangents[i] / d[i];
                    let b = tangents[i + 1] / d[i];
                    let s = a * a + b * b;
                    if s > 9.0 {
                        let t = 3.0 / s.sqrt();
                        tangents[i] = t * a * d[i];
                        tangents[i + 1] = t * b * d[i];
                    }
                }
            }
        }
        Self { xs, ys, tangents }
    }

    pub fn eval(&self, x: f32) -> f32 {
        let n = self.xs.len();
        if n == 0 {
            return x; // identity when no points are set
        }
        if n == 1 || x <= self.xs[0] {
            return if x <= self.xs[0] {
                self.ys[0]
            } else {
                self.ys[n - 1]
            };
        }
        if x >= self.xs[n - 1] {
            return self.ys[n - 1];
        }
        // The segment with xs[i] <= x < xs[i+1].
        let mut i = 0;
        while i + 2 < n && x >= self.xs[i + 1] {
            i += 1;
        }
        let h = (self.xs[i + 1] - self.xs[i]).max(1e-6);
        let t = (x - self.xs[i]) / h;
        let (t2, t3) = (t * t, t * t * t);
        let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
        let h10 = t3 - 2.0 * t2 + t;
        let h01 = -2.0 * t3 + 3.0 * t2;
        let h11 = t3 - t2;
        h00 * self.ys[i]
            + h10 * h * self.tangents[i]
            + h01 * self.ys[i + 1]
            + h11 * h * self.tangents[i + 1]
    }
}

/// A hue-domain curve (period 360): the control points are replicated one
/// period below and above before building the spline, so evaluation wraps
/// seamlessly. No points evaluates to `neutral` everywhere.
pub(super) struct PeriodicSpline {
    spline: MonotoneSpline,
    neutral: f32,
    empty: bool,
}

impl PeriodicSpline {
    pub(super) fn new(points: &[[f32; 2]], neutral: f32) -> Self {
        let mut base: Vec<[f32; 2]> = points
            .iter()
            .map(|p| [p[0].rem_euclid(360.0), p[1]])
            .collect();
        base.sort_by(|a, b| a[0].total_cmp(&b[0]));
        let mut wrapped: Vec<[f32; 2]> = Vec::with_capacity(base.len() * 3);
        for shift in [-360.0, 0.0, 360.0] {
            wrapped.extend(base.iter().map(|p| [p[0] + shift, p[1]]));
        }
        Self {
            spline: MonotoneSpline::new(&wrapped),
            neutral,
            empty: points.is_empty(),
        }
    }

    pub(super) fn eval(&self, hue: f32) -> f32 {
        if self.empty {
            return self.neutral;
        }
        self.spline.eval(hue.rem_euclid(360.0))
    }
}

/// A `0..=1`-domain multiplier curve: no points is the identity
/// multiplier 1; otherwise the monotone spline (flat outside endpoints).
pub(super) struct MultiplierSpline {
    spline: MonotoneSpline,
    empty: bool,
}

impl MultiplierSpline {
    pub(super) fn new(points: &[[f32; 2]]) -> Self {
        Self {
            spline: MonotoneSpline::new(points),
            empty: points.is_empty(),
        }
    }

    pub(super) fn eval(&self, x: f32) -> f32 {
        if self.empty {
            return 1.0;
        }
        self.spline.eval(x)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monotone_spline_passes_through_points_and_never_overshoots() {
        let pts = vec![[0.0, 0.0], [0.25, 0.6], [0.5, 0.65], [1.0, 1.0]];
        let sp = MonotoneSpline::new(&pts);
        for p in &pts {
            assert!((sp.eval(p[0]) - p[1]).abs() < 1e-6);
        }
        let mut prev = -1.0;
        for i in 0..=1000 {
            let y = sp.eval(i as f32 / 1000.0);
            assert!(y >= prev - 1e-6, "monotone");
            assert!((0.0..=1.0).contains(&y), "no overshoot");
            prev = y;
        }
    }
}
