# Dual Dock Workspace Plan

> Status: planning only. Do not implement while the cloud-side colour kernel is
> still moving.

This document freezes the product direction for replacing stacked edit modals
with a resizable dual-dock workspace. The goal is to let the central node canvas,
the image/PSD editor, and the video/timeline editor cooperate without forcing
the user to constantly close and reopen large windows.

## Core Idea

The app should have three persistent work zones:

| Zone | Role |
| --- | --- |
| Center canvas | Node graph, AI/API/local model workflow orchestration, asset source of truth |
| Left dock | Image / PSD / mask / future PS-style editor |
| Right dock | Video / timeline / colour grading / clip assembly editor |

The left and right docks are mutually aware, not separate modal windows. They can
push each other, split the screen, or collapse to thin handles.

## Unified Colour / Grading Surface

Colour correction should not be implemented separately for the image editor, the
video editor, and graph nodes. Photoshop-style adjustments, Premiere-style clip
grading, and DaVinci-style grading share the same underlying ideas: exposure,
contrast, curves, HSL, LUTs, colour-space conversion, scopes, and masked/local
adjustments.

Decision:

- Build **one colour/grading kernel**.
- Build **one grading parameter model**.
- Build **one grading panel** that can be hosted by different surfaces.

The host decides what the target is, not how grading math works.

```ts
type GradingTarget =
  | { kind: "image"; path: string; sourceNodeId?: string }
  | { kind: "layer"; workspaceId: string; layerId: string }
  | { kind: "video_clip"; timelineId: string; clipId: string; frame?: number }
  | { kind: "node_output"; nodeId: string; outputPort?: string };
```

The same grading panel can therefore grade:

- a still image from the canvas
- a PSD/image layer in the PS-style workspace
- a video clip on the timeline
- a node output before it flows downstream

Video adds time/keyframes around the same parameters; it should not fork a
separate colour system.

## Bottom Production Drawer Option

The video/timeline/grade surface may be better as a bottom multi-tab drawer than
as a pure right-side dock. This should stay open as a layout option.

Possible bottom drawer tabs:

| Tab | Role |
| --- | --- |
| Media Bin | Assets dropped from the graph, grouped by image/video/audio |
| Timeline | Clip placement, trim, assembly |
| Grade | The unified colour/grading panel |
| Export | Render/export controls |

In this model:

- The right rail can remain a compact video/timeline inbox handle, or collapse
  into the bottom drawer handle.
- Dropping a video onto the rail/bin stores it for later.
- Dropping a video directly onto the timeline places it at the drop time.
- Dropping an image into the media bin stores it as a still asset.
- Right-clicking an image in the media bin can open the PS-style image editor as
  a secondary drawer/workspace.
- When the image edit is confirmed, the edited result returns to the bin, graph,
  or timeline as a new non-destructive output item.
- The Grade tab should call the same grading panel whether the selected target is
  an image, layer, video clip, or node output.

This keeps the workflow from splitting into "PS colour", "video colour", and
"node colour". There is one grading tool; the selected asset decides the host
context.

## Dock States

Use flexible width state rather than only fixed modes.

| State | Behaviour |
| --- | --- |
| Both collapsed | Only left/right handles are visible; canvas owns most of the screen |
| Left active | Left dock expands, right dock keeps only a thin handle |
| Right active | Right dock expands, left dock keeps only a thin handle |
| Split | Left and right docks share the workspace, commonly 50/50 |
| Drag-adjusted | User drags a splitter; widening one dock narrows the other |

Suggested constraints:

- Minimum collapsed rail: about `44-56px`, enough for an icon, badge, and drop target.
- Maximum expanded dock: about `95%` of the available width, leaving the opposite handle reachable.
- Default split: `50/50`.
- Remember the user's last left/right widths.
- Double-clicking a handle can cycle collapsed / split / dominant states.

## Drag-To-Dock Inbox

The missing workflow closure is asset delivery. A canvas node should be draggable
into the appropriate work area without forcing the dock to open first.

### Left Rail: Image / PSD Inbox

Accepts:

- image source nodes
- PSD template nodes
- image output nodes from mask/crop/enhance/generate nodes

Drop behaviour:

- If the left dock is collapsed, the asset enters the left inbox/tray and the
  rail shows a small count badge.
- If the left dock is open, dropping on the dock opens/adds the asset to the
  current image workspace.
