# Color Feature Masking Preprocess Plan

> Status: active planning document.
> Purpose: define a future deterministic preprocess layer for mask / matte work:
> use colour-space separation, feature enhancement, and optional local-model
> refinement before expensive segmentation or manual correction.

## Hard Gate

Do not implement this plan until the Image Processing card is structurally
settled.

This plan must wait for the Image Processing card to have a clear product
boundary, row ownership, row-aligned ports, backend selector semantics, and run
scope behavior. Until that is true, this document is only a design reference.

The blocking documents are:

- [`NODE_CARD_PRODUCT_BOUNDARY_PLAN.md`](NODE_CARD_PRODUCT_BOUNDARY_PLAN.md)
- [`../../cards/generic-media-card.md`](../../cards/generic-media-card.md)
- [`API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md`](API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md)
- [`WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md`](WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md)

The reason is simple: this feature belongs inside the Image Processing card's
Mask / Matte row, not as another standalone low-level node. If the card and port
model are still moving, implementing this now would create another thing that
has to be renamed, moved, or reconnected later.

## Core Idea

Before asking a model to segment or matte an image, the system can make the
image easier for both algorithms and models to understand.

The useful operation is not "separate RGB channels" by itself. The useful
operation is:

```text
source image
  -> colour-space decoupling
  -> foreground/background candidate estimation
  -> feature-distance maps
  -> contrast / distance stretching
  -> initial mask or trimap
  -> matte / model refinement
  -> preview and user confirmation
```

RGB mixes brightness and colour in a way that is often awkward for selection.
The preprocess should move into spaces where luminance, chroma, hue, or colour
opponents are easier to compare:

| Space | Use |
| --- | --- |
| `Lab` | Separates lightness from opponent colour axes; strong for colour distance and perceptual separation. |
| `HSV` / `HSL` | Useful when hue or saturation separates the subject from the background. |
| `YCbCr` / `YUV` | Useful for video-oriented paths and brightness/chroma separation. |
| linear RGB / working RGB | Useful for GPU math, blending, and consistent preview parity. |

The preprocess then derives maps such as:

- colour-distance map
- edge / gradient map
- local contrast map
- saturation-distance map
- candidate foreground / background confidence
- trimap unknown band

These maps make downstream mask generation less blind.

## Advanced Algorithm Direction

The long-term value is not just "pull apart colours." The deeper direction is a
high-dimensional feature separation system that can feed deterministic
algorithms, local models, and final alpha reconstruction.

The advanced stack should be treated as four layers:

```text
feature stack
  -> high-dimensional separation
  -> alpha / anti-alias reconstruction
  -> model-assisted prior or refinement
```

### Pseudo-Multispectral Feature Stack

This plan does not require real multispectral camera input. In the product, the
first version should build a software "pseudo-multispectral" stack from the
source image and optional model priors.

Useful channels include:

| Channel | Purpose |
| --- | --- |
| `x`, `y` position | Keeps spatial continuity and discourages scattered noise. |
| Lab `L`, `a`, `b` | Perceptual colour distance and lightness/chroma separation. |
| HSV/HSL hue and saturation | Strong when subject/background differ by hue or saturation. |
| YCbCr/YUV chroma | Useful for video-oriented and brightness-independent separation. |
| gradient magnitude / direction | Finds hard edges and boundary confidence. |
| texture / local variance | Separates fabric, hair, product grain, and noisy backgrounds. |
| local contrast | Helps pull low-contrast boundaries out of the background. |
| saliency / semantic prior | Optional local model hint for likely subject areas. |
| depth / normal prior | Optional future model hint for foreground/background ordering. |
| embedding channels | Optional learned feature vectors for ambiguous material boundaries. |

This is the real meaning of "multispectral" in this software context: many
interpretable or learned channels, not only RGB.

### High-Dimensional Space Separation

Once the feature stack exists, foreground/background separation should not rely
only on RGB thresholds.

Candidate algorithms:

