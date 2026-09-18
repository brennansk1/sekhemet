import { describe, expect, it } from "vitest";
import { monteCarloForecast } from "../src/pm/metrics.js";

describe("Monte Carlo delivery forecast", () => {
  it("turns real throughput into a range, 85th percentile no earlier than the median", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const f = monteCarloForecast([0, 1, 2, 0, 3, 1, 1, 0, 2, 1], 10, 2000, rand);
    expect(f).toBeDefined();
    expect(f?.p50Days).toBeGreaterThanOrEqual(7);
    expect(f?.p85Days).toBeGreaterThanOrEqual(f?.p50Days ?? 0);
  });

  it("refuses to forecast from too little or no throughput", () => {
    expect(monteCarloForecast([1, 2], 5)).toBeUndefined();
    expect(monteCarloForecast([0, 0, 0, 0, 0, 0], 5)).toBeUndefined();
    expect(monteCarloForecast([1, 1, 1, 1, 1], 0)).toEqual({ p50Days: 0, p85Days: 0, samples: 5 });
  });
});
