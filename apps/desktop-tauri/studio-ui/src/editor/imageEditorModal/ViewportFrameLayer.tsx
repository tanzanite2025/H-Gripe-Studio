import type { CSSProperties, MutableRefObject } from "react";
import type { ViewportViewState } from "../../viewport/view";

interface ViewportFrameLayerProps {
  frameUrl: string | null;
  frameView: ViewportViewState;
  overlayOnly: boolean;
  nativeSurfacePlacementAnchorRef: MutableRefObject<HTMLDivElement | null>;
  style?: CSSProperties;
}

export function viewportFrameWindowStyle(frameView: ViewportViewState): CSSProperties {
  return {
    left: `${frameView.panX * 100}%`,
    top: `${frameView.panY * 100}%`,
    width: `${100 / frameView.zoom}%`,
    height: `${100 / frameView.zoom}%`,
  };
}

/** Presents the viewport frame after the host has decoded it. */
export function ViewportFrameLayer({
  frameUrl,
  frameView,
  overlayOnly,
  nativeSurfacePlacementAnchorRef,
  style,
}: ViewportFrameLayerProps) {
  const windowStyle = viewportFrameWindowStyle(frameView);
  return (
    <div className="image-editor-pixel-layer" style={style}>
      <div
        ref={nativeSurfacePlacementAnchorRef}
        className="image-editor-native-surface-anchor"
        style={windowStyle}
      />
      {frameUrl && !overlayOnly ? (
        <img
          key={frameUrl}
          className="image-editor-viewport-frame-img"
          src={frameUrl}
          alt=""
          draggable={false}
          style={windowStyle}
        />
      ) : null}
    </div>
  );
}
