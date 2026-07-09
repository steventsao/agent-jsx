// Worker entry: exports the GENERATED classes (created by scripts/generate.ts).
export { UptimeDurable, InvestigatorDurable } from "./generated/uptime.cloudflare.ts";
export {
  ContRootDurable,
  ContEmitterDurable,
  ContFolderDurable,
} from "./generated/continuation.cloudflare.ts";

export default {
  async fetch(): Promise<Response> {
    return new Response("agent-jsx compat worker");
  },
};
