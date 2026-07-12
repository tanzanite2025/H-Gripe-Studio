import { describe, expect, it } from "vitest";

import { clipIdsIntersectingMarqueeSelection } from "./timelineMarqueeSelection";
import type { TimelineModel } from "./timeline";

function createTimeline(): TimelineModel {
  return {
    id: "tl",
    fps: 30,
    tracks: [
      {
        id: "v1",
        kind: "video",
        clips: [
          { id: "clip-a", assetId: "asset-a", kind: "video", start: 0, duration: 2, sourceStartSec: 0 },
          { id: "clip-b", assetId: "asset-b", kind: "video", start: 3, duration: 2, sourceStartSec: 0 },
        ],
      },
      {
        id: "a1",
        kind: "audio",
        clips: [
          { id: "clip-c", assetId: "asset-c", kind: "audio", start: 1, duration: 3, sourceStartSec: 0 },
        ],
      },
      {
        id: "v2",
        kind: "video",
        locked: true,
        clips: [
          { id: "clip-locked", assetId: "asset-d", kind: "video", start: 0, duration: 10, sourceStartSec: 0 },
        ],
      },
    ],
  };
}

describe("clipIdsIntersectingMarqueeSelection", () => {
  it("selects clips overlapping the time range on the crossed tracks", () => {
    const ids = clipIdsIntersectingMarqueeSelection(createTimeline(), ["v1", "a1"], {
      startSec: 0.5,
      endSec: 3.5,
    });
    expect(ids).toEqual(["clip-a", "clip-b", "clip-c"]);
  });

  it("ignores tracks the marquee did not cross", () => {
    const ids = clipIdsIntersectingMarqueeSelection(createTimeline(), ["a1"], {
      startSec: 0,
      endSec: 10,
    });
    expect(ids).toEqual(["clip-c"]);
  });

  it("accepts the time range bounds in either order", () => {
    const ids = clipIdsIntersectingMarqueeSelection(createTimeline(), ["v1"], {
      startSec: 3.5,
      endSec: 0.5,
    });
    expect(ids).toEqual(["clip-a", "clip-b"]);
  });

  it("excludes clips that only touch the range boundary", () => {
    const ids = clipIdsIntersectingMarqueeSelection(createTimeline(), ["v1"], {
      startSec: 2,
      endSec: 3,
    });
    expect(ids).toEqual([]);
  });

  it("never selects clips on locked tracks", () => {
    const ids = clipIdsIntersectingMarqueeSelection(createTimeline(), ["v1", "v2"], {
      startSec: 0,
      endSec: 10,
    });
    expect(ids).toEqual(["clip-a", "clip-b"]);
  });
});