- superpixel grouping
- graph cut / GrabCut-style energy minimisation
- Gaussian mixture models over foreground/background samples
- mean-shift or k-means clustering in feature space
- spectral clustering for difficult colour/texture overlaps
- random-walker / watershed variants when edge confidence is strong

The important rule is that the algorithm should operate on pixel or superpixel
features such as:

```text
x, y, L, a, b, hue, saturation, gradient, texture, saliency, depth, embedding
```

This lets the system separate objects that look similar in raw RGB but differ
in texture, edge confidence, local contrast, or model-provided priors.

### Neural Pixel Anti-Alias And Alpha Reconstruction

The output should not stop at a hard 0/255 mask.

For professional image editing, the final boundary needs continuous alpha. This
matters for hair, glass, smoke, fabric, motion blur, transparent edges, diagonal
shape boundaries, and any subpixel contour.

The alpha reconstruction layer may include:

- subpixel coverage estimation for geometric boundaries
- guided filter / closed-form matting for local continuous alpha
- neural matting or local edge-refine models for hair/glass/material edges
- neural anti-aliasing around hard mask boundaries
- confidence-based blending between binary mask, trimap, and model output

The result should be an alpha image, not only a binary mask. Binary masks can
remain an intermediate artifact or compatibility output.

### Model Priors Are Not Always The Final Output

Local/API models should not be treated only as black-box final mask generators.

They can be used earlier in the stack to produce:

- saliency maps
- semantic subject hints
- edge confidence
- depth or foreground ordering priors
- material hints such as hair, glass, smoke, fabric, skin, product, text, logo
- learned embeddings for high-dimensional clustering

Then deterministic algorithms and alpha reconstruction can still produce the
inspectable, editable result.

This keeps the system from becoming either "only math" or "only model." The
best path is a hybrid:

```text
deterministic feature stack
  + optional model priors
  -> high-dimensional separation
  -> trimap / initial alpha
  -> neural or guided alpha refinement
  -> user-visible review
```

## Product Placement

This must not become a new visible "Colour Gap" node in the palette.

Correct placement:

```text
Image Processing card
  Mask / Matte row
    preprocess mode:
      off
      auto
      colour distance
      edge assisted
      model assisted
```

The row may expose advanced controls, but it still remains one Mask / Matte
operation from the user's point of view.

The Image Source card's bottom `Edit` action remains the entry for free manual
image editing. This preprocess is for flow-level mask/matte generation, not for
turning every small tool into a separate card.

## Why It Matters

This feature can become a real local advantage because it is deterministic,
fast, inspectable, and model-friendly.

Benefits:

- It can run before expensive local/API model calls.
- It can reduce how much the model has to solve.
- It gives the user visible intermediate artifacts: feature map, initial mask,
  trimap, and final alpha.
- It is naturally suited to WGPU compute later.
- It works well with a review gate: the user can inspect the mask before sending
  the result downstream.

This is not a replacement for learned segmentation or matting. It is the first
layer of the mask stack.

## Suggested Pipeline

The future pipeline should be staged:

```text
1. Decode source into canonical working image
2. Build colour-space views: Lab, HSV/HSL, YCbCr when useful
3. Build the pseudo-multispectral feature stack
4. Estimate candidate foreground/background samples and optional model priors
5. Run high-dimensional separation over pixels or superpixels
6. Compute distance, edge, confidence, and feature maps
7. Stretch distances or apply local thresholds where useful
8. Produce initial binary mask and/or coarse alpha
9. Derive trimap from confident foreground/background and uncertain boundary
10. Run graph cut / guided filter / neural matting / local model refinement
11. Reconstruct continuous alpha and anti-aliased boundaries
12. Present preview gate
13. Let the user accept, edit, or route downstream
```

The feature maps should be treated as internal artifacts. They can be displayed
in preview/review UI, but they should not force extra graph nodes.

## Model Relationship

The ideal relationship is:

```text
deterministic preprocess
  -> cheap confidence map / trimap
  -> local/API model only where needed
  -> user-visible review
```

Examples:

