import type { Rect } from "./studioTarget";

export interface SelectedLayerFrame {
  owner: "selected-layer-frame";
  shape: "axis-aligned-rect";
  layerId: string;
  rect: Rect;
  sourceRect: Rect;
  source: "asset-frame";
}
