/**
 * OrangeAgent: how a row names a call of OrangeAgent's own browser and code tools,
 * as t3code names its preview browser — by what it is doing now, done, failed,
 * declined, or stopped — with the browser's or the code's icon. `code.run`
 * names where the code ran: a Dynamic Worker or a Cloudflare Container.
 */

/** A row's status, as `resolveWorkEntryToolPresentation` hands it on. */
export type OrangeAgentToolStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped";

/** Where a call ran code. */
export type CodePlace = "Dynamic Worker" | "Cloudflare Container" | "Anthropic のサンドボックス";

export interface OrangeAgentToolPresentation {
  readonly displayName: string;
  readonly icon: "browser" | "code";
  readonly action: "browser" | "code";
}

/** What the Worker writes as the answer of a call the member declined (`apps/worker/src/timeline.ts`). */
const DECLINED = "拒否したので実行しませんでした。";

interface Phrase {
  /** The act, as in 「〜操作は拒否されました」. */
  readonly act: string;
  readonly running: string;
  readonly done: string;
  readonly failed: string;
}

const BROWSER: Readonly<Record<string, Phrase>> = {
  "browser.open": {
    act: "ブラウザでページを開く",
    running: "ブラウザでページを開いています",
    done: "ブラウザでページを開きました",
    failed: "ブラウザでページを開けませんでした",
  },
  "browser.read": {
    act: "ブラウザの画面を読む",
    running: "ブラウザの画面を読んでいます",
    done: "ブラウザの画面を読みました",
    failed: "ブラウザの画面を読めませんでした",
  },
  "browser.click": {
    act: "ブラウザでクリックする",
    running: "ブラウザでクリックしています",
    done: "ブラウザでクリックしました",
    failed: "ブラウザでクリックできませんでした",
  },
  "browser.type": {
    act: "ブラウザで入力する",
    running: "ブラウザで入力しています",
    done: "ブラウザで入力しました",
    failed: "ブラウザで入力できませんでした",
  },
  "browser.select": {
    act: "ブラウザで選ぶ",
    running: "ブラウザで選んでいます",
    done: "ブラウザで選びました",
    failed: "ブラウザで選べませんでした",
  },
  "browser.press": {
    act: "ブラウザでキーを押す",
    running: "ブラウザでキーを押しています",
    done: "ブラウザでキーを押しました",
    failed: "ブラウザでキーを押せませんでした",
  },
};

/** A place as a sentence begins with it: a Latin name is set off from the Japanese after it. */
const spaced = (place: CodePlace): string => (/[A-Za-z]$/.test(place) ? `${place} ` : place);

const codePhrase = (place: CodePlace): Phrase => ({
  act: `${spaced(place)}でコードを実行する`,
  running: `${spaced(place)}でコードを実行しています`,
  done: `${spaced(place)}でコードを実行しました`,
  failed: `${spaced(place)}でコードを実行できませんでした`,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The answer as an object: the object itself, or the text it was kept as when it is JSON. */
function answerOf(output: unknown): Record<string, unknown> | null {
  const record = asRecord(output);
  if (record) return record;
  if (typeof output !== "string") return null;
  try {
    return asRecord(JSON.parse(output));
  } catch {
    return null;
  }
}

/**
 * Where `code.run` ran: once it answered, the environment its answer names
 * (a tier's label, `apps/worker/src/environment.ts`), read from the text when
 * the answer was cut too long to parse; before that, where its language goes —
 * JavaScript to a Dynamic Worker, Python and the shell to a container.
 */
export function codePlace(input: unknown, output: unknown): CodePlace {
  const environment = answerOf(output)?.environment;
  const text =
    typeof environment === "string"
      ? environment
      : typeof output === "string"
        ? /"environment"\s*:\s*"([^"]*)"/.exec(output)?.[1]
        : undefined;
  if (text !== undefined) {
    if (/Dynamic Worker/i.test(text)) return "Dynamic Worker";
    if (/コンテナ|container/i.test(text)) return "Cloudflare Container";
  }
  return asRecord(input)?.language === "javascript" ? "Dynamic Worker" : "Cloudflare Container";
}

/** Whether code that ran ended in failure: an exit code other than 0. */
function codeFailed(output: unknown): boolean {
  const exitCode = answerOf(output)?.exitCode;
  return typeof exitCode === "number" && exitCode !== 0;
}

function statusOf(status: string | undefined, output: unknown): OrangeAgentToolStatus {
  if (status === "stopped" && output === DECLINED) return "declined";
  if (
    status === "completed" ||
    status === "failed" ||
    status === "declined" ||
    status === "stopped"
  ) {
    return status;
  }
  return "inProgress";
}