- For simple product images, Lab/HSV distance and graph cut may be enough.
- For hair, glass, smoke, or cloth, use the preprocess to build a better trimap,
  then run matting refinement.
- For semantic ambiguity, let a local model or API model choose the subject, but
  still give it stronger feature maps or a better initial mask.
- For difficult boundaries, let a local model produce edge confidence or learned
  embeddings, then let the deterministic stack and alpha reconstruction build
  the editable result.

The row should use managed backend refs from
[`API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md`](API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md)
instead of raw model fields.

## WGPU Relationship

This is a good future WGPU workload, but not the first WGPU priority.

Do first:

- finish heavy viewport migration boundaries
- stabilize native surface presentation
- keep image editor, grade preview, video preview, and mask editor preview on
  the shared viewport path

Then this preprocess can move from CPU/reference implementation to WGPU kernels:

- colour-space conversion
- per-pixel distance maps
- pseudo-multispectral feature-map generation
- high-dimensional feature clustering support where practical
- morphology
- edge/gradient maps
- trimap dilation/erosion
- subpixel alpha and mask anti-alias passes
- overlay preview

The first implementation may be CPU/reference if needed, but the API shape
should not prevent WGPU acceleration.

## UX Requirements

The user should see this as a mask-quality option, not as a math feature.

Minimum UX:

- a Mask / Matte row mode selector
- optional backend selector for model-assisted refinement
- preview button or run result gate
- visible comparison of source, feature map, initial mask, and final alpha
- clear accept / edit / rerun actions

Do not expose raw colour math as the default UI. Advanced controls may exist
behind disclosure:

- colour space
- distance curve
- threshold
- edge weight
- feature channels
- clustering strategy
- morphology radius
- trimap band width
- alpha reconstruction mode
- model refine backend

## Data Contract Direction

Future artifacts should be named explicitly:

```ts
type MaskPreprocessArtifact = {
  source_image_ref: string;
  feature_map_ref?: string;
  initial_mask_ref?: string;
  trimap_ref?: string;
  alpha_ref?: string;
  cutout_ref?: string;
  method:
    | "lab_distance"
    | "hsv_distance"
    | "edge_assisted"
    | "feature_stack"
    | "high_dimensional_clustering"
    | "model_assisted";
  feature_stack_ref?: string;
  confidence_map_ref?: string;
  edge_map_ref?: string;
  alpha_reconstruction?: "none" | "guided_filter" | "closed_form" | "neural";
  backend_ref?: string;
  confidence?: number;
};
```

The graph-facing outputs should stay semantic:

- `mask.out`
- `cutout.out`
- `alpha.out`
- `trimap.out` only if the receiving card needs it explicitly

Internal maps should not become default visible graph outputs unless a real
downstream product operation needs them.

## Implementation Order

Do not start here first.

Required order:

1. Finish Image Processing card product boundary and row semantics.
2. Confirm Mask / Matte row input/output ports and run scope.
3. Confirm model/API backend selector contract for row operations.
4. Confirm preview/review gate behavior.
5. Add a CPU/reference preprocess behind the Mask / Matte row.
6. Add artifact reporting and visual comparison.
7. Add WGPU kernels only after the viewport/surface path is stable.
8. Add local-model/API-assisted refinement through managed backend refs.

## Non-Goals

- Do not create a standalone Colour Gap / RGB Split / Lab Distance palette node.
- Do not bypass the Image Processing card.
- Do not add a second mask editor.
- Do not make the graph expose every intermediate math map by default.
- Do not start WGPU compute kernels before the product card contract is stable.
- Do not use this to reintroduce Python as a default runtime.

## Success Criteria

This plan is ready to implement only when all of these are true:

- Image Processing card has stable row-aligned ports.
- Mask / Matte row is the visible owner of this capability.
- Backend refs come from the shared model/API manager.
- Preview/review can show intermediate and final results.
- Execution reports which method and backend were used.
- The feature can be disabled without affecting normal mask/matte behavior.

Until then, keep this as a documented future path.
