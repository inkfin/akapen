export type ParsedSuggestion = {
  reason: string | null;
  suggestedRubric: string | null;
  suggestedFeedbackGuide: string | null;
};

function compactSuggestion(s: ParsedSuggestion): ParsedSuggestion | null {
  if (!s.reason && !s.suggestedRubric && !s.suggestedFeedbackGuide) return null;
  return s;
}

export function parseSuggestion(raw: string | null): ParsedSuggestion | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") {
      const text = parsed.trim();
      return text ? { reason: text, suggestedRubric: null, suggestedFeedbackGuide: null } : null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    return compactSuggestion({
      reason:
        typeof obj.reason === "string" && obj.reason.trim()
          ? obj.reason.trim()
          : null,
      suggestedRubric:
        typeof obj.suggested_rubric === "string"
          ? obj.suggested_rubric.trim() || null
          : typeof obj.suggestedRubric === "string"
            ? obj.suggestedRubric.trim() || null
            : null,
      suggestedFeedbackGuide:
        typeof obj.suggested_feedback_guide === "string"
          ? obj.suggested_feedback_guide.trim() || null
          : typeof obj.suggestedFeedbackGuide === "string"
            ? obj.suggestedFeedbackGuide.trim() || null
            : null,
    });
  } catch {
    const text = raw.trim();
    if (!text) return null;
    return { reason: text, suggestedRubric: null, suggestedFeedbackGuide: null };
  }
}

export function normalizeSuggestionFromLLM(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text ? JSON.stringify({ reason: text }) : null;
  }
  if (Array.isArray(value)) {
    const parts = value.map((x) => String(x).trim()).filter(Boolean);
    return parts.length > 0 ? JSON.stringify({ reason: parts.join(" / ") }) : null;
  }
  if (typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const normalized = compactSuggestion({
    reason:
      typeof obj.reason === "string" && obj.reason.trim()
        ? obj.reason.trim()
        : null,
    suggestedRubric:
      typeof obj.suggested_rubric === "string"
        ? obj.suggested_rubric.trim() || null
        : typeof obj.suggestedRubric === "string"
          ? obj.suggestedRubric.trim() || null
          : null,
    suggestedFeedbackGuide:
      typeof obj.suggested_feedback_guide === "string"
        ? obj.suggested_feedback_guide.trim() || null
        : typeof obj.suggestedFeedbackGuide === "string"
          ? obj.suggestedFeedbackGuide.trim() || null
          : null,
  });
  if (!normalized) return null;
  return JSON.stringify({
    ...(normalized.reason ? { reason: normalized.reason } : {}),
    ...(normalized.suggestedRubric
      ? { suggested_rubric: normalized.suggestedRubric }
      : {}),
    ...(normalized.suggestedFeedbackGuide
      ? { suggested_feedback_guide: normalized.suggestedFeedbackGuide }
      : {}),
  });
}

export function extractPromptSuggestionFromResult(
  result: Record<string, unknown> | null | undefined,
): string | null {
  if (!result || typeof result !== "object") return null;
  const grading = result.grading;
  if (grading && typeof grading === "object") {
    const nested = normalizeSuggestionFromLLM(
      (grading as Record<string, unknown>).prompt_suggestion,
    );
    if (nested) return nested;
  }
  return normalizeSuggestionFromLLM(result.prompt_suggestion);
}

