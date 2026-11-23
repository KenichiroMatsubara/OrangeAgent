/**
 * What a member is likely to write next in Operator Chat, as Claude Code
 * suggests a prompt: once an answer completes, a small Workers AI model reads
 * the conversation's last exchanges and predicts the member's next message in
 * their own words, such as 「送れ」 after an answer that asks for a go-ahead.
 * The composer shows it greyed until the member types; nothing is sent until
 * they accept it and send it themselves.
 *
 * The model is told the exchanges as a transcript in one message rather than
 * as turns of its own, so it predicts the member instead of answering them.
 */

import type { TurnMessage } from './turns';

/** The Workers AI model that predicts the next message: Z.ai's GLM-4.7 Flash, asked without reasoning. */
export const SUGGESTION_MODEL = '@cf/zai-org/glm-4.7-flash';

/** The longest suggestion shown, in characters; a longer one is not what a member types as a reply. */
export const SUGGESTION_CHARACTERS = 40;

/** How many of the latest messages the model reads: the last three exchanges. */
const RECENT_MESSAGES = 6;
/** How much of each member's message the model reads, from its start. */
const MESSAGE_CHARACTERS = 600;
/** How much of each answer the model reads, from its end, where a question or a request for a go-ahead sits. */
const ANSWER_CHARACTERS = 2_000;
/**
 * The most the model may write. A suggestion is a few tokens; the rest is room
 * for reasoning, should the model reason although it is asked not to.
 */
const OUTPUT_TOKENS = 512;

/** Predicts the member's next message from the conversation so far, or null when nothing is likely enough. */
export type Suggester = (history: readonly TurnMessage[]) => Promise<string | null>;

const INSTRUCTIONS = [
  'あなたは、ユーザーと AI アシスタントの会話を読んで、ユーザーが次に送るメッセージを予測します。',
  '- ユーザー本人が入力欄に打つ言葉を、そのまま 1 行で書いてください。AI の立場で答えたり、説明したりしないでください。',
  `- ${SUGGESTION_CHARACTERS} 文字以内にしてください。`,
  '- 直前の回答が確認や質問で終わっているなら、それへのユーザーの返事を予測してください。',
  '- 口調と長さは、会話の中のユーザーのメッセージに合わせてください。',
  '- かぎかっこ、引用符、「ユーザー:」のような前置きは付けないでください。',
  '- 次のメッセージがはっきり予測できないときは「なし」とだけ書いてください。',
].join('\n');

const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });

/** The characters of a text as a person counts them, an emoji or a letter with its marks as one. */
const lettersOf = (text: string): string[] => Array.from(graphemes.segment(text), ({ segment }) => segment);

const clipStart = (text: string, characters: number): string => {
  const letters = lettersOf(text.trim());
  return letters.length > characters ? `${letters.slice(0, characters).join('')}…` : letters.join('');
};

const clipEnd = (text: string, characters: number): string => {
  const letters = lettersOf(text.trim());
  return letters.length > characters ? `…${letters.slice(-characters).join('')}` : letters.join('');
};

/** The request the model is sent: the instructions, then the last exchanges as a transcript. */
export const suggestionMessages = (history: readonly TurnMessage[]): Array<{ role: 'system' | 'user'; content: string }> => {
  const lines = history
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim())
    .slice(-RECENT_MESSAGES)
    .map((message) => message.role === 'user'
      ? `ユーザー: ${clipStart(message.content, MESSAGE_CHARACTERS)}`
      : `AI: ${clipEnd(message.content, ANSWER_CHARACTERS)}`);
  return [
    { role: 'system', content: INSTRUCTIONS },
    { role: 'user', content: `<会話>\n${lines.join('\n\n')}\n</会話>\n\nユーザーが次に送るメッセージ:` },
  ];
};

/** What the model answers when it predicts nothing. */
const NOTHING = new Set(['なし', '無し', 'ナシ', 'none', 'n/a', '']);
/** Quotation marks the model may wrap a suggestion in, opening and closing. */
const QUOTES: ReadonlyArray<readonly [string, string]> = [['「', '」'], ['『', '』'], ['"', '"'], ['“', '”'], ["'", "'"], ['`', '`']];
/** Labels the model may put before a suggestion. */
const LABEL = /^(?:ユーザー|user|次のメッセージ|予測)\s*[:：]\s*/iu;

const unquoted = (text: string): string => {
  for (const [open, close] of QUOTES) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) return text.slice(open.length, -close.length).trim();
  }
  return text;
};

/**
 * The suggestion in what the model wrote, or null: its first line without
 * reasoning, labels, or quotation marks, when it is a short line a member
 * would type rather than nothing, markup, or a paragraph.
 */
export const cleanSuggestion = (written: string | null | undefined): string | null => {
  if (!written) return null;
  const withoutReasoning = written.replace(/<think>[\s\S]*?<\/think>/gu, '').replace(/^[\s\S]*<\/think>/u, '');
  const line = withoutReasoning.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? '';
  const text = unquoted(line.replace(LABEL, '').trim());
  const bare = text.replace(/[。．.！!]+$/u, '').trim().toLowerCase();
  if (NOTHING.has(bare) || /^[(（]?\s*なし\s*[)）]?$/u.test(bare)) return null;
  if (lettersOf(text).length > SUGGESTION_CHARACTERS) return null;
  if (/[<>]|^_\(|^\[/u.test(text)) return null;
  return text;
};

/** The words of the model's answer, from the chat completion Workers AI returns or its older `response` field. */
export const answerText = (output: unknown): string | null => {
  if (!output || typeof output !== 'object') return null;
  if ('response' in output && typeof output.response === 'string') return output.response;
  if (!('choices' in output) || !Array.isArray(output.choices)) return null;
  const [choice] = output.choices as unknown[];
  if (!choice || typeof choice !== 'object' || !('message' in choice)) return null;
  const { message } = choice;
  if (!message || typeof message !== 'object' || !('content' in message)) return null;
  return typeof message.content === 'string' ? message.content : null;
};

/** The suggester that asks Workers AI, without reasoning; a failed request suggests nothing. */
export const workersAiSuggester = (ai: Ai): Suggester => async (history) => {
  if (!history.some((message) => message.role === 'assistant')) return null;
  const output = await ai.run(SUGGESTION_MODEL, {
    messages: suggestionMessages(history),
    max_completion_tokens: OUTPUT_TOKENS,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false },
  });
  return cleanSuggestion(answerText(output));
};
