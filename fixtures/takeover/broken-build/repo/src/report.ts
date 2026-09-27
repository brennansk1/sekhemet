import { drawChart } from "./chart.ts";
import { sumLines } from "./sum.ts";

export const report = (lines: number[]) => drawChart(sumLines(lines));
