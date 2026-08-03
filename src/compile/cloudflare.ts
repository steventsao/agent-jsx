/**
 * Public Cloudflare compiler surface. Graph discovery stays target-neutral;
 * callers choose deterministic reconciliation (`emitCloudflare`) or the full
 * model-facing definition lowering (`emitThink`).
 */
export {
  emitCloudflare,
  type ChildAgentSpec,
  type CloudflareEmit,
  type EmitOptions as CloudflareEmitOptions,
  type RootAgentSpec,
} from "./emit-cloudflare.ts";
export {
  emitThink,
  type ThinkChildAgentSpec,
  type ThinkEmit,
  type ThinkEmitOptions,
} from "./emit-think.ts";
export {
  analyzeAgent,
  directChildKinds,
  directChildSampleProps,
  discoverAgents,
  type AgentModule,
  type AgentNode,
  type AgentSample,
} from "./graph.ts";
export {
  discoverToolSlots,
  type ToolSlotBinding,
} from "./slots.ts";
