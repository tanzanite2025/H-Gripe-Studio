# Executor Split And PSD Chain Hardening

Studio nodes are classified by execution ownership:

| Executor | Responsibility |
| --- | --- |
| graph | Pure graph/value operations |
| compute | Native Rust image and mask operations |
| local | Native PSD/media/card commands with deterministic behavior |
| api | Broker-backed provider requests |

The split is structural. Compute and local executors do not receive API
credentials; API executors do not gain direct access to arbitrary native model
paths.

## API Boundary

Provider, profile, model, and capability selection belongs to the API manager
and hgripe-api profile registry. API cards store stable profile references, not
raw credentials.

The current product exposes no downloadable-engine manager. A stored retired
engine reference must fail explicitly if a workflow attempts to execute it.

## Native PSD Chain

The deterministic chain is:

1. PSD context analysis
2. Light and colour match
3. Subject mask and guided matte
4. Edge refinement
5. Image enhance
6. Detail watchdog
7. Optional API detail repaint
8. PSD export

Each native card must:

- validate connected inputs and bounded output names
- use the shared hardened image loader
- enforce decode and output pixel limits
- preserve alpha and colour metadata according to its contract
- publish structured reports and deterministic artifacts
- reject retired engine identifiers instead of silently changing algorithms

Model-backed restoration, semantic detection, inpainting, and generation use
the API lane.
