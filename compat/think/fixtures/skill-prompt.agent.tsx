import {
  Agent,
  compileAgentClass,
  type AgentSkillSource,
} from "../../../src/agent-class.tsx";

const reviewSkill = {
  id: "review",
  fingerprint: "review-v1",
  async list() {
    return [{ name: "review", description: "Review evidence carefully." }];
  },
  async load(name: string) {
    return name === "review"
      ? {
          name,
          description: "Review evidence carefully.",
          body: "Check every claim against its cited source.",
        }
      : null;
  },
} satisfies AgentSkillSource;

class SkillPromptAgentClass extends Agent<{ revision: string }> {
  static agentName = "skill-prompt";
  initialState = { revision: "startup" };

  render() {
    return this.define({
      model: "test/skill-prompt",
      prompt: (
        <prompt>
          <sys>AUTHORED_SKILL_PROMPT::{this.state.revision}</sys>
        </prompt>
      ),
      skills: [reviewSkill],
    });
  }
}

export const SkillPromptAgent = compileAgentClass(SkillPromptAgentClass);
