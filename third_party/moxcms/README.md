# H-Gripe Studio `moxcms` fork

This directory contains the Windows x64 colour-management subset maintained by
H-Gripe Studio. It is not a drop-in copy of upstream `moxcms`.

The retained product surface is deliberately small:

- RGB and RGBA matrix-shaper transforms used by the desktop image pipeline.
- Built-in sRGB and ProPhoto RGB profile construction and ICC encoding.
- Parametric tone-reproduction curves and the matrix, chromatic-adaptation, and
  transfer sampling needed to execute those transforms.
- RGB CICP metadata used by the vendored `image` crate. The supported transfer
  profiles are sRGB, BT.709/BT.601/BT.2020, simple gamma, and linear.
- Runtime-detected AVX2 and SSE4.1 paths with the scalar implementation as the
  compatibility fallback on Windows x64.

The fork does not expose upstream's arbitrary ICC parser, CMYK or multi-ink
pipelines, multidimensional A2B/B2A CLUT execution, tabular TRC input, generic
any-to-any layouts, NEON, or AVX-512 paths. Gamma/shaper sample tables retained
inside the RGB executor are an implementation detail, not a profile LUT API.

See [VENDOR.md](VENDOR.md) for the exact ownership boundary and upgrade checks.

## License

This code remains available under either BSD-3-Clause or Apache-2.0, matching
the upstream project. See [LICENSE.md](LICENSE.md) and
[LICENSE-APACHE.md](LICENSE-APACHE.md).
