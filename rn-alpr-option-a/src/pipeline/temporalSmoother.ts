import type { OcrResult } from '@types/alpr';

type Entry = {
  text: string;
  confidence: number;
};

export class TemporalSmoother {
  private readonly windowSize: number;
  private readonly queue: Entry[] = [];

  constructor(windowSize = 7) {
    this.windowSize = Math.max(3, windowSize);
  }

  push(result: OcrResult): OcrResult {
    this.queue.push({ text: result.text, confidence: result.confidence });
    if (this.queue.length > this.windowSize) {
      this.queue.shift();
    }

    const counts = new Map<string, { count: number; confidenceSum: number }>();
    for (const item of this.queue) {
      const current = counts.get(item.text) || { count: 0, confidenceSum: 0 };
      current.count += 1;
      current.confidenceSum += item.confidence;
      counts.set(item.text, current);
    }

    let bestText = result.text;
    let bestCount = 0;
    let bestAvg = 0;

    for (const [text, data] of counts.entries()) {
      const avg = data.confidenceSum / data.count;
      if (data.count > bestCount || (data.count === bestCount && avg > bestAvg)) {
        bestText = text;
        bestCount = data.count;
        bestAvg = avg;
      }
    }

    return {
      text: bestText,
      confidence: bestAvg > 0 ? bestAvg : result.confidence,
    };
  }

  reset(): void {
    this.queue.length = 0;
  }
}
