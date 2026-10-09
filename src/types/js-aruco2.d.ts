declare module 'js-aruco2' {
  interface ArucoMarker {
    id: number;
    corners: { x: number; y: number }[];
    hammingDistance: number;
  }
  export const AR: {
    Detector: new (config?: { dictionaryName?: string; maxHammingDistance?: number }) => {
      detect(image: { width: number; height: number; data: Uint8ClampedArray }): ArucoMarker[];
    };
    Dictionary: new (name: string) => { generateSVG(id: number): string };
  };
}
