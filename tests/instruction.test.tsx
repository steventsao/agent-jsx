/** @jsxImportSource ../src/instruction */
import { describe, expect, it } from "bun:test";

import {
  Code,
  Fragment,
  jsx,
  List,
  P,
  renderChildren,
  Section,
  System,
  type InstructionChild,
} from "../src/instruction/index.ts";

describe("instruction: inline composition", () => {
  it("concatenates text and expressions with no injected separators", () => {
    const name = "Steven";
    expect(<P>Reply concisely to {name}.</P>).toBe("\n\nReply concisely to Steven.");
  });

  it("renders numbers and skips null/undefined/booleans", () => {
    expect(renderChildren(["a", 1, null, undefined, false, true, "b"])).toBe("a1b");
  });

  it("joins multi-line JSX text into prose (single spaces)", () => {
    const doc = <System>You are a document parser. Convert pages to clean markdown.</System>;
    expect(doc).toBe("You are a document parser. Convert pages to clean markdown.");
  });
});

describe("instruction: blocks", () => {
  it("Section renders a heading and self-separates from siblings", () => {
    const doc = (
      <System>
        Intro line.
        <Section title="Rules">Be terse.</Section>
        <Section title="Output">Markdown only.</Section>
      </System>
    );
    expect(doc).toBe("Intro line.\n\n## Rules\n\nBe terse.\n\n## Output\n\nMarkdown only.");
  });

  it("Section nests via level and renders bare headings without content", () => {
    expect(<Section title="Top" level={1} />).toBe("\n\n# Top");
    const nested = (
      <Section title="Outer">
        <Section title="Inner" level={3}>
          deep
        </Section>
      </Section>
    );
    expect(nested).toBe("\n\n## Outer\n\n### Inner\n\ndeep");
  });

  it("List renders items, ordered lists, and drops empty items", () => {
    expect(<List items={["a", "", "b", null]} />).toBe("\n\n- a\n- b");
    expect(<List ordered items={["first", "second"]} />).toBe("\n\n1. first\n2. second");
    expect(<List items={[]} />).toBe("");
    const staticList = (
      <List>
        {"one"}
        {"two"}
      </List>
    );
    expect(staticList).toBe("\n\n- one\n- two");
  });

  it("Code fences verbatim template-literal content", () => {
    const block = <Code lang="json">{'{\n  "bbox": [0, 0, 10, 10]\n}'}</Code>;
    expect(block).toBe('\n\n```json\n{\n  "bbox": [0, 0, 10, 10]\n}\n```');
  });

  it("collapses blank-line runs from raw text next to self-prefixing blocks", () => {
    const doc = (
      <System>
        {"Intro with trailing newline.\n"}
        <Section title="Next">content</Section>
      </System>
    );
    expect(doc).toBe("Intro with trailing newline.\n\n## Next\n\ncontent");
  });
});

describe("instruction: composition", () => {
  function Persona(props: { role: string; children?: InstructionChild }) {
    return (
      <Section title="Role">
        You are {props.role}.{props.children}
      </Section>
    );
  }

  it("user-defined components are plain functions returning strings", () => {
    expect(<Persona role="a support agent" />).toBe("\n\n## Role\n\nYou are a support agent.");
  });

  it("fragments concatenate directly", () => {
    expect(
      <>
        {"a"}
        {"b"}
      </>,
    ).toBe("ab");
    expect(Fragment({ children: ["x", "y"] })).toBe("xy");
  });

  it("conditional blocks render or vanish — the cond && element idiom", () => {
    const render = (escalate: boolean) => (
      <System>
        Handle the ticket.
        {escalate && <Section title="Escalation">Page the on-call.</Section>}
      </System>
    );
    expect(render(true)).toBe("Handle the ticket.\n\n## Escalation\n\nPage the on-call.");
    expect(render(false)).toBe("Handle the ticket.");
  });
});

describe("instruction: flue 2.0 return contract", () => {
  // Mirrors flue's whatsapp-channel assistant: if/else over instance data
  // picks the shape, hooks would mount capabilities, and the RETURN is the
  // document — here a JSX tree that collapses to the plain string flue's
  // assertAgentInstruction (typeof === "string") accepts unchanged.
  function Assistant(data: { contactName?: string; groupId?: string }) {
    let audience: string;
    if (data.groupId !== undefined) {
      audience = "the bound group chat";
    } else if (data.contactName !== undefined) {
      audience = `the conversation with ${data.contactName}`;
    } else {
      audience = "the bound conversation";
    }
    return (
      <System>
        Reply concisely in {audience}.
        <Section title="Style">
          <List items={["plain text only", "no markdown headers in replies"]} />
        </Section>
      </System>
    );
  }

  it("an agent-shaped function returns a plain string flue accepts", () => {
    const instruction = Assistant({ contactName: "Ada" });
    expect(typeof instruction).toBe("string");
    expect(instruction).toBe(
      "Reply concisely in the conversation with Ada.\n\n## Style\n\n- plain text only\n- no markdown headers in replies",
    );
    expect(typeof Assistant({ groupId: "g1" })).toBe("string");
  });
});

describe("instruction: runtime guards", () => {
  it("rejects non-function element types (no intrinsic elements)", () => {
    expect(() => jsx("div", null)).toThrow(/Only function components/);
  });

  it("rejects components that do not return a string", () => {
    const Broken = () => 42 as unknown as string;
    expect(() => jsx(Broken, {})).toThrow(/must return a string/);
  });

  it("rejects object children (an uncalled component or data element)", () => {
    expect(() => renderChildren({} as unknown as InstructionChild)).toThrow(/Unsupported child/);
  });
});
