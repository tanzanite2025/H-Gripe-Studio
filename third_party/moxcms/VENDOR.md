# Vendored `moxcms`

This directory is H-Gripe Studio's physically pruned fork of `moxcms`. It owns
the RGB colour-management code used by the Windows desktop application and by
the workspace-patched `image` crate.

| | |
| --- | --- |
| Upstream | https://github.com/awxkee/moxcms |
| Source release | 0.8.1 |
| License | BSD-3-Clause OR Apache-2.0 |
| Local resolver | Workspace member plus `[patch.crates-io]` in `Cargo.toml` |
| Supported target | Windows x64 |

## Product contract

The maintained surface is limited to RGB/RGBA matrix-shaper colour transforms,
the built-in sRGB and ProPhoto RGB profiles, ICC encoding for those generated
profiles, and RGB CICP metadata used by `image`. Parametric transfer curves,
chromatic adaptation, colourant matrices, and executor sampling tables remain
because those transforms depend on them.

The sampled gamma/shaper arrays inside the executor are not the removed LUT
feature. They are generated from supported parametric transfer functions and
are required for the current 8-bit, 10-bit, 12-bit, 16-bit, f32, and f64 RGB
transform paths.

## Physical fork changes

Relative to upstream 0.8.1, this fork physically removes or narrows:

- CMYK, multi-ink, and generic any-to-any layout/profile paths.
- Multidimensional A2B/B2A CLUT parsing, storage, interpolation, execution, and
  writing, including scalar, AVX, SSE, and pipeline factory implementations.
- Tabular `ToneReprCurve` input and its lookup, inversion, and ICC `curv` writer;
  built-in gamma profiles now use parametric curves.
- The arbitrary ICC byte parser and parser-only tag/error machinery. The fork
  constructs supported profiles in code and encodes them for the application.
- NEON, AVX-512, and their dispatch/feature declarations. AVX2, SSE4.1, and
  scalar RGB matrix-shaper implementations remain for Windows x64.
- PQ/HLG and other table-only CICP-to-ICC curve construction. Unsupported
  transfers return `CmsError::UnsupportedTrc`; sRGB, BT.709/BT.601/BT.2020,
  simple gamma, and linear remain supported.
- Upstream constructors and public exports unrelated to the application-owned
  sRGB/ProPhoto/CICP boundary.

Both `Cargo.toml` files expose only the retained feature set. Removed feature
names are not registered through placeholder `check-cfg` entries and cannot be
enabled accidentally.

## Upgrade procedure

An upstream replacement must be treated as a port, not a file refresh:

1. Record the new upstream release and review its license and dependency diff.
2. Re-apply the product contract and physical removals above.
3. Keep the workspace `[patch.crates-io]` pointed at `third_party/moxcms`.
4. Verify the dependency feature boundary:

   ```powershell
   cargo tree -e features -i moxcms --offline
   ```

5. Verify the desktop boundary and targeted colour tests:

   ```powershell
   cargo test -p moxcms --offline
   cargo check -p hgripe-desktop --no-default-features --offline
   cargo test -p hgripe-desktop studio::color --offline
   ```

6. Confirm no removed CMYK, multidimensional CLUT, tabular TRC, NEON, or AVX-512
   module/feature path has re-entered the fork.
