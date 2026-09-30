/**
 * LLM evaluation of `intent` watch conditions: does a detected change (or, when a
 * watch is created, the page as it stands) satisfy what the user asked to be told
 * about — "an investment internship appears", "availability opens"?
 *
 * Unlike the relevance filter (`ai-alert-triage.ts`, which only screens out noise
 * and leans toward notifying), this is a strict matcher: an unclear or negative
 * answer is `not_matched`. Only failures to get an answer at all (misconfiguration,
 * timeout, unreadable output) are `error`, which callers deliver rather than drop,
 * so an outage can never silently swallow a real match.
 */

import { generateText } from "ai";
import type { AlertKind, Website } from "./db/schema";
import { buildChangePayload, buildWebsiteContext, createLanguageModel, type AiSummaryConfig, type AlertDetailsForSummary } from "./ai-change-summary";
import type { ConditionOutcome } from "./watch-conditions";

const LLM_TIMEOUT_MS = 30_000;
/** Headroom for reasoning models, whose hidden reasoning counts toward output tokens. */
const MAX_OUTPUT_TOKENS = 600;
const MAX_CHANGE_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 6_000;
const MAX_STATE_CHARS = 12_000;
const MAX_REASON_CHARS = 300;
const MAX_EVIDENCE_ITEMS = 5;
const MAX_EVIDENCE_CHARS = 300;

export const CHANGE_SYSTEM_PROMPT = `You check whether a change on a monitored web page satisfies a user's request.

You receive the user's request, the lines ADDED and REMOVED by this change, and the current page for context.

Rules:
- Answer matched=true only if the change itself clearly satisfies the request: the requested thing newly appeared, or the requested state newly became true. Content that was already on the page before this change does not count.
- Use the current page only to understand context, such as which section a new line belongs to.
- Removed lines matter only when the request is about something disappearing or changing.
- If the change is unrelated, ambiguous, or you are unsure, answer matched=false.
- Evidence must be copied verbatim from the ADDED or REMOVED lines.

Reply with a single minified JSON object and nothing else:
{"matched": boolean, "reason": "<one short sentence>", "evidence": ["<verbatim line>"]}`;

export const STATE_SYSTEM_PROMPT = `You check whether a web page currently satisfies a user's request.

Rules:
- Answer matched=true only if the page clearly and currently satisfies the request, for example the requested item is listed or the requested state is true.
- If it does not, or you are unsure, answer matched=false.
- Evidence must be copied verbatim from the page.

Reply with a single minified JSON object and nothing else:
{"matched": boolean, "reason": "<one short sentence>", "evidence": ["<verbatim line>"]}`;

/** Injectable model call (tests supply a stub); returns the model's raw text. */
export type GenerateFn = (args: { system: string; prompt: string }) => Promise<string>;

