export const MAX_PROMPT_CHARS = 8000;
export const MAX_ANSWER_CHARS = 2000;

export function buildQuestionAnswer(pendingQuestions, rawAnswers) {
  if (!Array.isArray(rawAnswers) || rawAnswers.length !== pendingQuestions.length) return null;
  const knownIds = new Set(pendingQuestions.map((q) => q.id));
  const seen = new Set();
  const answers = [];
  for (const item of rawAnswers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const id = item.id;
    if (typeof id !== 'string' || !knownIds.has(id) || seen.has(id)) return null;
    seen.add(id);
    if (typeof item.text !== 'string') return null;
    const custom = item.text.trim();
    if (!custom || custom.length > MAX_ANSWER_CHARS) return null;
    answers.push({ id, selected: [], custom });
  }
  return seen.size === pendingQuestions.length ? { answers } : null;
}
