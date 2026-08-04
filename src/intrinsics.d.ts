import type {
  PhaseProps,
  TaskProps,
  ScheduleProps,
  ScopeProps,
  SensorProps,
  SubagentProps,
  ToolProps,
} from "./types.ts";
import type { Attributes, ReactNode } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      // Infra: reconciled against the host by (kind, name)
      sensor: SensorProps & Attributes;
      schedule: ScheduleProps & Attributes;
      subagent: SubagentProps & Attributes;
      tool: ToolProps & Attributes;
      task: TaskProps & Attributes;
      // Goal: a declared phase of a long-horizon machine. Reconciles to no
      // record; swept into the transition graph by collectPhases.
      phase: PhaseProps & Attributes;
      // Context: assembled under a token budget with priompt semantics
      prompt: { children?: ReactNode } & Attributes;
      sys: { p?: number; prel?: number; children?: ReactNode } & Attributes;
      msg: { p?: number; prel?: number; children?: ReactNode } & Attributes;
      scope: ScopeProps & Attributes;
    }
  }
}
