import {
  AxMockAIService,
  AxProgram,
  optimize,
  type AxAIService,
  type AxGenStreamingOut,
  type AxGEPAAdapter,
  type AxOptimizableComponent,
  type AxProgramForwardOptions,
  type AxProgramStreamingForwardOptions,
} from "@ax-llm/ax";
import {
  applyHarnessCandidate,
  OPTIMIZED_WORKSPACE_GUIDE,
  readHarnessComponent,
  REQUIRED_WORKSPACE_RULE,
  seedHarness,
  validateWorkspaceGuide,
  WORKSPACE_GUIDE_COMPONENT,
  workspaceCases,
  type WorkspaceCase,
  type WorkspaceHarness,
} from "./harness.ts";
import {
  runFlueWorkspaceEpisode,
  type EpisodeOutcome,
} from "./episode.ts";

type EpisodeTrajectory = {
  calls: Array<{
    fn: string;
    componentId: string;
    args: unknown;
    result: unknown;
    ok: boolean;
    ms: number;
  }>;
  output: {
    success: boolean;
    changedFiles: string[];
    response: string;
  };
  error?: string;
};

type CandidateEvaluation = {
  outputs: EpisodeOutcome[];
  scores: number[];
  trajectories: EpisodeTrajectory[];
};

export type HarnessOptimizationReport = {
  baseline: CandidateEvaluation & { meanScore: number };
  optimized: CandidateEvaluation & { meanScore: number };
  optimizedHarness: WorkspaceHarness;
  componentMap: Record<string, string>;
  bestScore: number;
  optimizationForwardCalls: number;
};

const componentDefinitions = {
  [WORKSPACE_GUIDE_COMPONENT]: {
    kind: "workspace-guidance",
    description:
      "Repository-level guidance mounted as AGENTS.md before Flue initializes.",
    constraints:
      "Keep safety rules intact; explain how to inspect, edit, and verify the workspace.",
    preserve: [REQUIRED_WORKSPACE_RULE],
    maxLength: 1_000,
  },
} as const;

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function trajectoryFor(output: EpisodeOutcome): EpisodeTrajectory {
  return {
    calls: output.toolCalls.map((call) => ({
      fn: call.name,
      componentId: "flue.workspace",
      args: call.arguments,
      result: call.result,
      ok: !call.isError,
      ms: call.durationMs,
    })),
    output: {
      success: output.success,
      changedFiles: output.changedFiles,
      response: output.response,
    },
    ...(output.error ? { error: output.error } : {}),
  };
}

async function evaluateHarness(
  harness: WorkspaceHarness,
  examples: readonly WorkspaceCase[],
): Promise<CandidateEvaluation> {
  const outputs: EpisodeOutcome[] = [];
  for (const example of examples) {
    outputs.push(await runFlueWorkspaceEpisode(harness, example));
  }

  return {
    outputs,
    scores: outputs.map((output) => output.score),
    trajectories: outputs.map(trajectoryFor),
  };
}

class FlueHarnessProgram extends AxProgram<WorkspaceCase, EpisodeOutcome> {
  private harness: WorkspaceHarness;
  forwardCalls = 0;

  constructor(harness: WorkspaceHarness) {
    super(undefined);
    this.setId("flue-workspace-harness.v1");
    this.harness = harness;
  }

  getHarness(): WorkspaceHarness {
    return this.harness;
  }

  async forward(
    _ai: Readonly<AxAIService>,
    input: WorkspaceCase,
    _options?: Readonly<AxProgramForwardOptions<string>>,
  ): Promise<EpisodeOutcome> {
    this.forwardCalls += 1;
    return runFlueWorkspaceEpisode(this.harness, input);
  }

  async *streamingForward(
    ai: Readonly<AxAIService>,
    input: WorkspaceCase,
    options?: Readonly<AxProgramStreamingForwardOptions<string>>,
  ): AxGenStreamingOut<EpisodeOutcome> {
    const output = await this.forward(ai, input, options);
    yield { version: 1, index: 0, delta: output, partial: output };
  }

