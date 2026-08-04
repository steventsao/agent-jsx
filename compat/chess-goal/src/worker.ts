import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";
import {
  ChessGoalMatch,
  DEFAULT_MAX_PLIES,
  initialChessGoalState,
  type ChessGoalState,
} from "./agents/match.tsx";
import { runReactiveStep } from "./generated/runtime/workflow-executor.ts";
import {
  ChessGoalMatchDurable,
  GeminiChessPlayerDurable,
  OpenaiChessPlayerDurable,
} from "./generated/think.cloudflare.ts";
import {
  parseThinkDecision,
  turnMessage,
  type ChessTurnInput,
  type ThinkTurnTrace,
} from "./providers.ts";
import { renderUi } from "./ui.ts";

export { ChessGoalMatchDurable, GeminiChessPlayerDurable, OpenaiChessPlayerDurable };

interface Env {
  AI: Ai;
  OPENROUTER_API_KEY: string;
  CHESS_GOAL_GAME: DurableObjectNamespace<ChessGoalGame>;
  CHESS_GOAL_MATCH: DurableObjectNamespace;
  OPENAI_CHESS_PLAYER: DurableObjectNamespace;
  GEMINI_CHESS_PLAYER: DurableObjectNamespace;
  DEMO_ACCESS_TOKEN: string;
}

interface ThinkPlayerStub {
  runTurnWithTrace(
    input: string,
    props?: Record<string, unknown>,
  ): Promise<ThinkTurnTrace>;
}

/** Cost control: a runaway live match must die cheap. */
const MAX_PLIES_CEILING = 40;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function authorized(request: Request, env: Env): boolean {
  if (!env.DEMO_ACCESS_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.DEMO_ACCESS_TOKEN}`;
}

export class ChessGoalGame extends DurableObject<Env> {
  #queue: Promise<unknown> = Promise.resolve();

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #state(): Promise<ChessGoalState> {
    return (await this.ctx.storage.get<ChessGoalState>("state")) ?? initialChessGoalState;
  }

  async #play(
    agent: string,
    stableId: string,
    props: Record<string, unknown>,
    turn: ChessTurnInput,
  ) {
    const binding = agent === "openai-chess-player"
      ? this.env.OPENAI_CHESS_PLAYER
      : agent === "gemini-chess-player"
        ? this.env.GEMINI_CHESS_PLAYER
        : null;
    if (!binding) throw new Error(`no generated Think binding for ${agent}`);

    // A distinct Think session per game/ply keeps every model transcript
    // durable without leaking context across games. An illegal-move retry
    // reuses the SAME session (same stableId), so the model sees its refusal.
    const instance = `${this.ctx.id.toString()}:${stableId}`;
    const player = await getAgentByName(binding as never, instance) as unknown as ThinkPlayerStub;
    const trace = await player.runTurnWithTrace(turnMessage(turn), props);
    // Never throws: the DOMAIN reducer is the authority on legality. An
    // illegal decision comes back around as lastError + the same phase.
    return parseThinkDecision(trace);
  }

  async fetch(request: Request): Promise<Response> {
    if (!authorized(request, this.env)) return json({ error: "invalid demo access token" }, 401);
    const action = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);

    if (request.method === "GET" && action === "state") return json({ state: await this.#state() });
    if (request.method === "POST" && action === "reset") {
      return this.#exclusive(async () => {
        const input: { maxPlies?: number } = await request.json<{ maxPlies?: number }>().catch(() => ({}));
        const maxPlies = Math.max(
          2,
          Math.min(MAX_PLIES_CEILING, Number(input.maxPlies) || DEFAULT_MAX_PLIES),
        );
        const state: ChessGoalState = {
          ...initialChessGoalState,
          history: [],
          log: [],
          maxPlies,
        };
        await this.ctx.storage.put("state", state);
        return json({ state });
      });
    }
    if (request.method === "POST" && action === "step") {
      return this.#exclusive(async () => {
        try {
          const result = await runReactiveStep({
            component: ChessGoalMatch.spec.impl,
            props: {},
            initialState: await this.#state(),
            delegate: (descriptor) => this.#play(
              descriptor.agent,
              descriptor.stableId,
              descriptor.input,
              descriptor.input.turn as ChessTurnInput,
            ),
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
    const id = env.CHESS_GOAL_GAME.idFromName(match[1]!);
    return env.CHESS_GOAL_GAME.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
