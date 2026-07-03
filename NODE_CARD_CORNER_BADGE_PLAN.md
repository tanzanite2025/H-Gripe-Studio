# Node Card Corner Badge Plan

> Status: local planning draft. Do not implement or submit until cloud-side UI
> changes are pulled back and reconciled.

## Purpose

H-Gripe Studio's node editor should make each node type identifiable at a glance
without turning node cards into large profile cards or dashboard panels.

The intended pattern is a **corner-anchored circular type badge**:

- the node remains a compact work card
- the circle identifies the node type
- the circle does not create a header strip
- the circle does not consume a full row of content
- the circle does not turn the node into a profile-card layout

## Exact Geometry

The badge is a circle whose **center point is exactly the card corner**.

For the right-top variant:

```text
              ooooo
            oo     oo
          oo    *    oo
          +------     oo
          |       oo oo
          |         o
          |
          |  Node title
          |  Node content
          |
          +----------------
```

`*` is both:

- the card's top-right corner
- the circle's center point

For the left-top variant:

```text
ooooo
o   oo
oo    *----------------+
 oo oo                 |
  o                    |
                       |
    Node title         |
    Node content       |
                       |
-----------------------+
```

`*` is both:

- the card's top-left corner
- the circle's center point

This is not a half-outside avatar. If the circle center equals the card corner,
the circle naturally has one quarter inside the card bounds and three quarters
outside. That is the intended visual.

## CSS Contract

Right-top badge:

```css
.node-card {
  position: relative;
  overflow: visible;
}

.node-card__type-badge {
  position: absolute;
  top: calc(var(--node-badge-size) / -2);
  right: calc(var(--node-badge-size) / -2);
  width: var(--node-badge-size);
  height: var(--node-badge-size);
  border-radius: 999px;
  z-index: 2;
}
```

Left-top badge:

```css
.node-card__type-badge {
  top: calc(var(--node-badge-size) / -2);
  left: calc(var(--node-badge-size) / -2);
}
```

Suggested default:

```css
:root {
  --node-badge-size: 44px;
}
```

The size may vary by zoom/card density, but the center alignment rule must not
change.

## Content Avoidance

The badge is allowed to overlap the card corner. Node content must avoid the
badge zone.

For right-top placement:

```css
.node-card__title-row {
  padding-right: calc(var(--node-badge-size) * 0.55);
}
```

For left-top placement:

```css
.node-card__title-row {
  padding-left: calc(var(--node-badge-size) * 0.55);
}
```

Do not add a full header band just to make room for the circle. The node body
should remain a normal compact card body.

## Badge Contents

The badge should carry only fast visual identity:

| Node family | Badge content |
| --- | --- |
| Image source / image result | image icon or small thumbnail |
| Video source / video result | film / play icon |
| Audio source / audio result | waveform icon |
| PSD template / PSD export | layers / PSD file icon |
| Mask / matte | mask / selection icon |
| Crop / transform | crop icon |
| Grade / colour | color wheel / sliders icon |
| API generation | cloud / spark icon |
| Local compute | chip / cpu icon |
| Export | download / package icon |

Rules:

- Prefer lucide icons when an icon exists.
- Use a real thumbnail only when the node is an image/media source or result.
- Do not put text inside the badge.
- Do not put engine names, statuses, or counts inside the badge.
- If a status is needed, use a tiny separate dot attached to the badge edge,
  not text in the circle.

## What This Is Not

Do not implement this as:

- a horizontal header strip
- a large profile-card avatar
- a full-width top banner
- a circular icon fully inside the card
- a circular icon floating above the card without touching the corner
- a badge that changes card dimensions
- a badge that pushes ports or handles out of alignment

The card must still read as a production node card.

## Port And Handle Safety

The corner badge must not cover connection handles.

If ports are on the left and right card edges:

- prefer the badge on the top-right only when the top-right handle area is clear
- otherwise use top-left for node families whose right-side outputs are dense
- keep input/output handles vertically aligned and stable

The badge should have `pointer-events: none` unless it intentionally opens a
node-type menu. Connection handles must remain easy to grab.

## Visual Priority

The correct hierarchy is:

1. Node type badge: what family is this node?
2. Node title: what exact operation is this?
3. Preview / params / status: what is this node doing now?
4. Ports: how does it connect?

The badge is an identity stamp, not the main content.

## Implementation Notes

Start with one placement, likely top-right, and apply it consistently. Only add
per-family left/right placement after handle collisions are measured.

Implementation should be centralized in the node card shell, not duplicated per
node kind. Individual node specs should provide a node family/icon identifier;
the shell decides geometry.

Suggested data shape:

```ts
type NodeVisualFamily =
  | "image"
  | "video"
  | "audio"
  | "psd"
  | "mask"
  | "crop"
  | "grade"
  | "api"
  | "compute"
  | "export"
  | "utility";
```

The visual family is separate from executor lane. For example, an image node can
be API-backed, local compute, or pure file input, but the badge family can still
be `image`.

## Acceptance Criteria

- The circle center is exactly aligned to the selected card corner.
- There is no full-width header strip.
- The node title and content do not overlap the circle.
- Ports and handles remain usable.
- Zooming does not move the badge away from the corner.
- Different node families are identifiable from the badge alone.
- The card still feels like a compact node editor card, not a user/profile card.