  protected override localOptimizableComponents():
    readonly AxOptimizableComponent[] {
    return Object.entries(componentDefinitions).map(([key, definition]) => {
      const current = readHarnessComponent(this.harness, key);
      if (current === undefined) {
        throw new Error(`Harness component is not readable: ${key}`);
      }

      return {
        key,
        current,
        ...definition,
        validate: validateWorkspaceGuide,
      };
    });
  }

  protected override applyLocalOptimizedComponents(
    updates: Readonly<Record<string, string>>,
  ): void {
    this.harness = applyHarnessCandidate(this.harness, updates);
  }
}

function createEpisodeAdapter(
  baseHarness: WorkspaceHarness,
): AxGEPAAdapter<WorkspaceCase, EpisodeTrajectory, EpisodeOutcome> {
  return {
    async evaluate(batch, candidate, captureTraces) {
      // Ax passes the candidate map to the adapter without mutating the program.
      // Materialize it into a fresh harness before every batch of Flue episodes.
      const candidateHarness = applyHarnessCandidate(baseHarness, candidate);
      const evaluation = await evaluateHarness(candidateHarness, batch);

      if (
        evaluation.outputs.length !== batch.length ||
        evaluation.scores.length !== batch.length
      ) {
        throw new Error("Ax adapter results must preserve batch order and length");
      }

      return {
        outputs: evaluation.outputs,
        scores: evaluation.scores,
        trajectories: captureTraces ? evaluation.trajectories : null,
      };
    },

    make_reflective_dataset(
      _candidate,
      evaluation,
      componentsToUpdate,
    ) {
      const datasets: Record<
        string,
        Array<{
          score: number;
          calls: EpisodeTrajectory["calls"];
          output: EpisodeTrajectory["output"];
          error?: string;
        }>
      > = {};

      for (const key of componentsToUpdate) {
        datasets[key] = evaluation.outputs.map((output, index) => {
          const trajectory = evaluation.trajectories?.[index];
          return {
            score: evaluation.scores[index] ?? 0,
            calls: trajectory?.calls ?? [],
            output: trajectory?.output ?? {
              success: output.success,
              changedFiles: output.changedFiles,
              response: output.response,
            },
            ...(trajectory?.error ? { error: trajectory.error } : {}),
          };
        });
      }

      return datasets;
    },

    propose_new_texts(_candidate, _dataset, componentsToUpdate) {
      // This deterministic proposer keeps the example offline. In production,
      // omit it and give Ax a reflection model; episode execution stays Flue-native.
      const validation = validateWorkspaceGuide(OPTIMIZED_WORKSPACE_GUIDE);
      if (validation !== true) {
        throw new Error(`Invalid offline proposal: ${validation}`);
      }

      return Object.fromEntries(
        componentsToUpdate.map((key) => {
          if (key !== WORKSPACE_GUIDE_COMPONENT) {
            throw new Error(`No offline proposal is defined for ${key}`);
          }
          return [key, OPTIMIZED_WORKSPACE_GUIDE];
        }),
      );
    },
  };
}

export async function optimizeFlueHarness(): Promise<HarnessOptimizationReport> {
  const program = new FlueHarnessProgram(seedHarness);
  const adapter = createEpisodeAdapter(seedHarness);
  const baseline = await evaluateHarness(seedHarness, workspaceCases);

  const result = await optimize(
    program,
    workspaceCases,
    () => {
      throw new Error(
        "The fallback Ax metric must not run when the episode adapter succeeds",
      );
    },
    {
      studentAI: new AxMockAIService<string>(),
      gepaAdapter: adapter,
      bootstrap: false,
      numTrials: 1,
      minibatch: true,
      minibatchSize: 1,
      earlyStoppingTrials: 1,
      maxMetricCalls: 6,
      seed: 1,
    },
  );

  if (!result.optimizedProgram) {
    throw new Error("Ax did not return an optimized harness artifact");
  }

  program.applyOptimization(result.optimizedProgram);
  const optimizedHarness = program.getHarness();
  const optimized = await evaluateHarness(optimizedHarness, workspaceCases);

  return {
    baseline: { ...baseline, meanScore: mean(baseline.scores) },
    optimized: { ...optimized, meanScore: mean(optimized.scores) },
    optimizedHarness,
    componentMap: { ...result.optimizedProgram.componentMap },
    bestScore: result.bestScore,
    optimizationForwardCalls: program.forwardCalls,
  };
}
