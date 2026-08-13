/**
 * A complete class-authoring example in one file.
 *
 * The two classes below are deliberately hierarchy-free. TriageAgent owns
 * durable state and a public operation; ResolverAgent knows only the input and
 * capabilities declared by ResolverProps. Neither class imports, constructs,
 * or names the other.
 */

import {
  Agent,
  callable,
  compileAgentClass,
  composeAgent,
  result,
} from "../src/agent-class.tsx";

interface Ticket extends Record<string, unknown> {
  id: string;
  subject: string;
  customerMessage: string;
}

interface Resolution extends Record<string, unknown> {
  ticketId: string;
  summary: string;
}

interface TriageProps {
  queue: string;
  ticket: Ticket;
}

interface TriageState extends Record<string, unknown> {
  resolutions: Resolution[];
}

/** Owns support state and operations, but declares no parent and no children. */
export class TriageAgent extends Agent<TriageState, TriageProps> {
  static agentName = "support-triage";
  model = "example/local-triage";
  description = "Routes a support ticket and records its resolution.";
  initialState: TriageState = { resolutions: [] };

  /** Public getters are exposed to the composition render prop. */
  get ticket() {
    return this.props.ticket;
  }

  get queue() {
    return this.props.queue;
  }

  /** @callable marks explicit authority that composition may grant. */
  @callable()
  recordResolution(resolution: Resolution) {
    this.setState((state) => ({
      ...state,
      resolutions: [...state.resolutions, resolution],
    }));
  }

  getPrompt() {
    return (
      <prompt>
        <sys p={10}>Triage ticket {this.props.ticket.id} in the {this.props.queue} queue.</sys>
        <msg p={7}>Previously resolved: {this.state.resolutions.length}.</msg>
      </prompt>
    );
  }

  /** render() is UI-only and never enters the prompt/control plane. */
  render() {
    return <p>{this.state.resolutions.length} ticket(s) resolved.</p>;
  }
}

interface ResolverProps {
  /** Plain serializable props are child input, not ambient shared state. */
  ticketId: string;
  subject: string;
  customerMessage: string;
  queue: string;
  /** Function props are capabilities and must be explicitly branded in JSX. */
  onResolved: (resolution: Resolution) => void | Promise<void>;
}

/** Resolves one ticket, but does not know whether it is anyone's child. */
export class ResolverAgent extends Agent<{ attempts: number }, ResolverProps> {
  static agentName = "support-resolver";
  model = "example/local-resolver";
  description = "Drafts a grounded resolution for one support ticket.";
  initialState = { attempts: 0 };

  getPrompt() {
    return (
      <prompt>
        <sys p={10}>Resolve ticket {this.props.ticketId} for the {this.props.queue} queue.</sys>
        <msg p={8}>Subject: {this.props.subject}</msg>
        <msg p={8}>Customer: {this.props.customerMessage}</msg>
      </prompt>
    );
  }

  /** Pure tool definitions keep this example compileable without a model,
   * network connection, or running agent host. */
  getTools() {
    return {
      draftReply: {
        description: "Draft a concise support reply.",
        execute: () => `Reply for ${this.props.ticketId}: we are investigating ${this.props.subject}.`,
      },
    };
  }

  /** UI can project the same props, but it grants no authority. */
  render() {
    return <p>Resolver assigned to {this.props.ticketId}.</p>;
  }
}

// Compiling a class creates its JSX boundary; it still creates no hierarchy.
export const Triage = compileAgentClass(TriageAgent);
export const Resolver = compileAgentClass(ResolverAgent);

const exampleTicket: Ticket = {
  id: "ticket-1042",
  subject: "Duplicate invoice",
  customerMessage: "I was charged twice for this month's subscription.",
};

/**
 * The classes are hierarchy-free; this JSX is the only place hierarchy and
 * authority exist.
 *
 * - `name` gives each boundary durable identity.
 * - ticket fields and `queue` are serializable child input.
 * - `result(recordResolution)` explicitly grants the child-to-parent result
 *   capability; nesting alone grants no RPC access.
 * - only getPrompt()/getTools()/getSkills() enter model context. render() is
 *   UI-only and never enters the prompt/control plane.
 */
export const SupportTriage = composeAgent(
  <Triage name="triage" queue="billing" ticket={exampleTicket}>
    {({ queue, ticket, recordResolution }) => (
      <Resolver
        name={`resolver:${ticket.id}`}
        ticketId={ticket.id}
        subject={ticket.subject}
        customerMessage={ticket.customerMessage}
        queue={queue}
        onResolved={result(recordResolution)}
      />
    )}
  </Triage>,
);
