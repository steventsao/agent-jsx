import { DurableObject } from "cloudflare:workers";
import { ChessMatch, initialChessState, type ChessState } from "./agents/match.tsx";
import { runReactiveStep } from "./generated/runtime/workflow-executor.ts";
import { chooseMove, isChessAgentClass, type ChessTurnInput, type ModelEnv } from "./providers.ts";
import { renderUi } from "./ui.ts";

interface Env extends ModelEnv {
  CHESS_GAME: DurableObjectNamespace<ChessGame>;
  DEMO_ACCESS_TOKEN: string;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function authorized(request: Request, env: Env): boolean {
  if (!env.DEMO_ACCESS_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.DEMO_ACCESS_TOKEN}`;
}

export class ChessGame extends DurableObject<Env> {
  #queue: Promise<unknown> = Promise.resolve();

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #state(): Promise<ChessState> {
    return (await this.ctx.storage.get<ChessState>("state")) ?? initialChessState;
  }

  async fetch(request: Request): Promise<Response> {
    if (!authorized(request, this.env)) return json({ error: "invalid demo access token" }, 401);
    const action = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);

    if (request.method === "GET" && action === "state") return json({ state: await this.#state() });
    if (request.method === "POST" && action === "reset") {
      return this.#exclusive(async () => {
        const input: { maxPlies?: number } = await request.json<{ maxPlies?: number }>().catch(() => ({}));
        const maxPlies = Math.max(2, Math.min(200, Number(input.maxPlies) || 80));
        const state: ChessState = { ...initialChessState, history: [], maxPlies };
        await this.ctx.storage.put("state", state);
        return json({ state });
      });
    }
    if (request.method === "POST" && action === "step") {
      return this.#exclusive(async () => {
        try {
          const result = await runReactiveStep({
            component: ChessMatch.spec.impl,
            props: {},
            initialState: await this.#state(),
            delegate: (descriptor) => {
              if (!isChessAgentClass(descriptor.target)) {
                throw new Error(`no typed provider binding for ${descriptor.agent}`);
              }
              return chooseMove(descriptor.target, descriptor.input.turn as ChessTurnInput, this.env);
            },
          });
          await this.ctx.storage.put("state", result.state);
          return json({ state: result.state, descriptor: result.descriptor });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return json({ error: message }, 502);
        }
      });
    }
    return json({ error: "not found" }, 404);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return renderUi();
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });

    const match = url.pathname.match(/^\/api\/games\/([A-Za-z0-9_-]{1,64})\/(state|step|reset)$/);
    if (!match) return json({ error: "not found" }, 404);
    const id = env.CHESS_GAME.idFromName(match[1]!);
    return env.CHESS_GAME.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
