/**
 * The Decider of Operator Chat (ADR 0201): in a conversation in
 * auto, it judges each call that would wait for the person (`waits` in
 * approval.ts), and lets it through or asks the person. It fails closed: with no Decider, or when its judgement fails
 * or says nothing it can be held to, the person is asked.
 *
 * Only the port and the Decider that always asks live here; one that asks a
 * model (Perplexity's, through OpenRouter) implements the same port. Auto is
 * offered only where the Worker holds `OPENROUTER_API_KEY` (modes.ts).
 */

/** One call the Decider judges, and the member's message it answers. */
export interface Judgement {
  tool: string;
  /** What the tool does, in the words the screen names it by. */
  label: string;
  arguments: Readonly<Record<string, unknown>>;
  request: string;
}

/** Let the call through, or ask the person, saying why in words the screen shows. */
export type Verdict = { allow: true } | { allow: false; reason: string };

export interface Decider {
  judge(judgement: Judgement): Promise<Verdict>;
}

export const UNDECIDED = '自動で判定する設定がないため、確認します。';
export const UNJUDGED = '自動で判定できなかったため、確認します。';

/** The Decider of an Account that has none: it asks about every call. */
export const NO_DECIDER: Decider = {
  judge: async () => ({ allow: false, reason: UNDECIDED }),
};

/** Judges one call, asking the person whenever the Decider fails or answers anything but a plain verdict. */
export const judge = async (decider: Decider, judgement: Judgement): Promise<Verdict> => {
  try {
    const verdict: unknown = await decider.judge(judgement);
    if (typeof verdict !== 'object' || verdict === null) return { allow: false, reason: UNJUDGED };
    const { allow, reason } = verdict as { allow?: unknown; reason?: unknown };
    if (allow === true) return { allow: true };
    return { allow: false, reason: typeof reason === 'string' && reason.trim() ? reason.trim() : UNJUDGED };
  } catch {
    return { allow: false, reason: UNJUDGED };
  }
};
