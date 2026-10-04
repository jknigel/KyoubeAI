// src/decisions/tools.ts
import type { PluginContext, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { declarationsFor, registerToolHandlers, type ToolDefinition } from "../tool-runtime.js";
import { decideInputSchema, runDecide } from "./api-routes.js";
import type { DecisionService } from "./service.js";

const definitions: ToolDefinition<DecisionService>[] = [
  {
    name: "decisions_decide",
    displayName: "Typed decision",
    description: "Ask the company's typed-decision model closed questions about some text, a JSON object, or Data rows (rows are read under your own access). Answers are an option key, a level, or true/false, each with a confidence and a status: auto, or review (bring it to the person who started the task). Never use this instead of a person's approval. See the kyoube-decisions skill.",
    schema: decideInputSchema,
    run: (service, companyId, actor, params) => runDecide(service, companyId, actor, params),
  },
  {
    name: "decisions_status",
    displayName: "Typed decisions status",
    description: "Whether typed decisions are available to agents in this company, which provider and model answer them, and how much of today's budget is left.",
    schema: z.object({}).strict(),
    run: (service, companyId, actor) => service.status(companyId, actor, "agents"),
  },
];

export function decisionToolDeclarations(): PluginToolDeclaration[] {
  return declarationsFor(definitions);
}

export function registerDecisionTools(ctx: PluginContext, service: DecisionService): void {
  registerToolHandlers(ctx, definitions, service);
}
