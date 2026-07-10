use crate::studio::TemporalAccumulator;

use super::viewports;

pub(super) struct TemporalChain {
    acc: TemporalAccumulator,
    path: String,
    time_sec: f64,
}

const MAX_TEMPORAL_STEP_SEC: f64 = 0.5;

#[cfg_attr(not(feature = "native-ffmpeg"), allow(dead_code))]
pub(super) fn apply_temporal(
    id: u64,
    path: &str,
    time_sec: f64,
    surface: &mut hgripe_grade::GradeSurface,
    amount: f32,
) -> Result<(), String> {
    if amount <= 0.0 {
        return Ok(());
    }
    let taken = {
        let mut map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        match map.get_mut(&id) {
            Some(state) => state.temporal.take(),
            None => return Ok(()),
        }
    };
    let continuous = taken.as_ref().is_some_and(|c| {
        c.path == path && time_sec > c.time_sec && time_sec - c.time_sec <= MAX_TEMPORAL_STEP_SEC
    });
    let mut chain = match taken {
        Some(chain) if continuous => chain,
        _ => TemporalChain {
            acc: TemporalAccumulator::new(),
            path: path.to_string(),
            time_sec,
        },
    };
    chain.acc.push(surface, amount);
    chain.path = path.to_string();
    chain.time_sec = time_sec;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    if let Some(state) = map.get_mut(&id) {
        state.temporal = Some(chain);
    }
    Ok(())
}
