export interface ChessTurnInput {
  ply: number;
  side: "white" | "black";
  fen: string;
  legalMoves: string[];
  history: unknown[];
}

export interface ChessDecision {
  move: string;
  note: string;
}

export interface ModelEnv {
  OPENROUTER_API_KEY: string;
  GEMINI_API_KEY: string;
  OPENAI_MODEL?: string;
  GEMINI_MODEL?: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ChessAgentClass = typeof OpenAIAgent | typeof GeminiAgent;
type ChessProvider = (
  turn: ChessTurnInput,
  env: ModelEnv,
  fetcher: Fetcher,
) => Promise<ChessDecision>;

function moveSchema(legalMoves: string[]) {
  return {
    type: "object",
    properties: {
      move: {
        type: "string",
        enum: legalMoves,
        description: "One legal move in UCI notation.",
      },
      note: {
        type: "string",
        description: "A short explanation of the chess idea.",
      },
    },
    required: ["move", "note"],
    additionalProperties: false,
  } as const;
}

function geminiMoveSchema(legalMoves: string[]) {
  const { additionalProperties: _unsupported, ...schema } = moveSchema(legalMoves);
  return schema;
}

function prompt(turn: ChessTurnInput): string {
  const recent = turn.history.slice(-8);
  return [
    `You are playing ${turn.side} at ply ${turn.ply}.`,
    `FEN: ${turn.fen}`,
    `Recent moves: ${JSON.stringify(recent)}`,
    `Legal UCI moves: ${turn.legalMoves.join(", ")}`,
    "Choose exactly one move from the legal list. Return JSON only.",
  ].join("\n");
}

async function responseError(provider: string, response: Response): Promise<Error> {
  const detail = (await response.text()).slice(0, 500);
  return new Error(`${provider} request failed (${response.status}): ${detail}`);
}

function parseDecision(text: string, legalMoves: string[]): ChessDecision {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(clean);
  } catch {
    throw new Error(`model returned invalid JSON: ${clean.slice(0, 160)}`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { move?: unknown }).move !== "string"
  ) {
    throw new Error("model response is missing a move string");
  }
  const move = (value as { move: string }).move.toLowerCase();
  if (!legalMoves.includes(move)) throw new Error(`model returned illegal move ${move}`);
  const note = (value as { note?: unknown }).note;
  return { move, note: typeof note === "string" ? note : "" };
}

async function openAIMove(
  turn: ChessTurnInput,
  env: ModelEnv,
  fetcher: Fetcher,
): Promise<ChessDecision> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");
  const schema = moveSchema(turn.legalMoves);
  const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL ?? "openai/gpt-5-mini",
      messages: [
        { role: "system", content: "Play strong, legal chess. Follow the response schema exactly." },
        { role: "user", content: prompt(turn) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "chess_move", strict: true, schema },
      },
    }),
  });
  if (!response.ok) throw await responseError("OpenRouter", response);
  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenRouter returned no message content");
  return parseDecision(text, turn.legalMoves);
}

async function geminiMove(
  turn: ChessTurnInput,
  env: ModelEnv,
  fetcher: Fetcher,
): Promise<ChessDecision> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const model = env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const response = await fetcher(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt(turn) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          // Gemini's generateContent responseSchema rejects the otherwise
          // standard `additionalProperties` keyword; semantic validation still
          // happens below before a move reaches chess.js.
          responseSchema: geminiMoveSchema(turn.legalMoves),
        },
      }),
    },
  );
  if (!response.ok) throw await responseError("Gemini", response);
  const json = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
  if (!text) throw new Error("Gemini returned no candidate text");
  return parseDecision(text, turn.legalMoves);
}

const providerByAgentClass = new Map<ChessAgentClass, ChessProvider>([
  [OpenAIAgent, openAIMove],
  [GeminiAgent, geminiMove],
]);

export function isChessAgentClass(value: unknown): value is ChessAgentClass {
  return typeof value === "function" && providerByAgentClass.has(value as ChessAgentClass);
}

export async function chooseMove(
  agentClass: ChessAgentClass,
  turn: ChessTurnInput,
  env: ModelEnv,
  fetcher: Fetcher = fetch,
): Promise<ChessDecision> {
  const provider = providerByAgentClass.get(agentClass);
  if (!provider) throw new Error(`unbound chess agent class ${agentClass.spec.agentName}`);
  return provider(turn, env, fetcher);
}
import { GeminiAgent, OpenAIAgent } from "./agents/players.tsx";
