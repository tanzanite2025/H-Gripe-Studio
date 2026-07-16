# Editor Resource Model

The editor separates work by the resource it actually consumes.

## Lanes

| Lane | Examples | Concurrency policy |
| --- | --- | --- |
| CPU light | graph routing, value coercion, metadata | ungated |
| CPU bound | image cards, mask rasterization, PSD work | bounded by available parallelism |
| GPU | WGPU grading and viewport kernels | shared configurable semaphore |
| Video encode | native FFmpeg trim/assemble | single slot |
| Network | API broker calls | provider/task limits |

The node registry is the source of truth for baseline lane assignment.
Parameter values do not promote deterministic image cards into an inference
lane.

## Long-Lived Resources

- The decoded image buffer caches native surfaces between compatible cards.
- Thumbnail, poster, and frame caches are bounded process resources.
- The WGPU grader and viewport device are initialized lazily and report their
  actual adapter/fallback.
- Native FFmpeg libraries are process-loaded from the maintained Windows
  payload.
- API requests use the broker's cancellation, retry, cache, and history state.

There is no inference session pool. The current desktop does not load model
weights or an inference runtime.

## Scheduling Rules

1. A node acquires only its declared lane permit.
2. CPU-light and network nodes do not take the GPU permit.
3. Video export cannot fan out and starve interactive work.
4. GPU reports describe what actually ran; a probe is not execution evidence.
5. Missing acceleration falls back only where the operation has a documented,
   equivalent deterministic implementation.
6. Retired local engine requests are errors, not fallback requests.

## Windows GPU Direction

WGPU and FFmpeg device reporting must cover NVIDIA, AMD, and Intel Windows
hosts. CUDA or vendor-specific integration is added only with a concrete
shipping consumer, packaging, fallback behavior, and real-hardware tests.
