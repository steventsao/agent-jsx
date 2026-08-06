import { optimizeFlueHarness } from "./optimizer.ts";

const report = await optimizeFlueHarness();

console.log(
  JSON.stringify(
    {
      baselineScore: report.baseline.meanScore,
      optimizedScore: report.optimized.meanScore,
      axBestScore: report.bestScore,
      componentMap: report.componentMap,
      axPredictionCalls: report.optimizationForwardCalls,
      baselineToolCalls: report.baseline.outputs.map((output) =>
        output.toolCalls.map((call) => call.name),
      ),
      optimizedToolCalls: report.optimized.outputs.map((output) =>
        output.toolCalls.map((call) => call.name),
      ),
      changedFiles: report.optimized.outputs.map(
        (output) => output.changedFiles,
      ),
    },
    null,
    2,
  ),
);

if (report.optimized.meanScore !== 1) {
  process.exitCode = 1;
}
