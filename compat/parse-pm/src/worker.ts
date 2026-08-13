/**
 * The parse PM on the metal: ParsePmAgent is a REAL `agents` Agent (v0.20.1)
 * whose durable state is the composition's ParsePmState, whose drive loop runs
 * inside `this.runFiber` (keepAlive held, checkpoints `stash`ed, interrupted
 * fibers detected on wake), and whose routes are the human surface the CF
 * doctrine asks for:
 *
 *   POST /api/parse/:id/run     start a run { budgetUsd?, pdfB64?, … }
 *   GET  /api/parse/:id/status  the structured plan + spend + checkpoint +
 *                               segments — the approval surface
 *   POST /api/parse/:id/topup   the human gate: { amountUsd } then re-drive
 *   POST /api/parse/:id/resume  idempotent re-drive (a manual wake)
 *
 * All /api routes are bearer-guarded by env.DEMO_ACCESS_TOKEN (a secret
 * binding by NAME). The model provider is env-selected: the scripted fake
 * under PARSE_PM_FAKE_PROVIDER=1 (tests), OpenRouter via env.OPENROUTER_API_KEY
 * otherwise (model-runtime.ts) — the composition cannot tell the difference,
 * which is the point of the seam.
 *
 * Durability map (real primitives, no emulation):
 *   - agent state  = ParsePmState, persisted by `this.setState` (SQLite)
 *   - the DOC      = ctx.storage "doc" — NEVER in state, NEVER in child input
 *   - checkpoints  = written into state BEFORE each metered call via the
 *                    composition's persist port (setState + fiber stash)
 *   - eviction     = an interrupted `parse-drive` fiber row; on the next wake
 *                    the agents runtime calls onFiberRecovered, which re-drives
 *                    from the checkpointed state (completed regions are skipped
 *                    by the composition itself — the ledger proves it)
 */

import {
  Agent,
  getAgentByName,
  type FiberRecoveryContext,
} from "agents";
import { SAMPLE_PDF_B64 } from "../../../fixtures/pdf/sample-pdf.ts";
import { b64ToBytes, pageTextItems, type PositionedItem } from "./domain/extract.ts";
import { REGIONS } from "./domain/regions.ts";
import {
  initialParsePmState,
  PARSE_GOAL_TABLE,
  ParseAgent,
  type ParsePmState,
} from "./agents/parse-agent.tsx";
import { driveToRest, playRegionExtractor, type PlayedChild } from "./agents/drive.ts";
import { fakeProvider } from "./agents/fake-provider.ts";
import { usd, type ModelProvider, type ParsePorts } from "./agents/ports.ts";
import { resolveParseProvider } from "./model-runtime.ts";
import { renderUi } from "./ui.ts";

interface Env {
  PARSE_PM_AGENT: DurableObjectNamespace;
  DEMO_ACCESS_TOKEN: string;
  OPENROUTER_API_KEY?: string;
  PARSE_PM_MODEL?: string;
  PARSE_PM_FAKE_PROVIDER?: string;
}

export interface RunInput {
  budgetUsd?: number;
  pdfB64?: string;
  /** TEST seam: regions whose first metered call never resolves — how the
   *  eviction spec freezes a drive mid-extract. Consumed durably before the
   *  hang, so the post-eviction re-drive completes. */
  hangRegions?: string[];
  /** TEST seam: return immediately, leave the drive fiber in flight. */
  background?: boolean;
}

export interface StatusPayload {
  /** In-memory instance marker — changes iff the DO was actually restarted. */
  bootId: string;
  plan: typeof PARSE_GOAL_TABLE;
  phase: string;
  budgetUsd: number;
  spentUsd: number;
  callCount: number;
  checkpoint: ParsePmState["checkpoint"];
  refusals: ParsePmState["refusals"];
  ledger: ParsePmState["ledger"];
  segments: Array<{ id: string; text: string; label: string }>;
  verified: ParsePmState["verified"];
  log: ParsePmState["log"];
  lastPlayed: PlayedChild[];
  recovered: { fiberId: string; name: string } | null;
}

/** Runaway protection: a demo checkbook is capped in cents, not dollars. */
const MAX_BUDGET_USD = 0.5;
const clampUsd = (value: unknown, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return usd(Math.min(n, MAX_BUDGET_USD));
};

export class ParsePmAgent extends Agent<Env, ParsePmState> {
  initialState = initialParsePmState;

  /** Proof-of-restart marker for the eviction spec: storage survives, this
   *  does not. */
  #bootId = crypto.randomUUID();
  #items: PositionedItem[] | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #pageItems(): Promise<PositionedItem[]> {
    if (this.#items) return this.#items;
    const doc = await this.ctx.storage.get<string>("doc");
    if (!doc) throw new Error("no doc in PM storage — POST run first");
    this.#items = await pageTextItems(b64ToBytes(doc));
    return this.#items;
  }

