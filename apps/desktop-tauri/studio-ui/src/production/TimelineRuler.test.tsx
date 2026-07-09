// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  formatTimelineTimecode,
  playheadTimeForKey,
  playheadTimeForWheel,
  rulerClientXToTime,
  TIMELINE_ZOOM_MAX,
  TIMELINE_ZOOM_MIN,
  TIMELINE_ZOOM_STEP,
  TimelineRuler,
  timelineRulerDuration,
  timelineZoomStep,
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

  it("steps the playhead by frames with arrows and jumps with Home / End", () => {
    expect(playheadTimeForKey("ArrowRight", false, 1, 8, 24)).toBeCloseTo(1 + 1 / 24);
    expect(playheadTimeForKey("ArrowRight", true, 1, 8, 24)).toBeCloseTo(1 + 5 / 24);
    expect(playheadTimeForKey("ArrowLeft", false, 0, 8, 24)).toBe(0);
    expect(playheadTimeForKey("Home", false, 3, 8, 24)).toBe(0);
    expect(playheadTimeForKey("End", false, 3, 8, 24)).toBe(8);
    expect(playheadTimeForKey("Enter", false, 3, 8, 24)).toBeNull();
  });

  it("moves the playhead by frames on wheel notches", () => {
    expect(playheadTimeForWheel(120, false, 1, 24)).toBeCloseTo(1 + 1 / 24);
    expect(playheadTimeForWheel(-120, true, 1, 24)).toBeCloseTo(1 - 5 / 24);
    expect(playheadTimeForWheel(-120, false, 0, 24)).toBe(0);
    expect(playheadTimeForWheel(0, false, 1, 24)).toBe(1);
  });

  it("steps the zoom level within its clamped range", () => {
    expect(timelineZoomStep(1, 1)).toBe(TIMELINE_ZOOM_STEP);
    expect(timelineZoomStep(TIMELINE_ZOOM_STEP, -1)).toBe(1);
    expect(timelineZoomStep(TIMELINE_ZOOM_MIN, -1)).toBe(TIMELINE_ZOOM_MIN);
    expect(timelineZoomStep(TIMELINE_ZOOM_MAX, 1)).toBe(TIMELINE_ZOOM_MAX);
    expect(timelineZoomStep(2, 0)).toBe(2);
  });

  it("handles keyboard navigation and the marker toggle on the focused ruler", () => {
    const onPlayheadSecChange = vi.fn();
    const onToggleMarker = vi.fn();
    const onZoomChange = vi.fn();
    const { container } = render(
      <TimelineRuler
        fps={24}
        durationSec={8}
        playheadSec={1}
        onPlayheadSecChange={onPlayheadSecChange}
        onToggleMarker={onToggleMarker}
        markers={[{ id: "m1", sec: 2 }]}
        zoom={1}
        onZoomChange={onZoomChange}
      />,
    );
    const ruler = container.querySelector<HTMLElement>(".production-timeline-ruler")!;
    expect(ruler.tabIndex).toBe(0);
    expect(container.querySelectorAll(".production-timeline-marker")).toHaveLength(1);
    fireEvent.keyDown(ruler, { key: "ArrowRight" });
    expect(onPlayheadSecChange).toHaveBeenCalledWith(1 + 1 / 24);
    fireEvent.keyDown(ruler, { key: "m" });
    expect(onToggleMarker).toHaveBeenCalledTimes(1);
    fireEvent.wheel(ruler, { deltaY: 120 });
    expect(onPlayheadSecChange).toHaveBeenLastCalledWith(1 + 1 / 24);
    fireEvent.keyDown(ruler, { key: "=" });
    expect(onZoomChange).toHaveBeenLastCalledWith(TIMELINE_ZOOM_STEP);
    fireEvent.keyDown(ruler, { key: "\\" });
    expect(onZoomChange).toHaveBeenLastCalledWith(TIMELINE_ZOOM_MIN);
    fireEvent.wheel(ruler, { deltaY: -120, ctrlKey: true });
    expect(onZoomChange).toHaveBeenLastCalledWith(TIMELINE_ZOOM_STEP);
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
