"""Opt-in torch / diffusers engine plugin for H-Gripe Studio ("Phase 6").

This package hosts every torch- and diffusers-backed engine that used to live
inside ``python/bridge`` (``sr_backends/{realesrgan,ccsr,supir}.py`` and
``inpaint_backends/{sd_inpaint,sdxl_inpaint,flux_fill}.py``). The bridge's
registries discover it at runtime (``sr_backends.load_torch_plugin``): when
this directory is absent — as in the packaged desktop app, which does not
bundle ``plugins/`` — the engines are simply not registered and every node
falls back to its always-available default (CPU / native Rust / remote
provider). Core carries no torch/diffusers code.

The modules keep the bridge seams' design rules: heavy deps are imported
lazily, weights are never bundled, and a missing dep/weight makes an engine
unavailable rather than an error. Shared torch-free helpers
(``model_cache_dir``, ``resolve_device``, ``resolve_precision``,
``BackendUnavailable`` / ``InpaintUnavailable``) still live in the bridge and
are imported from there.
"""

from __future__ import annotations

from typing import Any


def sr_backend_list() -> list[Any]:
    """The plugin's super-resolution engines for ``sr_backends._registry``."""
    from .ccsr import CcsrBackend
    from .realesrgan import RealEsrganBackend
    from .supir import SupirBackend

    return [RealEsrganBackend(), CcsrBackend(), SupirBackend()]


def inpaint_backend_list() -> list[Any]:
    """The plugin's local inpaint engines for ``inpaint_backends._registry``."""
    from .flux_fill import FluxFillBackend
    from .sd_inpaint import StableDiffusionInpaintBackend
    from .sdxl_inpaint import StableDiffusionXLInpaintBackend

    return [
        StableDiffusionInpaintBackend(),
        StableDiffusionXLInpaintBackend(),
        FluxFillBackend(),
    ]