function defaultGenerate(config: AiSummaryConfig): GenerateFn {
  return async ({ system, prompt }) => {
    const { text } = await generateText({
      model: createLanguageModel(config),
      system,
      prompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    return text;
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 20)}\n… (truncated)`;
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Non-blank lines present in `after` but not `before`, and vice versa (same set semantics as diffPreview). */
export function changedLines(before: string, after: string): { added: string[]; removed: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    added: b.filter((l) => l.trim() && !setA.has(l)),
    removed: a.filter((l) => l.trim() && !setB.has(l)),
  };
}

/**
 * Read a model reply. Only an explicit boolean `matched` is an answer; anything else
 * is `error`. Evidence is kept only when it actually occurs in `sourceText`, so a
 * hallucinated quote is never presented as proof.
 */
export function parseIntentDecision(text: string | null | undefined, sourceText: string): ConditionOutcome {
  const unreadable: ConditionOutcome = { status: "error", reason: "The AI returned an unreadable answer.", evidence: [] };
  if (!text?.trim()) return unreadable;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return unreadable;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return unreadable;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unreadable;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.matched !== "boolean") return unreadable;

  const haystack = normalize(sourceText);
  const evidence = (Array.isArray(obj.evidence) ? obj.evidence : [])
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    .map((e) => e.trim().slice(0, MAX_EVIDENCE_CHARS))
    .filter((e) => haystack.includes(normalize(e)))
    .slice(0, MAX_EVIDENCE_ITEMS);
  const reason =
    (typeof obj.reason === "string" ? obj.reason.trim().slice(0, MAX_REASON_CHARS) : "") ||
    (obj.matched ? "Matches the request." : "Does not match the request.");

  return obj.matched ? { status: "matched", reason, evidence } : { status: "not_matched", reason, evidence: [] };
}

/** The change as the matcher sees it: labeled added/removed content plus page context. */
export function buildIntentChangeInput(
  alertKind: AlertKind,
  details: AlertDetailsForSummary,
  title: string,
): { changeText: string; contextText: string | null } {
  if (alertKind === "PAGE_CONTENT" && details.beforeMarkdown != null && details.afterMarkdown != null) {
    const { added, removed } = changedLines(details.beforeMarkdown, details.afterMarkdown);
    const changeText = [
      `ADDED lines (${added.length}):`,
      added.join("\n") || "(none)",
      "",
      `REMOVED lines (${removed.length}):`,
      removed.join("\n") || "(none)",
    ].join("\n");
    return { changeText, contextText: details.afterMarkdown };
  }
  return { changeText: buildChangePayload(alertKind, details, title), contextText: null };
}

type SiteContext = Pick<Website, "name" | "domain" | "url" | "title" | "description">;

/** Did this detected change satisfy the request? */
export async function matchIntentChange(params: {
  config: AiSummaryConfig | null;
  intent: string;
  website: SiteContext;
  alertKind: AlertKind;
  title: string;
  details: AlertDetailsForSummary;
  generate?: GenerateFn;
}): Promise<ConditionOutcome> {
  if (!params.config && !params.generate) {
    return { status: "error", reason: "No AI provider is configured to evaluate this condition.", evidence: [] };
  }
  const { changeText, contextText } = buildIntentChangeInput(params.alertKind, params.details, params.title);
  const change = truncate(changeText, MAX_CHANGE_CHARS);
  const prompt = [
    `Website:\n${buildWebsiteContext(params.website)}`,
    "",
    `User's request: "${params.intent.trim()}"`,
    "",
    `Change type: ${params.alertKind}`,
    "",
    "Change:",
    change,
    ...(contextText ? ["", "Current page (context only):", truncate(contextText, MAX_CONTEXT_CHARS)] : []),
  ].join("\n");
  return runModel(params.generate ?? defaultGenerate(params.config!), CHANGE_SYSTEM_PROMPT, prompt, change);
}

/** Does the page as it stands already satisfy the request? (Used when a watch is created.) */
export async function matchIntentState(params: {
  config: AiSummaryConfig | null;
  intent: string;
  website: SiteContext;
  stateText: string;
  generate?: GenerateFn;
}): Promise<ConditionOutcome> {
  if (!params.config && !params.generate) {
    return { status: "error", reason: "No AI provider is configured to evaluate this condition.", evidence: [] };
  }
  const state = truncate(params.stateText, MAX_STATE_CHARS);
  const prompt = [
    `Website:\n${buildWebsiteContext(params.website)}`,
    "",
    `User's request: "${params.intent.trim()}"`,
    "",
    "Page:",
    state,
  ].join("\n");
  return runModel(params.generate ?? defaultGenerate(params.config!), STATE_SYSTEM_PROMPT, prompt, state);
}

async function runModel(generate: GenerateFn, system: string, prompt: string, sourceText: string): Promise<ConditionOutcome> {
  try {
    return parseIntentDecision(await generate({ system, prompt }), sourceText);
  } catch (err) {
    console.error("AI intent match failed:", err);
    return { status: "error", reason: "The AI could not be reached to evaluate this condition.", evidence: [] };
  }
}
