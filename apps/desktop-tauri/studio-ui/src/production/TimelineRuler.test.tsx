// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  formatTimelineTimecode,
  rulerClientXToTime,
  TimelineRuler,
  timelineRulerDuration,
} from "./TimelineRuler";

describe("TimelineRuler", () => {
  it("formats SMPTE-style timecode using the timeline fps", () => {
    expect(formatTimelineTimecode(1.5, 24)).toBe("00:00:01:12");
    expect(formatTimelineTimecode(61, 30)).toBe("00:01:01:00");
  });

  it("keeps a minimum visible ruler duration", () => {
    expect(timelineRulerDuration(0, 0)).toBe(8);
    expect(timelineRulerDuration(3, 10.2)).toBe(11);
  });

  it("converts pointer x positions to frame-snapped times", () => {
    expect(rulerClientXToTime(251, { left: 100, width: 400 }, 8, 24)).toBe(3);
  });

  it("snaps to a nearby snap point when snapping is requested", () => {
    // 251px -> ~3.02s raw; 8px tolerance on a 400px ruler = 0.16s, so the
    // 3.1s clip edge captures the scrub instead of the frame grid.
    expect(rulerClientXToTime(251, { left: 100, width: 400 }, 8, 24, { points: [0, 3.1] })).toBe(3.1);
    // Out of tolerance: falls back to the frame-snapped time.
    expect(rulerClientXToTime(251, { left: 100, width: 400 }, 8, 24, { points: [0, 5] })).toBe(3);
  });

  it("renders a slider ruler with ticks and playhead", () => {
    const onPlayheadSecChange = vi.fn();
    const { container } = render(
      <TimelineRuler fps={24} durationSec={8} playheadSec={0} onPlayheadSecChange={onPlayheadSecChange} />,
    );
    const ruler = container.querySelector<HTMLElement>(".production-timeline-ruler")!;
    expect(ruler.getAttribute("role")).toBe("slider");
    expect(container.querySelectorAll(".production-timeline-ruler-tick.major").length).toBeGreaterThan(0);
    expect(container.querySelector(".production-timeline-playhead")).toBeDefined();
    expect(container.querySelector(".production-timeline-playhead-head")).toBeDefined();
  });
});
