# Mask Layer Target And Studio Action Plan

Status: active. Updated 2026-07-16.

## Goal

Give tools and assistants one explicit target model for layers, selections,
paths, and layer masks. Native actions are deterministic. Model-backed actions
use configured API profiles.

## Target Model

Every action resolves:

- document id
- layer id
- target kind: pixels, layer mask, selection, path, or canvas
- optional selection/path artifact id
- expected document revision

An action must reject a stale or ambiguous target before changing state.

## Native Mask Actions

- create, enable, disable, invert, and delete a layer mask
- paint/erase mask strokes
- feather, grow, shrink, and fill holes
- wand, marquee, lasso, pen/path, quick selection, and object-region selection
- apply positive/negative point constraints to deterministic connected
  components
- build a trimap and run the guided-filter matte
- preview and commit through the same raster contract

These actions require no model runtime and are available offline.

## API Mask Actions

A future semantic-select or semantic-refine action may call an API profile and
return a previewable selection-alpha artifact. It does not edit the document
until the user or action transaction commits that artifact.

API actions must preserve the user's points, box, path, and existing selection
as constraints and must expose provider failure without changing the mask.

## Transaction Rules

1. Dry-run resolves target and validates parameters.
2. Preview produces an artifact against a known document revision.
3. Commit revalidates the revision.
4. One commit creates one undoable history entry.
5. Cancellation discards temporary artifacts.

## Acceptance

- Layer and layer-mask targets cannot be confused.
- Native preview and commit rasterize identically.
- Retired local-engine action ids are unavailable with an explicit error.
- API-profile actions never store credentials in the document.
