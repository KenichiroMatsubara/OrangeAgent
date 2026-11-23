/**
 * How a model an AI Connection names is shown: Claude's by its family and
 * version in words, every other model by its own name, which is the only word
 * there is for it.
 */

/** The most models one AI Connection names, the default among them. */
export const AI_MODEL_LIMIT = 20;

/** The Claude models the AI Connection offers to add with one tap, the most capable first. */
export const CLAUDE_MODELS: readonly string[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];

const capitalized = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** `claude-opus-5-5`, `claude-haiku-4-5-20251001`, and `claude-3-5-sonnet-20241022` read as their family and version. */
const claudeParts = (model: string): { family: string; version: string } | null => {
  const current = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/u.exec(model);
  if (current?.[1] && current[2]) return { family: capitalized(current[1]), version: current[3] ? `${current[2]}.${current[3]}` : current[2] };
  const earlier = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8}|-latest)?$/u.exec(model);
  if (earlier?.[1] && earlier[3]) return { family: capitalized(earlier[3]), version: earlier[2] ? `${earlier[1]}.${earlier[2]}` : earlier[1] };
  return null;
};

/** The model as a person reads it: `claude-opus-5-5` is Claude Opus 5.5; any other model is its own name. */
export const modelLabel = (model: string): string => {
  const parts = claudeParts(model);
  return parts ? `Claude ${parts.family} ${parts.version}` : model;
};

/** The model in the fewest words that still tell it apart, for a control with little room: Opus 5.5. */
export const shortModelLabel = (model: string): string => {
  const parts = claudeParts(model);
  return parts ? `${parts.family} ${parts.version}` : model;
};

/**
 * How hard a model thinks before it answers, the lightest first: every level
 * any provider names. A model takes some of them, or none: Claude's from
 * low to max, OpenAI's and OpenRouter's from none to xhigh, Gemini's from
 * minimal to high; which, its API or OrangeAgent's table says (the Worker's
 * effort.ts).
 */
export const MODEL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = typeof MODEL_EFFORTS[number];

/** The levels one model takes, the lightest first, and the one it thinks at when none is named, when that is known. */
export interface ModelEfforts {
  levels: ModelEffort[];
  default: ModelEffort | null;
}

/** Each level as a person reads it. */
export const EFFORT_LABELS: Readonly<Record<ModelEffort, string>> = {
  none: '考えない',
  minimal: '最小限',
  low: '低い',
  medium: 'ふつう',
  high: '高い',
  xhigh: 'とても高い',
  max: '最大',
};

/** Whether a form's or a body's value names a level of effort. */
export const isModelEffort = (value: unknown): value is ModelEffort =>
  typeof value === 'string' && (MODEL_EFFORTS as readonly string[]).includes(value);

/** Why a model name typed to be added cannot be, or null when it can. */
export const modelNameProblem = (model: string, models: readonly string[]): string | null => {
  if (!model) return 'model 名を入力してください。';
  if (/\s/u.test(model)) return 'model 名に空白は使えません。';
  if (model.length > 200) return 'model 名が長すぎます。';
  if (models.includes(model)) return 'この model はもう登録されています。';
  if (models.length >= AI_MODEL_LIMIT) return `model は ${AI_MODEL_LIMIT} 個まで登録できます。`;
  return null;
};
