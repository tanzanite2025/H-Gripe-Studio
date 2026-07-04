// Pins the binary frame transport contract: the desktop host returns
// `[u32 LE meta length][meta JSON {width, height, backend}][PNG bytes]` and
// the bridge decodes it into a presentable `ViewportFrame`.

import { describe, expect, it } from "vitest";
import { decodeFramePayload, type ViewportBackend } from "./viewport";

const BACKEND: ViewportBackend = { requested: "auto", actual: "cpu" };

function payload(meta: unknown, png: Uint8Array): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + metaBytes.length + png.length);
  new DataView(out.buffer).setUint32(0, metaBytes.length, true);
  out.set(metaBytes, 4);
  out.set(png, 4 + metaBytes.length);
  return out;
}

describe("decodeFramePayload", () => {
  it("decodes meta and wraps the PNG bytes in an object URL", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const frame = decodeFramePayload(
      payload({ width: 640, height: 360, backend: BACKEND }, png),
    );
    expect(frame.width).toBe(640);
    expect(frame.height).toBe(360);
    expect(frame.backend.actual).toBe("cpu");
    expect(frame.presented).toBe(false);
    expect(frame.data_url.startsWith("blob:")).toBe(true);
    URL.revokeObjectURL(frame.data_url);
  });

  it("decodes a natively presented frame: flag set, no PNG, no object URL", () => {
    const frame = decodeFramePayload(
      payload(
        { width: 640, height: 360, backend: BACKEND, presented: true },
        new Uint8Array(0),
      ),
    );
    expect(frame.presented).toBe(true);
    expect(frame.data_url).toBe("");
    expect(frame.width).toBe(640);
  });

  it("accepts an ArrayBuffer payload", () => {
    const bytes = payload({ width: 1, height: 1, backend: BACKEND }, new Uint8Array([1]));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const frame = decodeFramePayload(buf as ArrayBuffer);
    expect(frame.width).toBe(1);
    URL.revokeObjectURL(frame.data_url);
  });

  it("rejects truncated payloads", () => {
    expect(() => decodeFramePayload(new Uint8Array([1, 2]))).toThrow(/truncated/);
    const bad = new Uint8Array(4);
    new DataView(bad.buffer).setUint32(0, 100, true);
    expect(() => decodeFramePayload(bad)).toThrow(/truncated/);
  });
});
