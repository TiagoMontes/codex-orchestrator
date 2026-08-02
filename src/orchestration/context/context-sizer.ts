export type ContextSizeEstimate = {
  rawCharacters: number;
  estimatedTokens: number;
  source: "estimated";
  heuristic: "utf16-characters-divided-by-four";
  safetyMultiplier: number;
};

export class ContextSizer {
  constructor(private readonly safetyMultiplier = 1.3) {
    if (!Number.isFinite(safetyMultiplier) || safetyMultiplier < 1) {
      throw new RangeError("Context safety multiplier must be at least 1");
    }
  }

  estimate(value: unknown): ContextSizeEstimate {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    const rawCharacters = serialized.length;
    return {
      rawCharacters,
      estimatedTokens: Math.ceil((rawCharacters / 4) * this.safetyMultiplier),
      source: "estimated",
      heuristic: "utf16-characters-divided-by-four",
      safetyMultiplier: this.safetyMultiplier,
    };
  }
}
