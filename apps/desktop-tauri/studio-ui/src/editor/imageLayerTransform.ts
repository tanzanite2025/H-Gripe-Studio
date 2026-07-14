/** Committed image-layer transform parameters. Missing op fields resolve to identity values. */
export interface TransformParams {
  dx: number;
  dy: number;
  scale: number;
  rotate: number;
}

/** Compose `b` after `a` for transforms around the image centre. */
export function composeTransforms(a: TransformParams, b: TransformParams): TransformParams {
  const rad = (b.rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    dx: b.scale * (cos * a.dx - sin * a.dy) + b.dx,
    dy: b.scale * (sin * a.dx + cos * a.dy) + b.dy,
    scale: a.scale * b.scale,
    rotate: a.rotate + b.rotate,
  };
}
