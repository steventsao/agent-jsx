import {
  createHarness,
  type JsonValue,
  type TranscriptEvent,
} from "vitest-evals";
import {
  runFlueWorkspaceEpisode,
  type EpisodeOutcome,
} from "./episode.ts";
import type { WorkspaceCase, WorkspaceHarness } from "./harness.ts";

function argumentsRecord(
  value: EpisodeOutcome["toolCalls"][number]["arguments"],
): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

export function createFlueEvalHarness(harness: WorkspaceHarness) {
  return createHarness<WorkspaceCase, EpisodeOutcome>({
    name: "flue-workspace-episode",
    async run({ input, signal }) {
      const output = await runFlueWorkspaceEpisode(harness, input, signal);
      const events: TranscriptEvent[] = [
        { type: "message", role: "user", content: input.task },
      ];

      for (const call of output.toolCalls) {
        events.push({
          type: "tool_call",
          id: call.id,
          name: call.name,
          arguments: argumentsRecord(call.arguments),
          durationMs: call.durationMs,
          metadata: { origin: call.origin },
        });
        events.push({
          type: "tool_result",
          toolCallId: call.id,
          name: call.name,
          content: call.result,
          durationMs: call.durationMs,
          ...(call.isError
            ? { error: { message: `${call.name} failed` } }
            : {}),
        });
      }

      events.push({
        type: "message",
        role: "assistant",
        content: output.response,
      });

      return {
        output,
        events,
        usage: {
          provider: harness.model.split("/")[0],
          model: harness.model.split("/").slice(1).join("/"),
          inputTokens: output.usage.inputTokens,
          outputTokens: output.usage.outputTokens,
          totalTokens: output.usage.totalTokens,
          toolCalls: output.toolCalls.length,
          metadata: { cost: output.usage.cost },
        },
        timings: { totalMs: output.durationMs },
        artifacts: {
          score: output.score,
          success: output.success,
          changedFiles: output.changedFiles,
          violations: output.violations,
        },
      };
    },
  });
}
