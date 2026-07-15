# color_harmonize.onnx provenance notice

`color_harmonize.onnx` is an optional local runtime artifact. It is not stored
in this repository, is not bundled by default, and is not designated as a
release-ready model.

## Third-party ONNX conversion

- Project: `pccaza/harmonizer-onnx`
- URL: https://github.com/pccaza/harmonizer-onnx
- Fixed commit: `046a31654875432fe303d5342aa036782270c520`
- SPDX license: `MIT`
- Attribution in that repository: Copyright (c) 2025 PC
- Artifact: `pct_net.onnx`, renamed locally to `color_harmonize.onnx`

This is an unofficial third-party conversion. It is not an official ONNX export
from Rakuten or the PCT-Net authors.

## Official PCT-Net upstream

- Project: `rakutentech/PCT-Net-Image-Harmonization`
- URL: https://github.com/rakutentech/PCT-Net-Image-Harmonization
- Review reference commit: `1572176ed1a72217dad7395391615329b98d30c7`
- SPDX license: `MPL-2.0`
- Attribution: Rakuten Institute of Technology, Rakuten Group, Inc.; PCT-Net
  authors Julian Jorge Andrade Guerreiro, Mitsuru Nakazawa, and Bjorn Stenger

The conversion repository's MIT license does not erase or replace obligations
that may apply to the official MPL-2.0 upstream or its pretrained weights.
The converter did not identify the exact upstream revision, checkpoint hash, or
export procedure used for this ONNX file. The commit above is our review
reference, not verified artifact lineage.

## Release review required

Before any release includes this artifact, maintainers must re-check the model
and pretrained-weight provenance, both license scopes, attribution and notice
requirements, and distribution obligations. Prefer an internally reproducible
ONNX export from the pinned official source and reviewed weights. This notice
is a provenance pointer, not legal approval or a release-readiness claim.