function sentence(phrase: Phrase, status: OrangeAgentToolStatus): string {
  switch (status) {
    case "inProgress":
      return phrase.running;
    case "completed":
      return phrase.done;
    case "failed":
      return phrase.failed;
    case "declined":
      return `${phrase.act}操作は拒否されました`;
    case "stopped":
      return `${phrase.act}操作を中止しました`;
  }
}

/** Where a call of a code tool ran, or null when the tool runs no code. */
export function toolCodePlace(name: string | undefined, input: unknown, output: unknown) {
  if (name === "code.run") return codePlace(input, output);
  if (name === "code_execution") return "Anthropic のサンドボックス";
  return null;
}

/** How a row shows a call of OrangeAgent's browser or code tools; null for every other tool. */
export function orangeAgentToolPresentation(
  name: string | undefined,
  status: string | undefined,
  input: unknown,
  output: unknown,
): OrangeAgentToolPresentation | null {
  if (name === undefined) return null;
  const browser = BROWSER[name];
  if (browser) {
    return {
      displayName: sentence(browser, statusOf(status, output)),
      icon: "browser",
      action: "browser",
    };
  }
  const place = toolCodePlace(name, input, output);
  if (place === null) return null;
  const settled = statusOf(status, output);
  return {
    displayName: sentence(
      codePhrase(place),
      settled === "completed" && codeFailed(output) ? "failed" : settled,
    ),
    icon: "code",
    action: "code",
  };
}

/**
 * How each verb a tool's label ends with is said while the call runs, once it
 * is done, and when it failed, as the browser's phrases say theirs. A label is
 * written as what the tool does (domain `TOOL_LABELS`, 「メールを検索する」);
 * a row says what the call is doing or did (「メールを検索しました」).
 * The longest ending that fits is used, so 「する」 comes last.
 */
const VERBS: ReadonlyArray<readonly [ending: string, running: string, done: string, failed: string]> = [
  ["調べる", "調べています", "調べました", "調べられませんでした"],
  ["換える", "換えています", "換えました", "換えられませんでした"],
  ["変える", "変えています", "変えました", "変えられませんでした"],
  ["入れる", "入れています", "入れました", "入れられませんでした"],
  ["任せる", "任せています", "任せました", "任せられませんでした"],
  ["知らせる", "知らせています", "知らせました", "知らせられませんでした"],
  ["使わせる", "使わせています", "使わせました", "使わせられませんでした"],
  ["送る", "送っています", "送りました", "送れませんでした"],
  ["作る", "作っています", "作りました", "作れませんでした"],
  ["読む", "読んでいます", "読みました", "読めませんでした"],
  ["探す", "探しています", "探しました", "探せませんでした"],
  ["移す", "移しています", "移しました", "移せませんでした"],
  ["渡す", "渡しています", "渡しました", "渡せませんでした"],
  ["開く", "開いています", "開きました", "開けませんでした"],
  ["押す", "押しています", "押しました", "押せませんでした"],
  ["選ぶ", "選んでいます", "選びました", "選べませんでした"],
  ["する", "しています", "しました", "できませんでした"],
];

/** A label's phrases, or null when it ends with no verb this table knows, as an MCP Server's tool does. */
export function labelPhrase(label: string): Phrase | null {
  const verb = VERBS.find(([ending]) => label.endsWith(ending));
  if (!verb) return null;
  const [ending, running, done, failed] = verb;
  const stem = label.slice(0, label.length - ending.length);
  return { act: label, running: stem + running, done: stem + done, failed: stem + failed };
}

/**
 * What a row says of a call of one of the product's other tools: its label as
 * what the call is doing, did, or failed to do; null for a tool whose label
 * ends with no verb.
 */
export function orangeAgentToolSentence(
  label: string | null | undefined,
  status: string | undefined,
  output: unknown,
): string | null {
  const phrase = label ? labelPhrase(label) : null;
  return phrase ? sentence(phrase, statusOf(status, output)) : null;
}

/**
 * The one line a run of consecutive code calls folds into: how many times
 * each place was used, in the order they were first used.
 */
export function codeGroupLabel(places: ReadonlyArray<CodePlace>): string {
  const counts = new Map<CodePlace, number>();
  for (const place of places) counts.set(place, (counts.get(place) ?? 0) + 1);
  const parts = [...counts].map(([place, count]) => `${spaced(place)}を ${count} 回`);
  return `${parts.join("、")}使用しました`;
}