- Dropping on a specific layer area in the future can add it as a layer or smart object.

### Right Rail: Video / Timeline Inbox

Accepts:

- video source nodes
- generated/processed video nodes
- image nodes that can become still clips
- audio nodes later, if audio support lands

Drop behaviour:

- Dropping on the right rail puts the asset into the timeline bin only.
- Dropping directly onto an open timeline creates a clip at the drop time.
- Dropping an image onto the timeline creates a still-image clip with a default duration.

This split avoids accidental timeline edits. "Rail drop" means store for later;
"timeline drop" means place into the edit.

## Data Model

The inbox should store references, not copied pixels.

```ts
type WorkspaceDockSide = "left" | "right";

type WorkspaceInboxItem = {
  id: string;
  sourceNodeId: string;
  sourcePort?: string;
  path?: string;
  mediaType: "image" | "psd" | "video" | "audio";
  createdAt: number;
};

type WorkspaceDockState = {
  leftOpen: boolean;
  rightOpen: boolean;
  activeDock: WorkspaceDockSide | null;
  leftWidthRatio: number;
  rightWidthRatio: number;
  leftInbox: WorkspaceInboxItem[];
  rightInbox: WorkspaceInboxItem[];
};
```

Important: the graph remains the source of truth. The dock receives references
to graph nodes and file paths, then produces new result nodes when the user
commits an edit.

## Layout Rules

- Do not treat the image editor and video editor as independent modals.
- Keep dock contents mounted when practical so mask paths, layer selections,
  timeline playhead, and grading state are not lost on collapse.
- When a dock collapses, pause expensive work: video playback, histogram updates,
  high-frequency previews, and heavy canvas redraws.
- Keep the center canvas usable when both docks are collapsed.
- Handles must remain visible and droppable even when a dock is collapsed.
- The rail should be small: icon, count badge, and hover/drop affordance only.

## Interaction Rules

- Clicking a collapsed left handle opens the image workspace.
- Clicking a collapsed right handle opens the video workspace.
- Opening one side while the other is active should push the layout toward split.
- Clicking an already active side can make it dominant and compress the other side.
- Dragging a splitter overrides the preset width until the user resets it.
- The active dock owns keyboard shortcuts; the canvas shortcuts remain active only
  when focus is on the canvas.

## Visual Shape

The dock rails should behave like compact production-tool handles, not large cards.

Recommended rail contents:

- side icon: image/PSD or video/timeline
- small inbox count badge
- active/drop state highlight
- optional tiny status dot for unsaved edits

Avoid putting path text, long labels, or large thumbnails in the rail. Those
belong inside the opened dock or inspector.

## Integration With Existing System

Current pieces this design should reuse:

- `imageSource` and `videoSource` media cards as graph-side asset origins.
- Bound edit nodes for non-destructive image edits.
- Existing mask editor as the first left-dock candidate.
- Future timeline/trim/assembly UI as the first right-dock candidate.
- Existing thumbnail/resource cache instead of passing pixels through React state.

Do not merge this with the colour kernel work. The dock is layout and workflow
orchestration; the colour kernel is pixel math and colour correctness.

## Implementation Order

1. Add a passive `WorkspaceDock` shell with collapsed rails only.
2. Add inbox state and drag/drop from graph nodes to rails.
3. Move the existing mask/media edit modal into the left dock without changing
   its editing logic.
4. Add right dock shell with a media bin before building the full timeline.
5. Add resizable splitters and remembered widths.
6. Add direct timeline drop once the timeline model is stable.
7. Add shortcut scopes for canvas / left dock / right dock.

## Non-Goals For The First Version

- No full PS rewrite during the dock migration.
- No full video editor before the bin/timeline drop model is stable.
- No copying source files into project storage by default.
- No rendering large metadata directly on dock rails or media cards.
- No coupling to the in-progress colour kernel internals.

## Product Rationale

This closes the loop between the node canvas and real production work:

- The canvas remains the place where AI, API, local model, and procedural nodes
  are composed.
- The left dock becomes the precise image/PSD/manual adjustment surface.
- The right dock becomes the video/timeline/colour workspace.
- Drag-to-rail inboxes make assets movable between these worlds without forcing
  immediate decisions.

The result is a workflow where AI generation, manual image fixing, and video
assembly can coexist in one app instead of being separate tools glued together
by file exports.
