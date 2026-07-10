export interface ActiveSelection {
  region: [number, number, number, number];
  ellipse: boolean;
  polygon?: [number, number][];
}
