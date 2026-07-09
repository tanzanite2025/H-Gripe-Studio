// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultClipProperties, type ClipProperties } from "./clipProps";
import { ClipPropertiesPanel } from "./ClipPropertiesPanel";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ClipPropertiesPanel keyframe interpolation menu", () => {
  it("sets the playhead key's outgoing interpolation from its context menu", () => {
    const props: ClipProperties = {
      ...defaultClipProperties(),
      tracks: {
        "transform.scalePct": [
          { t: 1, v: 100 },
          { t: 3, v: 50 },
        ],
      },
    };
    const onChange = vi.fn();
    const { container, getByText } = render(
      <ClipPropertiesPanel
        clipName="clip.png"
        props={props}
        clipLocalSec={1}
        onChange={onChange}
      />,
    );
    const key = container.querySelector<HTMLButtonElement>(
      ".production-props-diamond.on-key",
    );
    expect(key).not.toBeNull();

    fireEvent.contextMenu(key!, { clientX: 120, clientY: 80 });
    fireEvent.click(getByText("Bezier (ease in/out)"));

    const next = onChange.mock.calls[0][0] as ClipProperties;
    expect(next.tracks?.["transform.scalePct"]?.[0]).toEqual({
      t: 1,
      v: 100,
      interp: "bezier",
      bezier: [[0.42, 0], [0.58, 1]],
    });
  });
});
