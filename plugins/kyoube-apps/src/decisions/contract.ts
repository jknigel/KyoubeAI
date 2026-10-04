import { createHash } from "node:crypto";
import { z } from "zod";
import { DataError } from "../data/errors.js";

/**
 * Kyoube's own decision contract (spec §2). No provider's type, field name or alias appears
 * here: `client.ts` is the only file that knows the `/v1/systemone` wire format, so swapping
 * providers never changes what agents, apps or the app SDK see.
 */
export const QUESTION_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_QUESTIONS = 20;
export const MAX_CHOICE_OPTIONS = 254;
export const MAX_SCORE_LEVELS = 10;
export const MAX_INSTRUCTIONS = 2000;
export const MAX_OPTION_DESCRIPTION = 500;
export const MAX_LEVEL_LABEL = 120;
/** 96 KB keeps a request under OpenRouter's 32k-token limit. Counted in UTF-8 bytes. */
export const MAX_REQUEST_BYTES = 96 * 1024;
export const DEFAULT_REVIEW = 0.9;
export const UNSURE = "unsure";
export const UNSURE_DESCRIPTION = "None of the options clearly fits";

export type Surface = "agents" | "columns" | "apps" | "guardrail";
export const SURFACES: readonly Surface[] = ["agents", "columns", "apps", "guardrail"];

export const questionKeySchema = z.string().regex(QUESTION_KEY_RE, "keys must match ^[a-z][a-z0-9_]{0,39}$");
const review = z.number().min(0).max(1).optional();
const instructions = z.string().trim().min(1).max(MAX_INSTRUCTIONS);

export const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions,
  options: z.record(questionKeySchema, z.string().max(MAX_OPTION_DESCRIPTION).nullable())
    .refine((options) => Object.keys(options).filter((key) => key !== UNSURE).length >= 2, "a choice needs at least 2 options besides unsure")
    .refine((options) => Object.keys(options).filter((key) => key !== UNSURE).length <= MAX_CHOICE_OPTIONS, `a choice takes at most ${MAX_CHOICE_OPTIONS} options besides unsure`),
  review,
}).strict();

export const scoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions,
  levels: z.array(z.string().trim().min(1).max(MAX_LEVEL_LABEL)).min(2).max(MAX_SCORE_LEVELS)
    .refine((levels) => new Set(levels).size === levels.length, "levels must be distinct"),
  review,
}).strict();

export const checkQuestionSchema = z.object({ type: z.literal("check"), statement: instructions, review }).strict();

export const questionSchema = z.discriminatedUnion("type", [choiceQuestionSchema, scoreQuestionSchema, checkQuestionSchema]);
export const questionsSchema = z.record(questionKeySchema, questionSchema)
  .refine((questions) => Object.keys(questions).length >= 1, "ask at least one question")
  .refine((questions) => Object.keys(questions).length <= MAX_QUESTIONS, `ask at most ${MAX_QUESTIONS} questions per request`);
export const stateSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);
export const decideRequestSchema = z.object({ state: stateSchema, questions: questionsSchema }).strict();

export type ChoiceQuestion = z.infer<typeof choiceQuestionSchema>;
export type ScoreQuestion = z.infer<typeof scoreQuestionSchema>;
export type CheckQuestion = z.infer<typeof checkQuestionSchema>;
export type Question = z.infer<typeof questionSchema>;
export type DecideRequest = z.infer<typeof decideRequestSchema>;

export interface Answer {
  type: Question["type"];
  /** The option key (choice), the level label (score), or true/false (check). */
  value: string | boolean;
  confidence: number;
  status: "auto" | "review";
  probabilities?: Record<string, number>;
}

export interface DecideResult {
  /** Null when the decision log could not be written; the answers are still good. */
  decisionId: string | null;
  model: string;
  answers: Record<string, Answer>;
}

function issueText(error: z.ZodError, root: string): string {
  return error.issues.map((issue) => `${[root, ...issue.path].filter(Boolean).join(".")} ${issue.message}`).join("; ");
}

export function parseQuestion(raw: unknown, path = "question"): Question {
  const parsed = questionSchema.safeParse(raw);
  if (!parsed.success) throw new DataError("invalid", issueText(parsed.error, path));
  return parsed.data;
}

export function parseQuestions(raw: unknown): Record<string, Question> {
  const parsed = questionsSchema.safeParse(raw);
  if (!parsed.success) throw new DataError("invalid", issueText(parsed.error, "questions"));
  return parsed.data;
}

export function parseDecideRequest(raw: unknown): DecideRequest {
  const parsed = decideRequestSchema.safeParse(raw);
  if (!parsed.success) throw new DataError("invalid", issueText(parsed.error, ""));
  return parsed.data;
}

/** Every choice gets an `unsure` way out (spec §2): a choice can only return an option it was given. */
export function withUnsure(question: Question): Question {
  if (question.type !== "choice" || Object.hasOwn(question.options, UNSURE)) return question;
  return { ...question, options: { ...question.options, [UNSURE]: UNSURE_DESCRIPTION } };
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** Groups the same question across calls in the decision log; the threshold is not part of it. */
export function questionFingerprint(question: Question): string {
  const q = withUnsure(question);
  const body = q.type === "check"
    ? { type: q.type, statement: q.statement }
    : q.type === "choice" ? { type: q.type, instructions: q.instructions, options: q.options } : { type: q.type, instructions: q.instructions, levels: q.levels };
  return createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex");
}

export function assertRequestSize(request: { state: unknown; questions: unknown }): void {
  const bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  if (bytes > MAX_REQUEST_BYTES) {
    throw new DataError("too_large", `the request is ${bytes} bytes; at most ${MAX_REQUEST_BYTES} bytes are allowed, so send less state`);
  }
}

export function reviewThreshold(question: Question): number {
  return question.review ?? DEFAULT_REVIEW;
}

export function answerStatus(question: Question, value: string | boolean, confidence: number, advisory = false): "auto" | "review" {
  if (advisory) return "review";
  if (question.type === "choice" && value === UNSURE) return "review";
  return confidence < reviewThreshold(question) ? "review" : "auto";
}
