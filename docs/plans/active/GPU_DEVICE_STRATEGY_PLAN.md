# Windows GPU And Device Strategy

Status: active. Updated 2026-07-16.

## Scope

The product targets Windows only. Device work currently serves WGPU image
kernels, viewport presentation, and native FFmpeg media acceleration.
There is no inference runtime or model-session provider layer.

## Shared Vocabulary

Every accelerated operation reports:

- device_requested
- device actually used
- backend and adapter/codec detail
- whether the operation was accelerated
- a fallback reason when software was used

A capability probe is diagnostic; only a per-run report proves what executed.

## Current Backends

| Consumer | Baseline | Accelerated path |
| --- | --- | --- |
| Grade kernel | deterministic CPU | WGPU compute |
| Viewport | PNG/blob transport | WGPU surface presentation |
| Video decode | FFmpeg software | D3D11VA where verified |
| Video encode | FFmpeg software codec | compiled hardware encoder where a session succeeds |

The scheduler keeps CPU-bound work in a bounded pool, video encode in one slot,
and WGPU work behind the shared GPU semaphore.

## Hardware Targets

The compatibility matrix must include:

- NVIDIA Windows systems
- AMD Windows systems
- Intel Windows systems

WGPU/DX12 and DirectML-compatible device discovery are preferred
vendor-neutral surfaces. CUDA interoperability may be added later for a
concrete Windows kernel that needs it, but not as an unused runtime payload.
ROCm is not a Windows product target.

## Delivery Rule

An accelerated backend lands only when the same change includes:

1. A concrete shipping consumer.
2. Runtime packaging and version ownership.
3. Capability probing that does not initialize unrelated devices at startup.
4. Per-run device and fallback reporting.
5. Deterministic software fallback where behavior is equivalent.
6. Real NVIDIA/AMD/Intel verification appropriate to the backend.

## Next Work

1. Stabilize WGPU adapter preference and error reporting.
2. Verify viewport surface recovery after device errors.
3. Exercise FFmpeg hardware decode and encode on real vendor hardware.
4. Add a compact diagnostics consumer for adapter, codec, and fallback reports.
5. Document the Windows hardware test matrix.
