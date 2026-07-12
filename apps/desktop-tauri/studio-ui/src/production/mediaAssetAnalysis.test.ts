import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateThumbnail, videoProbe } from "../bridge/files";
import {
  loadMediaAssetThumbnailDataUrl,
  probeMediaAssetPlaybackInfo,
} from "./mediaAssetAnalysis";

vi.mock("../bridge/files", () => ({
  videoProbe: vi.fn(),
  generateThumbnail: vi.fn(),
}));

const videoProbeMock = vi.mocked(videoProbe);
const generateThumbnailMock = vi.mocked(generateThumbnail);

function probeResult(overrides: Partial<Awaited<ReturnType<typeof videoProbe>>> = {}) {
  return {
    width: 1920,
    height: 1080,
    duration_sec: 12.5,
    has_audio: true,
    fps: 24,
    codec: "h264",
    poster_path: "/cache/poster.png",
    ...overrides,
  };
}

function thumbnailResult(dataUrl: string) {
  return {
    data_url: dataUrl,
    cache_path: "/cache/thumb.png",
    width: 64,
    height: 36,
    source_hash: "hash",
    mime: "image/png",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("probeMediaAssetPlaybackInfo", () => {
  it("returns the probed duration and audio presence for a video", async () => {
    videoProbeMock.mockResolvedValue(probeResult());
    const info = await probeMediaAssetPlaybackInfo("video", "/media/clip-a.mp4");
    expect(info).toEqual({ durationSec: 12.5, hasAudio: true });
  });

  it("reports hasAudio false for a probed silent video", async () => {
    videoProbeMock.mockResolvedValue(probeResult({ has_audio: false }));
    const info = await probeMediaAssetPlaybackInfo("video", "/media/silent.mp4");
    expect(info).toEqual({ durationSec: 12.5, hasAudio: false });
  });

  it("resolves all-null info for non-video kinds without touching the backend", async () => {
    expect(await probeMediaAssetPlaybackInfo("image", "/media/a.png")).toEqual({
      durationSec: null,
      hasAudio: null,
    });
    expect(await probeMediaAssetPlaybackInfo("audio", "/media/a.wav")).toEqual({
      durationSec: null,
      hasAudio: null,
    });
    expect(videoProbeMock).not.toHaveBeenCalled();
  });

  it("resolves all-null info instead of throwing when the probe fails", async () => {
    videoProbeMock.mockRejectedValue(new Error("no backend"));
    const info = await probeMediaAssetPlaybackInfo("video", "/media/clip-b.mp4");
    expect(info).toEqual({ durationSec: null, hasAudio: null });
  });

  it("probes each path only once across playback-info and thumbnail loads", async () => {
    videoProbeMock.mockResolvedValue(probeResult());
    generateThumbnailMock.mockResolvedValue(thumbnailResult("data:image/png;base64,poster"));

    await probeMediaAssetPlaybackInfo("video", "/media/clip-c.mp4");
    await probeMediaAssetPlaybackInfo("video", "/media/clip-c.mp4");
    await loadMediaAssetThumbnailDataUrl("video", "/media/clip-c.mp4");

    expect(videoProbeMock).toHaveBeenCalledTimes(1);
  });
});

describe("loadMediaAssetThumbnailDataUrl", () => {
  it("thumbnails an image path directly", async () => {
    generateThumbnailMock.mockResolvedValue(thumbnailResult("data:image/png;base64,img"));
    const dataUrl = await loadMediaAssetThumbnailDataUrl("image", "/media/photo-a.png");
    expect(dataUrl).toBe("data:image/png;base64,img");
    expect(generateThumbnailMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/media/photo-a.png" }),
    );
    expect(videoProbeMock).not.toHaveBeenCalled();
  });

  it("thumbnails a video via its probed poster frame", async () => {
    videoProbeMock.mockResolvedValue(probeResult({ poster_path: "/cache/poster-d.png" }));
    generateThumbnailMock.mockResolvedValue(thumbnailResult("data:image/png;base64,poster"));
    const dataUrl = await loadMediaAssetThumbnailDataUrl("video", "/media/clip-d.mp4");
    expect(dataUrl).toBe("data:image/png;base64,poster");
    expect(generateThumbnailMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/cache/poster-d.png" }),
    );
  });

  it("resolves null for audio without touching the backend", async () => {
    expect(await loadMediaAssetThumbnailDataUrl("audio", "/media/a.wav")).toBeNull();
    expect(videoProbeMock).not.toHaveBeenCalled();
    expect(generateThumbnailMock).not.toHaveBeenCalled();
  });

  it("resolves null when the video probe reports no poster frame", async () => {
    videoProbeMock.mockResolvedValue(probeResult({ poster_path: "" }));
    expect(await loadMediaAssetThumbnailDataUrl("video", "/media/clip-e.mp4")).toBeNull();
    expect(generateThumbnailMock).not.toHaveBeenCalled();
  });

  it("resolves null instead of throwing when thumbnail generation fails", async () => {
    generateThumbnailMock.mockRejectedValue(new Error("decode failed"));
    expect(await loadMediaAssetThumbnailDataUrl("image", "/media/photo-b.png")).toBeNull();
  });
});
