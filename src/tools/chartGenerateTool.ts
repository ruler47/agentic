/**
 * Phase 13 follow-up: the in-process ChartGenerateTool class has
 * been removed in favour of the dockerized chart-generate-service.
 * This file now exists only to expose the result-data shape and
 * its type guard, which the runtime still uses to recognise chart
 * artifacts in tool results regardless of whether they came from
 * the docker service or any other implementation that conforms to
 * the chart.generate output contract.
 */
import { ArtifactCreateInput } from "../types.js";

export type ChartToolData = {
  artifact: ArtifactCreateInput;
  points: number;
};

export function isChartToolData(data: unknown): data is ChartToolData {
  return (
    Boolean(data) &&
    typeof data === "object" &&
    Boolean((data as { artifact?: unknown }).artifact) &&
    typeof (data as { points?: unknown }).points === "number"
  );
}
