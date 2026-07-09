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

  it("renders a slider ruler with ticks and playhead", () => {
    const onPlayheadSecChange = vi.fn();
    const { container } = render(
      <TimelineRuler fps={24} durationSec={8} playheadSec={0} onPlayheadSecChange={onPlayheadSecChange} />,
    );
    const ruler = container.querySelector<HTMLElement>(".production-timeline-ruler")!;
    expect(ruler.getAttribute("role")).toBe("slider");
    expect(container.querySelectorAll(".production-timeline-ruler-tick.major").length).toBeGreaterThan(0);
    expect(container.querySelector(".production-timeline-playhead")).toBeDefined();
  });
});
