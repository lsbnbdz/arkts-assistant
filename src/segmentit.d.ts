declare module 'segmentit' {
  interface SegmentResult {
    w: string;
    p?: number;
  }

  interface Segment {
    doSegment(text: string): SegmentResult[];
  }

  function useDefault(segment: Segment): void;

  const Segmentit: {
    Segment: new () => Segment;
    useDefault: typeof useDefault;
  };

  export = Segmentit;
}

