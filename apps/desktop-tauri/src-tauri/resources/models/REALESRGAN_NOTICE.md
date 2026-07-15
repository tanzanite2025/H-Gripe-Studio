# realesrgan_x4v3.onnx provenance notice

`realesrgan_x4v3.onnx` is an optional local runtime artifact. It is not stored
in this repository, is not bundled by default, and is not designated as a
release-ready model.

## Third-party ONNX re-host

- Repository: `Heliosoph/realesrgan-onnx`
- URL: https://huggingface.co/Heliosoph/realesrgan-onnx
- Fixed revision: `488e5dda07333179f229a6205d92135eea4c25e9`
- Source artifact: `realesr-general-x4v3.onnx`
- Local name: `realesrgan_x4v3.onnx`
- Bytes: `4871181`
- SHA-256: `09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4`
- Declared SPDX license: `BSD-3-Clause`

The repository describes the file as an ONNX export of Real-ESRGAN's
`realesr-general-x4v3` model and identifies xinntao's releases as authoritative.
It does not identify the exact source revision and checkpoint, export toolchain,
or reproducible export procedure for this file. Treat the repository as a
third-party distribution source, not verified artifact lineage or an official
Real-ESRGAN ONNX release.

## Real-ESRGAN upstream

- Project: `xinntao/Real-ESRGAN`
- URL: https://github.com/xinntao/Real-ESRGAN
- SPDX license: `BSD-3-Clause`
- Copyright notice: Copyright (c) 2021, Xintao Wang

The upstream project and its release weights are the review authority. The
BSD-3-Clause text supplied by the re-host matches the upstream project license,
but that alone does not establish how the re-hosted ONNX file was produced.

## Independent export reference (not lineage)

SceneWorks commit `a4fbf6ae7f743cdeb43140e2eb57e51e6e2e34ea` contains a
[reproducible ONNX export reference](https://github.com/michaeltrefry/SceneWorks/blob/a4fbf6ae7f743cdeb43140e2eb57e51e6e2e34ea/scripts/spikes/sc3489_export_reference.py)
with Torch-versus-ORT parity checks. It exports an RRDBNet x4plus checkpoint
from `nateraw/real-esrgan`; its separately published artifact revision
`09f741bac80a246b407da3ee902bf5f3291b602f` and artifact hash also differ from
the file locked above. It is useful for designing an internal export audit, but
it is a different model and is not the stated converter or source of this x4v3
artifact. It must not be presented as this file's lineage.

## Release review required

Before any release includes this artifact, maintainers must establish or
replace its export lineage, verify the source checkpoint and conversion steps,
re-check pretrained-weight and redistribution terms, and carry the complete
BSD-3-Clause notice in binary distribution materials. Prefer an internally
reproducible ONNX export from pinned, reviewed upstream inputs. This notice is a
provenance pointer, not legal approval or a release-readiness claim.
