import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { PaintTarget } from "../maskTools";
import { DEFAULT_MAGNETIC_SNAP } from "./magneticSnap";

export interface BrushParamsController {
  brushSize: number;
  setBrushSize: Dispatch<SetStateAction<number>>;
  brushHardness: number;
  setBrushHardness: Dispatch<SetStateAction<number>>;
  brushFlow: number;
  setBrushFlow: Dispatch<SetStateAction<number>>;
  brushSpacing: number;
  setBrushSpacing: Dispatch<SetStateAction<number>>;
  magneticWidth: number;
  setMagneticWidth: Dispatch<SetStateAction<number>>;
  magneticContrast: number;
  setMagneticContrast: Dispatch<SetStateAction<number>>;
  magneticFrequency: number;
  setMagneticFrequency: Dispatch<SetStateAction<number>>;
  paintTarget: PaintTarget;
  setPaintTarget: Dispatch<SetStateAction<PaintTarget>>;
  tolerance: number;
  setTolerance: Dispatch<SetStateAction<number>>;
  shrinkBrush: () => void;
  growBrush: () => void;
  softenBrush: () => void;
  hardenBrush: () => void;
}

export function useBrushParams(wandTolerance: number): BrushParamsController {
  const [brushSize, setBrushSize] = useState(24);
  const [brushHardness, setBrushHardness] = useState(1);
  const [brushFlow, setBrushFlow] = useState(1);
  const [brushSpacing, setBrushSpacing] = useState(0.25);
  const [magneticWidth, setMagneticWidth] = useState(DEFAULT_MAGNETIC_SNAP.width);
  const [magneticContrast, setMagneticContrast] = useState(DEFAULT_MAGNETIC_SNAP.contrast);
  const [magneticFrequency, setMagneticFrequency] = useState(DEFAULT_MAGNETIC_SNAP.frequency);
  const [paintTarget, setPaintTarget] = useState<PaintTarget>("layer");
  const [tolerance, setTolerance] = useState(wandTolerance);

  const shrinkBrush = useCallback(() => {
    setBrushSize((size) => Math.max(1, size - 4));
  }, []);
  const growBrush = useCallback(() => {
    setBrushSize((size) => Math.min(96, size + 4));
  }, []);
  const softenBrush = useCallback(() => {
    setBrushHardness((hardness) => Math.max(0, Math.round((hardness - 0.25) * 100) / 100));
  }, []);
  const hardenBrush = useCallback(() => {
    setBrushHardness((hardness) => Math.min(1, Math.round((hardness + 0.25) * 100) / 100));
  }, []);

  return {
    brushSize,
    setBrushSize,
    brushHardness,
    setBrushHardness,
    brushFlow,
    setBrushFlow,
    brushSpacing,
    setBrushSpacing,
    magneticWidth,
    setMagneticWidth,
    magneticContrast,
    setMagneticContrast,
    magneticFrequency,
    setMagneticFrequency,
    paintTarget,
    setPaintTarget,
    tolerance,
    setTolerance,
    shrinkBrush,
    growBrush,
    softenBrush,
    hardenBrush,
  };
}
