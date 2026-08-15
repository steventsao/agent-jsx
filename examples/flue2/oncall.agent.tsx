import { Agent, callable } from "../../src/agent-class.tsx";

export interface OncallState extends Record<string, unknown> {
  incident: boolean;
  pageCount: number;
}

/** The uptime story, class form: the tool surface is derived state. Compiled
 *  to a flue 2.0 FUNCTION agent (compat/flue2) — every turn re-renders this
 *  class against durable state, so `page_oncall` exists only while an
 *  incident is active and the instruction tracks the live incident flag. */
export default class OncallAgent extends Agent<OncallState> {
  static agentName = "oncall";
  model = "openrouter/openai/gpt-5-mini";
  description = "Watches sites and pages oncall during incidents.";
  initialState: OncallState = { incident: false, pageCount: 0 };

  getPrompt() {
    return (
      <prompt>
        <sys p={10}>Incident active: {String(this.state.incident)}</sys>
      </prompt>
    );
  }

  getTools(): Record<string, unknown> {
    const tools: Record<string, unknown> = {
      check_status: {
        description: "Poll the site status.",
        execute: async () => "ok",
      },
    };
    if (this.state.incident) {
      tools.page_oncall = {
        description: "Page the oncall engineer.",
        execute: async () => {
          this.setState({ ...this.state, pageCount: this.state.pageCount + 1 });
          return "paged";
        },
      };
    }
    return tools;
  }

  @callable()
  markIncident(active: boolean) {
    this.setState({ ...this.state, incident: active });
  }
}
