// LUT sampling and `.cube` parsing (mirror Rust `ops/lut.rs`).

import type { GradeOp } from "./ops";
import type { Rgb } from "./types";

// Per-channel linear 1D-LUT sample; `table` is size RGB triples (the .cube
// LUT_1D_SIZE layout), mirroring Rust `Lut1d::sample`.
export function lut1dSample(size: number, table: number[], channel: number, v: number): number {
  const pos = v * (size - 1);
  const i0 = Math.min(Math.floor(pos), size - 2);
  const f = pos - i0;
  const a = table[i0 * 3 + channel];
  const b = table[(i0 + 1) * 3 + channel];
  return a + (b - a) * f;
}

// Tetrahedral 3D-LUT sample (the design doc's single LUT-sampling
// definition); `table` is size³ × 3 with red varying fastest (the .cube
// convention), mirroring Rust `Lut3d::sample`.
export function lut3dSample(size: number, table: number[], rgb: Rgb): Rgb {
  const n = size - 1;
  const pos = rgb.map((v) => v * n);
  const i0 = pos.map((p) => Math.min(Math.floor(p), size - 2));
  const [fr, fg, fb] = pos.map((p, c) => p - i0[c]);
  const v = (dr: number, dg: number, db: number): Rgb => {
    const e = (((i0[2] + db) * size + (i0[1] + dg)) * size + (i0[0] + dr)) * 3;
    return [table[e], table[e + 1], table[e + 2]];
  };
  let w1: number, e1: Rgb, w2: number, e2: Rgb, w3: number, e3: Rgb;
  if (fr > fg) {
    if (fg > fb) [w1, e1, w2, e2, w3, e3] = [fr, v(1, 0, 0), fg, v(1, 1, 0), fb, v(1, 1, 1)];
    else if (fr > fb) [w1, e1, w2, e2, w3, e3] = [fr, v(1, 0, 0), fb, v(1, 0, 1), fg, v(1, 1, 1)];
    else [w1, e1, w2, e2, w3, e3] = [fb, v(0, 0, 1), fr, v(1, 0, 1), fg, v(1, 1, 1)];
  } else if (fb > fg) [w1, e1, w2, e2, w3, e3] = [fb, v(0, 0, 1), fg, v(0, 1, 1), fr, v(1, 1, 1)];
  else if (fb > fr) [w1, e1, w2, e2, w3, e3] = [fg, v(0, 1, 0), fb, v(0, 1, 1), fr, v(1, 1, 1)];
  else [w1, e1, w2, e2, w3, e3] = [fg, v(0, 1, 0), fr, v(1, 1, 0), fb, v(1, 1, 1)];
  const e0 = v(0, 0, 0);
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = e0[c] + w1 * (e1[c] - e0[c]) + w2 * (e2[c] - e1[c]) + w3 * (e3[c] - e2[c]);
  }
  return out;
}

/**
 * Parse a `.cube` LUT into a `lut3d` (LUT_3D_SIZE) or `lut1d` (LUT_1D_SIZE)
 * op (mirrors Rust `parse_cube`). Supports TITLE, the standard 0..1 DOMAIN,
 * comments.
 */
export function parseCube(text: string): GradeOp {
  let size: number | null = null;
  let size1d: number | null = null;
  const table: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineno = 0; lineno < lines.length; lineno++) {
    const line = lines[lineno].trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const head = parts[0];
    if (head === "TITLE") continue;
    if (head === "LUT_3D_SIZE") {
      const v = Number(parts[1]);
      if (!Number.isInteger(v) || v < 2) throw new Error(`line ${lineno + 1}: bad LUT_3D_SIZE`);
      size = v;
    } else if (head === "DOMAIN_MIN" || head === "DOMAIN_MAX") {
      const want = head === "DOMAIN_MIN" ? 0 : 1;
      for (let k = 1; k <= 3; k++) {
        if (Number(parts[k]) !== want) throw new Error(`line ${lineno + 1}: only the standard 0..1 domain is supported`);
      }
    } else if (head === "LUT_1D_SIZE") {
      const v = Number(parts[1]);
      if (!Number.isInteger(v) || v < 2) throw new Error(`line ${lineno + 1}: bad LUT_1D_SIZE`);
      size1d = v;
    } else {
      if (parts.length < 3) throw new Error(`line ${lineno + 1}: expected 3 values`);
      for (let k = 0; k < 3; k++) {
        const v = Number(parts[k]);
        if (!Number.isFinite(v)) throw new Error(`line ${lineno + 1}: bad value`);
        table.push(v);
      }
    }
  }
  if (size !== null && size1d !== null) {
    throw new Error("both LUT_3D_SIZE and LUT_1D_SIZE present; split the shaper into its own file");
  }
  if (size !== null) {
    if (table.length !== size * size * size * 3) {
      throw new Error(`expected ${size * size * size * 3} table values, got ${table.length}`);
    }
    return { type: "lut3d", size, table };
  }
  if (size1d !== null) {
    if (table.length !== size1d * 3) {
      throw new Error(`expected ${size1d * 3} table values, got ${table.length}`);
    }
    return { type: "lut1d", size: size1d, table };
  }
  throw new Error("missing LUT_3D_SIZE or LUT_1D_SIZE");
}
