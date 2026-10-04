// src/decisions/api-routes.ts
import type { PluginApiRequestInput, PluginApiResponse, PluginApiRouteDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { actorFromRequest, errorBody, route, statusForError } from "../api-routes.js";
import { DataError } from "../data/errors.js";
import type { DataActor } from "../data/permissions.js";
import { questionsSchema, stateSchema } from "./contract.js";
import { MAX_ROWS_PER_CALL, type DecisionService } from "./service.js";

export const DECISION_API_ROUTES: PluginApiRouteDeclaration[] = [
  route("decisions.decide", "POST", "/decisions/decide"),
  route("decisions.status", "GET", "/decisions/status"),
];

const rowsSchema = z.object({
  table: z.string().min(1),
  ids: z.array(z.string()).min(1).max(MAX_ROWS_PER_CALL),
  fields: z.array(z.string()).min(1).max(20).optional(),
}).strict();

const decideFields = {
  state: stateSchema.optional().describe("text or a JSON object to judge; send this or rows"),
  rows: rowsSchema.optional().describe("Data rows to judge, read under your own access; one decision per row; send this or state"),
  questions: questionsSchema.describe("named questions: choice (options), score (levels, low to high) or check (statement)"),
  includeProbabilities: z.boolean().optional(),
};
const exactlyOne = (input: { state?: unknown; rows?: unknown }) => (input.state === undefined) !== (input.rows === undefined);

export const decideInputSchema = z.object(decideFields).strict().refine(exactlyOne, "send exactly one of state or rows");
const decideBodySchema = z.object({ ...decideFields, companyId: z.string() }).strict().refine(exactlyOne, "send exactly one of state or rows");
export type DecideInput = z.infer<typeof decideInputSchema>;

export function runDecide(service: DecisionService, companyId: string, actor: DataActor, input: DecideInput): Promise<unknown> {
  const opts = { includeProbabilities: input.includeProbabilities === true };
  if (input.rows) return service.decideRows(companyId, actor, "agents", input.rows, input.questions, opts);
  return service.decide(companyId, actor, "agents", { state: input.state!, questions: input.questions }, opts);
}

export async function handleDecisionsApiRequest(
  service: DecisionService,
  input: PluginApiRequestInput,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<PluginApiResponse | null> {
  if (!input.routeKey.startsWith("decisions.")) return null;
  if (!input.actor.actorId) return { status: 403, body: { error: "forbidden: unauthenticated", code: "forbidden" } };
  const companyId = input.companyId;
  const actor = actorFromRequest(input);
  try {
    switch (input.routeKey) {
      case "decisions.decide": {
        const parsed = decideBodySchema.safeParse(input.body ?? {});
        if (!parsed.success) throw new DataError("invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"} ${issue.message}`).join("; "));
        const { companyId: _company, ...decide } = parsed.data;
        return { status: 200, body: await runDecide(service, companyId, actor, decide) };
      }
      case "decisions.status":
        return { status: 200, body: await service.status(companyId, actor, "agents") };
      default:
        return { status: 404, body: { error: `unknown route ${input.routeKey}`, code: "not_found" } };
    }
  } catch (error) {
    if (error instanceof DataError) return { status: statusForError(error), body: errorBody(error) };
    // Ruling P2-R24: the raw error goes to the operator log, never to the caller.
    log?.("decisions request failed", { routeKey: input.routeKey, companyId, error: String(error) });
    return { status: 500, body: { error: "error: internal error", code: "error" } };
  }
}
