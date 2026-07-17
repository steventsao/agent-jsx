import { describe, expect, it } from "bun:test";
import { emitCloudflareClientApi } from "../src/compile/emit-client-api.ts";

const apiSpec = {
  agentName: "document-review",
  bindingName: "DOCUMENT_REVIEW",
  stateTypeName: "DocumentReviewState",
  stateImport: "../agents/document-review-agent.tsx",
  actionsImport: "../agents/document-review-actions.ts",
  snapshotExport: "documentReviewSnapshot",
  reducerExport: "runDocumentReviewAction",
  actionTypeName: "DocumentReviewAction",
  clientName: "DocumentReviewGeneratedClient",
  promptBudget: 220,
  title: "Document Review",
  actions: [
    {
      type: "receiveDocument",
      path: "/api/channels/document",
      methodName: "sendDocument",
      params: "input: { name?: string; pdfB64: string }",
      body: `{ channel: "document", document: input }`,
      replaceState: true,
    },
    { type: "tryHarder", path: "/api/try-harder", methodName: "tryHarder" },
    {
      type: "ok",
      path: "/api/ok",
      methodName: "ok",
      params: "candidateId?: string",
      body: "{ candidateId }",
    },
    { type: "reset", path: "/api/reset", methodName: "reset", replaceState: true },
  ],
};

describe("emitCloudflareClientApi", () => {
  it("generates HTTP routes, action dispatch, and a typed browser client", () => {
    const out = emitCloudflareClientApi(apiSpec);

    expect(out.api).toContain("export async function handleDocumentReviewApi");
    expect(out.api).toContain("export async function handleDocumentReviewAgentRequest");
    expect(out.api).toContain(`import { getAgentByName, routeAgentRequest } from "agents";`);
    expect(out.api).toContain(`if (path === "/api/state"`);
    expect(out.api).toContain(`path === "/api/channels/document"`);
    expect(out.api).toContain(`path === "/api/try-harder"`);
    expect(out.api).toContain(`path === "/api/ok"`);
    expect(out.api).toContain(`type: "tryHarder"`);
    expect(out.api).toContain(`type: "ok"`);
    expect(out.api).toContain("class DocumentReviewGeneratedClient");
    expect(out.api).toContain(`/agents/\${AGENT_NAMESPACE}/\${encodedAgent}\${normalizedPath}`);
    expect(out.api).toContain("const AGENT_NAMESPACE = \"document-review\"");
    expect(out.api).toContain("await getAgentByName(");
    expect(out.api).toContain("env.DOCUMENT_REVIEW as never");
    expect(out.api).toContain("return agent.fetch(req);");
    expect(out.api).not.toContain("reconcile?(): Promise<void>;");
    expect(out.api).not.toContain("await agent.reconcile?.();");
    expect(out.api).toContain("const childUrl = (kind, name, path) =>");
    expect(out.api).toContain(`fetch(childUrl(child.kind, child.name, "/api/drive"), { method: "POST" })`);
    expect(out.api).toContain("async sendDocument(input: { name?: string; pdfB64: string })");
    expect(out.api).toContain("async tryHarder()");
    expect(out.api).toContain("async ok(candidateId?: string)");
    expect(out.api).toContain("renderDocumentReviewPage");
    expect(out.api).toContain(`<script type="module">`);
    expect(out.api).toContain(`url.pathname === "/favicon.ico"`);
    expect(out.api).toContain("const routed = await routeAgentRequest(req, env);");
    expect(out.api).toContain(`id="doc"`);
  });

  it("keeps domain policy in the authored action module", () => {
    const out = emitCloudflareClientApi(apiSpec);

    expect(out.api).toContain(
      `import { documentReviewSnapshot, runDocumentReviewAction, type DocumentReviewAction } from "../agents/document-review-actions.ts";`
    );
    expect(out.api).not.toContain("requestedAttempts + 1");
    expect(out.api).not.toContain("acceptedId:");
  });
});