  #provider(): ModelProvider {
    const base =
      this.env.PARSE_PM_FAKE_PROVIDER === "1"
        ? fakeProvider()
        : resolveParseProvider(this.env);
    return {
      maxCallCostUsd: base.maxCallCostUsd,
      classifyRegion: async (input) => {
        const hang = (await this.ctx.storage.get<string[]>("hangRegions")) ?? [];
        if (hang.includes(input.regionId)) {
          // Consume the flag FIRST (durably), then never resolve — the fiber
          // is now stuck exactly like a network call at eviction time, and
          // the post-eviction re-drive runs without the flag.
          await this.ctx.storage.delete("hangRegions");
          return await new Promise<never>(() => {});
        }
        return base.classifyRegion(input);
      },
    };
  }

  /** One converge-to-rest step, as a durable fiber. The composition owns ALL
   *  policy; this method only wires its ports to real primitives. */
  #drive(): Promise<void> {
    return this.#exclusive(() =>
      this.runFiber("parse-drive", async (fiber) => {
        const items = await this.#pageItems();
        const ports: ParsePorts = {
          ingest: async () => {
            const doc = await this.ctx.storage.get<string>("doc");
            if (!doc) throw new Error("no doc in PM storage");
            return { bytes: doc.length };
          },
          layout: () => REGIONS,
          pageItems: () => items,
          model: this.#provider(),
          persist: (state) => {
            // The durable write barrier: agent state is SQLite-backed, and the
            // checkpoint is ALSO stashed on the fiber row so an interrupted
            // drive carries its own recovery context.
            this.setState(state as ParsePmState);
            fiber.stash({ checkpoint: (state as ParsePmState).checkpoint });
          },
        };
        const result = await driveToRest({
          component: ParseAgent.spec.impl,
          props: { ports },
          initialState: this.state,
          play: playRegionExtractor,
        });
        this.setState(result.state);
        await this.ctx.storage.put("lastPlayed", result.played);
      }),
    );
  }

  /** The agents runtime calls this on wake when a drive died mid-flight
   *  (eviction). Re-driving is idempotent: the checkpointed state already
   *  knows which regions are paid for. */
  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
    await this.ctx.storage.put("recovered", { fiberId: ctx.id, name: ctx.name });
    if (ctx.name === "parse-drive") await this.#drive();
  }

  async run(input: RunInput | undefined): Promise<StatusPayload> {
    const budgetUsd = clampUsd(input?.budgetUsd, 0.05);
    await this.ctx.storage.put("doc", input?.pdfB64 || SAMPLE_PDF_B64);
    if (input?.hangRegions?.length) {
      await this.ctx.storage.put("hangRegions", input.hangRegions.slice(0, 8));
    } else {
      await this.ctx.storage.delete("hangRegions");
    }
    await this.ctx.storage.delete("lastPlayed");
    await this.ctx.storage.delete("recovered");
    this.#items = null;
    this.setState({ ...initialParsePmState, budgetUsd });
    if (input?.background) {
      void this.#drive().catch((error) => console.error("[parse-pm] drive failed:", error));
      return this.status();
    }
    await this.#drive();
    return this.status();
  }

  async topup(input: { amountUsd?: number } | undefined): Promise<StatusPayload> {
    const amount = clampUsd(input?.amountUsd, 0);
    if (amount > 0) {
      this.setState({ ...this.state, budgetUsd: usd(this.state.budgetUsd + amount) });
    }
    await this.#drive();
    return this.status();
  }

  async resume(): Promise<StatusPayload> {
    await this.#drive();
    return this.status();
  }

  async status(): Promise<StatusPayload> {
    const state = this.state;
    const lastPlayed = (await this.ctx.storage.get<PlayedChild[]>("lastPlayed")) ?? [];
    const recovered =
      (await this.ctx.storage.get<{ fiberId: string; name: string }>("recovered")) ?? null;
    return {
      bootId: this.#bootId,
      plan: PARSE_GOAL_TABLE,
      phase: state.goal?.phase ?? PARSE_GOAL_TABLE.initial,
      budgetUsd: state.budgetUsd,
      spentUsd: state.spentUsd,
      callCount: state.callCount,
      checkpoint: state.checkpoint,
      refusals: state.refusals,
      ledger: state.ledger,
      segments: (state.assembled ?? []).map(({ id, text, label }) => ({ id, text, label })),
      verified: state.verified,
      log: state.log,
      lastPlayed,
      recovered,
    };
  }
}

// ---------------------------------------------------------------------------

interface ParsePmStub {
  run(input: RunInput): Promise<StatusPayload>;
  topup(input: { amountUsd?: number }): Promise<StatusPayload>;
  resume(): Promise<StatusPayload>;
  status(): Promise<StatusPayload>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function authorized(request: Request, env: Env): boolean {
  if (!env.DEMO_ACCESS_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.DEMO_ACCESS_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return renderUi();
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });

    const match = url.pathname.match(
      /^\/api\/parse\/([A-Za-z0-9_-]{1,64})\/(run|status|topup|resume)$/,
    );
    if (!match) return json({ error: "not found" }, 404);
    if (!authorized(request, env)) return json({ error: "invalid demo access token" }, 401);

    const [, id, action] = match;
    const agent = (await getAgentByName(
      env.PARSE_PM_AGENT as never,
      id!,
    )) as unknown as ParsePmStub;

    try {
      if (request.method === "GET" && action === "status") return json(await agent.status());
      if (request.method === "POST" && action === "run") {
        const input = await request.json<RunInput>().catch(() => ({}) as RunInput);
        return json(await agent.run(input));
      }
      if (request.method === "POST" && action === "topup") {
        const input = await request
          .json<{ amountUsd?: number }>()
          .catch(() => ({}) as { amountUsd?: number });
        return json(await agent.topup(input));
      }
      if (request.method === "POST" && action === "resume") return json(await agent.resume());
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
