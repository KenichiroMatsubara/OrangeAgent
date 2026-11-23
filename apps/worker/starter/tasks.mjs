/**
 * FlareChat のタスクを、決まった手順で探し・登録し・完了にするプログラム。
 *
 * タスクは Google ToDo のリスト「FlareChat」にあります。Google ToDo には題名・メモ・期限・
 * 完了したかどうかしかないので、担当者・予定・元メール・鍵・備考・取りやめはメモ欄に
 * 1 行ずつ書きます。その書き方と読み方、担当者の照合、同じタスクを二度作らないことは、
 * AI ではなくこのプログラムが受け持ちます。
 *
 * FlareChat のツールを呼ぶものを 1 つ渡して使います。call(name, args) を持つもの
 * （code.run に tools: true を渡したときの tools）か、(name, args) を受け取る関数です。
 * 答えはツールの答え（値か JSON の文字列）です。
 *
 *     import { Tasks } from './skills/task-management/scripts/tasks.mjs';
 *     const t = new Tasks(tools);
 *
 * 外と通信できる実行環境では、run.token が答えた url と token で FlareChat の MCP Server を
 * 呼びます。メンバーの CLI からは Operator Token でも同じように使えます:
 *
 *     const t = new Tasks(mcpCall(url, token));
 *
 * 標準の JavaScript（ES モジュール、fetch、Web Crypto、Intl）だけで動き、Node の API は使いません。
 */

/** 新しいタスクが入るリスト。ほかのリストは人が自分で書いた ToDo で、頼まれないかぎり変えません。 */
export const LIST_NAME = 'FlareChat';

/** メモ欄の行の見出しと、書く順番。「備考」だけは何行でも書けます。 */
export const FIELDS = ['担当', '予定', '元メール', '鍵', '備考', '完了日', '取りやめ'];

/** 知らせる日: 期限の 7 日前、3 日前、当日、期限を過ぎた次の日。 */
export const REMIND_DAYS = [7, 3, 0, -1];

const TIME_ZONE = 'Asia/Tokyo';
const WEEKDAYS = '日月火水木金土';
const DAY_MS = 86_400_000;
const FIELD_LINE = new RegExp(`^\\s*(${FIELDS.join('|')})\\s*[:：]\\s*(.*?)\\s*$`, 'u');
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** FlareChat のツールが断ったとき。message はツールが述べた理由です。 */
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

// ── 文字の揃え方 ─────────────────────────────────────────────

/** 比べるための形: 全角・半角を揃え（NFKC）、空白をすべて除き、英字を小文字にします。 */
export const normalize = (text) => String(text ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase();

const hex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** 同じ仕事を見分ける鍵: 元メールの ID と、揃えた題名から作る 12 文字。メールがなければ題名だけから作ります。 */
export const makeKey = async (mailId, title) => {
  const seed = `${String(mailId ?? '').trim()}\n${normalize(title)}`;
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))).slice(0, 12);
};

/** 期限は YYYY-MM-DD の日付か null。それ以外は読み替えずに断ります。 */
export const checkDay = (value, name = 'due') => {
  if (value === null || value === undefined || value === '') return null;
  const found = typeof value === 'string' ? DAY.exec(value) : null;
  if (!found) throw new Error(`${name} は YYYY-MM-DD の日付か null です: ${JSON.stringify(value)}`);
  const [year, month, day] = [Number(found[1]), Number(found[2]), Number(found[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${name} は実在する日付ではありません: ${JSON.stringify(value)}`);
  }
  return value;
};

/** 日本時間の今日（YYYY-MM-DD）。at を渡せばその時刻の日本時間の日付です。 */
export const tokyoDay = (at = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(at).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const utcOf = (day) => {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date);
};

/** 期限まであと何日か。過ぎていれば負の数です。 */
export const daysBetween = (from, to) => Math.round((utcOf(to) - utcOf(from)) / DAY_MS);

// ── メモ欄 ───────────────────────────────────────────────

/**
 * メモ欄を、仕事の内容（body）と見出しの行に分けます。
 *
 * 見出しの行は書かれた場所を問わず読みます。それ以外の行は、人が書き足したものも含めて
 * すべて body に残るので、書き直しても消えません。
 */
export const parseNotes = (notes) => {
  const body = [];
  const fields = { 備考: [] };
  for (const line of String(notes ?? '').split(/\r\n|\r|\n/u)) {
    const found = FIELD_LINE.exec(line);
    if (!found) {
      body.push(line.trimEnd());
      continue;
    }
    const [, name, value] = found;
    if (name === '備考') {
      if (value) fields.備考.push(value);
    } else {
      fields[name] = value;
    }
  }
  return { body: body.join('\n').trim(), fields };
};

/** 仕事の内容のあとに 1 行空け、見出しの行を決まった順に書きます。空の見出しは書きません。 */
export const renderNotes = (body, fields) => {
  const lines = [];
  for (const name of FIELDS) {
    const value = fields[name];
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) if (typeof item === 'string' && item.trim()) lines.push(`${name}: ${item.trim()}`);
  }
  return [String(body ?? '').trim(), lines.join('\n')].filter((part) => part).join('\n\n');
};

/** tasks.search が返した 1 件を、このプログラムの形にします。 */
export const taskOf = (view, lists) => {
  const { body, fields } = parseNotes(view.notes);
  const cancelled = view.status === 'completed' && Boolean(fields.取りやめ);
  const listId = view.listId ?? '';
  return {
    id: view.id ?? '',
    listId,
    list: lists[listId] ?? '',
    title: view.title ?? '',
    due: view.due ?? null,
    status: cancelled ? 'cancelled' : view.status ?? 'open',
    body,
    assignee: fields.担当 ?? '',
    event: fields.予定 ?? '',
    mail: fields.元メール ?? '',
    key: fields.鍵 ?? '',
    remarks: [...fields.備考],
    completedOn: fields.完了日 ?? '',
    completedAt: view.completedAt ?? null,
    cancelReason: fields.取りやめ ?? '',
    url: view.url ?? null,
  };
};

/** このプログラムの形の 1 件から、メモ欄の全文を作ります。 */
export const notesOf = (task) => renderNotes(task.body, {
  担当: task.assignee, 予定: task.event, 元メール: task.mail, 鍵: task.key,
  備考: task.remarks ?? [], 完了日: task.completedOn, 取りやめ: task.cancelReason,
});

// ── ツールの呼び出し ─────────────────────────────────────────

const refusal = (value) => String(value?.message || value?.text || 'ツールが断りました。');

/** MCP の tools/call が返す形（content の text を並べたもの）か。 */
const isCallResult = (raw) => Array.isArray(raw?.content) && raw.content.every((item) => typeof item?.type === 'string');

/** ツールの答えを値にします。断られたときは ToolError にします。 */
export const answerOf = (raw) => {
  let value = raw;
  if (isCallResult(value)) {
    const text = value.content.map((item) => item.text ?? '').join('');
    if (value.isError) throw new ToolError(text || 'ツールが断りました。');
    value = text;
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new ToolError(value);
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && value.isError) throw new ToolError(refusal(value));
  return value;
};

/**
 * FlareChat の MCP Server の tools/call を呼ぶ関数を返します。
 *
 * url と token は run.token の答え（または MCP Server の URL と Operator Token）です。
 * トークンは Authorization ヘッダーにだけ載せ、ほかのどこにも書きません。断られたときは ToolError です。
 */
export const mcpCall = (url, token, { timeoutMs = 300_000 } = {}) => {
  let id = 0;
  return async (name, args) => {
    id += 1;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const reply = await response.json().catch(() => null);
    if (!response.ok) throw new ToolError(reply?.error?.message || `FlareChat が ${response.status} で断りました。`);
    if (reply?.error) throw new ToolError(String(reply.error.message || 'FlareChat が断りました。'));
    const result = reply?.result ?? {};
    const text = (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('');
    if (result.isError) throw new ToolError(text || 'ツールが断りました。');
    return text;
  };
};

/** 書き込みの答え: 行った（created / updated）か、自動化が計画した（planned）か、抑止された（suppressed）か。 */
const writtenOf = (answer) => {
  if (answer && typeof answer === 'object') {
    if (answer.status === 'planned') return ['planned', null];
    if (answer.suppressed) return ['suppressed', null];
    if (answer.task && typeof answer.task === 'object') return [answer.created ? 'created' : 'updated', answer.task];
  }
  return ['done', null];
};

const callerOf = (tools) => {
  if (typeof tools === 'function') return tools;
  if (tools && typeof tools.call === 'function') return (name, args) => tools.call(name, args);
  throw new TypeError('Tasks には、ツールを呼ぶ関数か、call(name, args) を持つもの（code.run の tools）を渡します。');
};

const has = (object, name) => Object.prototype.hasOwnProperty.call(object, name);

/** FlareChat のタスクを読み書きする窓口。1 回の実行で 1 つ作って使い回します。 */
export class Tasks {
  #call;
  #contacts = null;
  /** この実行で書いた鍵。自動化では書き込みが後で適用されるので、検索にまだ出てきません。 */
  #keys = new Map();

  constructor(tools) {
    this.#call = callerOf(tools);
  }

  async #tool(name, args) {
    return answerOf(await this.#call(name, args));
  }

  // ── 連絡先 ──

  /** この Account の連絡先（query_contacts）。1 回だけ読みます。 */
  async contacts() {
    if (this.#contacts === null) {
      const answer = await this.#tool('query_contacts', {});
      this.#contacts = Array.isArray(answer) ? answer : [];
    }
    return this.#contacts;
  }

  /**
   * 名前から連絡先を 1 人に決めます。
   *
   * 全角・半角と空白の違いは同じと見なします。見つからないとき、同じ名前が複数いるときは
   * 決めずに Error にします。
   */
  async contact(name) {
    const wanted = normalize(name);
    if (!wanted) throw new Error('担当者の名前がありません。');
    const found = (await this.contacts()).filter((entry) => normalize(entry.name) === wanted);
    const active = found.filter((entry) => (entry.state ?? 'active') === 'active');
    const chosen = active.length ? active : found;
    if (!chosen.length) throw new Error(`担当者「${name}」は連絡先にいません。`);
    if (chosen.length > 1) throw new Error(`担当者「${name}」と同じ名前の連絡先が ${chosen.length} 人います。`);
    return chosen[0];
  }

  // ── 探す ──

  /**
   * タスクを探します。何も指定しなければ、リスト「FlareChat」の未完了すべてと、この 60 日に完了・変更されたもの。
   *
   * status: 'open' / 'completed'（終えた仕事）/ 'cancelled'（取りやめ）。
   * assignee: 担当者の名前と一致するもの。'' なら担当者のいないもの。
   * key: 鍵が一致するもの。event: 「予定:」の行がこの語句を含むもの。
   * text: 題名かメモに語句を含むもの。dueFrom / dueTo: 期限の範囲（YYYY-MM-DD）。
   * allLists: true なら、人が自分で書いたほかのリストも含めます。
   */
  async search({ status, assignee, key, event, text, dueFrom, dueTo, allLists = false } = {}) {
    if (status !== undefined && status !== null && !['open', 'completed', 'cancelled'].includes(status)) {
      throw new Error("status は 'open'、'completed'、'cancelled' のどれかです。");
    }
    const args = {};
    if (status) args.status = status === 'open' ? 'open' : 'completed';
    const phrase = key || text;
    if (phrase) args.text = phrase;
    if (dueFrom) args.from = checkDay(dueFrom, 'dueFrom');
    if (dueTo) args.to = checkDay(dueTo, 'dueTo');
    const answer = await this.#tool('tasks.search', args);
    const lists = Object.fromEntries((answer.lists ?? []).map((entry) => [entry.id ?? '', entry.name ?? '']));
    let tasks = (answer.tasks ?? []).map((view) => taskOf(view, lists));
    if (!allLists) tasks = tasks.filter((task) => task.list === LIST_NAME);
    if (status) tasks = tasks.filter((task) => task.status === status);
    if (key) tasks = tasks.filter((task) => task.key === key);
    if (text && key) tasks = tasks.filter((task) => `${task.title}\n${notesOf(task)}`.toLowerCase().includes(text.toLowerCase()));
    if (assignee !== undefined && assignee !== null) {
      const wanted = normalize(assignee);
      tasks = tasks.filter((task) => normalize(task.assignee) === wanted);
    }
    if (event) tasks = tasks.filter((task) => normalize(task.event).includes(normalize(event)));
    return tasks;
  }

  // ── 登録する ──

  /**
   * 仕事を登録します。同じ鍵のタスクがあれば作らずに変え、なければ作ります。
   *
   * 1 件は次のオブジェクトです。title だけが必須です。
   *   title: 題名
   *   due: 期限 YYYY-MM-DD か null（書かなければ、既にあるタスクの期限を変えません）
   *   body: 仕事の内容（時刻・場所・金額・提出先など）
   *   assignee: 担当者の名前（連絡先の名前と照合します）
   *   event: 関係する予定「題名（月/日）」
   *   mail: 元メールの件名
   *   mailId: 元メールの ID（鍵を作るのに使います）
   *   key: 鍵を自分で決めるとき。なければ mailId と題名から作ります
   *   remark: 備考に足す 1 行
   *
   * 1 件ごとに result を返します:
   *   created / planned（自動化が作ると計画した）: 新しく作った
   *   updated / unchanged: 同じ鍵の未完了タスクを変えた・変える所がなかった
   *   closed: 同じ鍵のタスクが完了・取りやめ済みなので、何も変えなかった
   *   duplicate: この実行ですでに同じ鍵を登録した
   *   refused: 書かなかった（reason に理由。担当者が決まらない、期限が読めない など）
   */
  async upsert(items) {
    const results = [];
    for (const item of items) {
      try {
        results.push(await this.#upsert(item));
      } catch (error) {
        results.push({ result: 'refused', title: item?.title ?? '', reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  async #upsert(item) {
    const title = String(item.title ?? '').trim();
    if (!title) throw new Error('title がありません。');
    const due = has(item, 'due') ? checkDay(item.due) : null;
    const assignee = String(item.assignee ?? '').trim() ? (await this.contact(item.assignee)).name : '';
    const key = String(item.key ?? '').trim() || await makeKey(item.mailId, title);
    if (this.#keys.has(key)) return { result: 'duplicate', title, key };
    const found = await this.search({ key, allLists: true });
    if (!found.length) {
      const task = {
        title, due, body: item.body || '', assignee,
        event: item.event || '', mail: item.mail || '', key,
        remarks: item.remark ? [item.remark] : [],
      };
      const [result, view] = writtenOf(await this.#tool('tasks.create', { title, notes: notesOf(task), due }));
      this.#keys.set(key, task);
      return {
        result: result === 'planned' || result === 'suppressed' ? result : 'created',
        title, key, task: view ? taskOf(view, {}) : task,
      };
    }
    const current = found[0];
    this.#keys.set(key, current);
    if (current.status !== 'open') return { result: 'closed', title, key, task: current };
    const changes = {};
    // 書き方が違うだけの題名では、人が直した題名を書き戻しません。
    if (normalize(title) !== normalize(current.title)) changes.title = title;
    if (has(item, 'due')) changes.due = due;
    for (const name of ['body', 'event', 'mail']) if (item[name]) changes[name] = item[name];
    if (assignee) changes.assignee = assignee;
    if (item.remark) changes.remark = item.remark;
    const outcome = await this.update(current, changes);
    return { ...outcome, title, key };
  }

  // ── 変える・完了・取りやめ ──

  /**
   * search が返したタスクを変えます。渡した項目だけが変わり、ほかの行と人が書き足した内容は残ります。
   *
   * changes: title, due, body, assignee（連絡先と照合）, event, mail, remark（備考に 1 行足す）。
   */
  async update(task, changes = {}) {
    if (task.status !== 'open') return { result: 'closed', task };
    const changed = { ...task, remarks: [...(task.remarks ?? [])] };
    for (const name of ['title', 'body', 'event', 'mail']) {
      if (has(changes, name) && changes[name] !== null && changes[name] !== undefined) changed[name] = String(changes[name]).trim();
    }
    if (has(changes, 'due')) changed.due = checkDay(changes.due);
    if (has(changes, 'assignee')) changed.assignee = changes.assignee ? (await this.contact(changes.assignee)).name : '';
    const remark = String(changes.remark ?? '').trim();
    if (remark && !changed.remarks.includes(remark)) changed.remarks.push(remark);
    return this.#write(task, changed);
  }

  /** 終えた仕事として完了にします。経緯は remark として備考に足します。 */
  async complete(task, remark) {
    if (task.status !== 'open') return { result: 'closed', task };
    const changed = { ...task, remarks: [...(task.remarks ?? [])], status: 'completed' };
    const note = String(remark ?? '').trim();
    if (note && !changed.remarks.includes(note)) changed.remarks.push(note);
    return this.#write(task, changed);
  }

  /** 要らなくなった仕事として取りやめにします。Google ToDo では「取りやめ: 理由」の行がある完了済みです。 */
  async cancel(task, reason) {
    if (!String(reason ?? '').trim()) throw new Error('取りやめの理由がありません。');
    if (task.status !== 'open') return { result: 'closed', task };
    const changed = { ...task, remarks: [...(task.remarks ?? [])], status: 'cancelled', cancelReason: String(reason).trim() };
    return this.#write(task, changed);
  }

  async #write(before, after) {
    const args = { listId: before.listId, taskId: before.id };
    if (after.title !== before.title) args.title = after.title;
    if ((after.due ?? null) !== (before.due ?? null)) args.due = after.due ?? null;
    const notes = notesOf(after);
    if (notes !== notesOf(before)) args.notes = notes;
    if (after.status === 'completed' || after.status === 'cancelled') args.status = 'completed';
    if (Object.keys(args).length === 2) return { result: 'unchanged', task: before };
    const [result, view] = writtenOf(await this.#tool('tasks.update', args));
    // 自動化では計画しただけなので、同じ実行の中ではこの形を正とします。
    Object.assign(before, after);
    return {
      result: result === 'planned' || result === 'suppressed' ? result : 'updated',
      task: view ? taskOf(view, { [before.listId]: before.list ?? '' }) : before,
    };
  }

  // ── 知らせる ──

  /**
   * 期限が近い・過ぎた未完了タスクを、担当者ごとの 1 通にまとめます（送るのは呼んだ側）。
   *
   * today: 今日（YYYY-MM-DD、日本時間）。なければ今の日本時間の日付。
   * days: 期限まであと何日のときに知らせるか。-1 は期限を過ぎた次の日。
   * reportTo: 書けば、お知らせの最後に「終わったら ○○ に知らせてください。」と添えます。
   *
   * 返す値: { today, messages: [{ contact, text, tasks }], skipped: [{ title, reason }] }
   * contact は query_contacts の 1 人（id, name, email, channels）。channels に line か discord があれば
   * channel.send、なければ email に mail.send で送ります。
   */
  async reminders({ today, days = REMIND_DAYS, reportTo } = {}) {
    const day = checkDay(today) ?? tokyoDay();
    const due = new Map();
    const skipped = [];
    for (const task of await this.search({ status: 'open' })) {
      if (!task.due) continue;
      const left = daysBetween(day, task.due);
      if (!days.includes(left)) continue;
      if (!task.assignee) {
        skipped.push({ title: task.title, reason: '担当者が書かれていません。' });
        continue;
      }
      let contact;
      try {
        contact = await this.contact(task.assignee);
      } catch (error) {
        skipped.push({ title: task.title, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!due.has(contact.id)) due.set(contact.id, { contact, tasks: [] });
      due.get(contact.id).tasks.push({ ...task, daysLeft: left });
    }
    const messages = [];
    for (const entry of due.values()) {
      entry.tasks.sort((left, right) => (left.due < right.due ? -1 : left.due > right.due ? 1 : left.title < right.title ? -1 : left.title > right.title ? 1 : 0));
      messages.push({ ...entry, text: reminderText(entry.tasks, reportTo) });
    }
    return { today: day, messages, skipped };
  }
}

/** '2026-12-05' を「12/5(土)」に。 */
export const dayLabel = (value) => {
  const date = new Date(utcOf(value));
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}(${WEEKDAYS[date.getUTCDay()]})`;
};

const monthDay = (value) => {
  const [, month, day] = value.split('-').map(Number);
  return `${month}/${day}`;
};

export const leftLabel = (left) => {
  if (left > 0) return `あと ${left} 日`;
  return left === 0 ? '今日まで' : '期限を過ぎています';
};

const firstLine = (body) => String(body ?? '').split(/\r\n|\r|\n/u).map((line) => line.trim()).find((line) => line) ?? '';

/** 担当者 1 人に送るお知らせの本文。メモの見出しの行やツールの名前は載せません。 */
export const reminderText = (tasks, reportTo) => {
  const lines = ['【タスクのお知らせ】'];
  for (const task of tasks) {
    lines.push(`・${dayLabel(task.due)} ${task.title}（${leftLabel(task.daysLeft)}）`);
    const first = firstLine(task.body);
    if (first) lines.push(`  ${first}`);
  }
  if (reportTo && String(reportTo).trim()) lines.push(`終わったら ${String(reportTo).trim()} に知らせてください。`);
  return lines.join('\n');
};

/** 終えた日: 「完了日:」の行があればそれ、なければ Google ToDo が完了にした時刻の日本時間の日付。 */
const completedDay = (task) => {
  if (DAY.test(task.completedOn ?? '')) return task.completedOn;
  const at = Date.parse(task.completedAt ?? '');
  return Number.isNaN(at) ? '' : tokyoDay(new Date(at));
};

/** 1 件の今の状態: 未完了なら期限まであと何日か、完了なら終えた日、取りやめならその理由。 */
const stateLabel = (task, today) => {
  if (task.status === 'cancelled') return task.cancelReason ? `取りやめ: ${task.cancelReason}` : '取りやめ';
  if (task.status === 'completed') {
    const day = completedDay(task);
    return day ? `完了: ${monthDay(day)}` : '完了';
  }
  return task.due ? leftLabel(daysBetween(today, task.due)) : '';
};

/**
 * search が返した実際のタスクから、通知の文を作ります。見本や過去の行事として、
 * 頼まれたタスクを知らせるときに使います。題名・内容・期限・状態は、渡したタスクのものだけを使い、
 * 完了済みなら「期限を過ぎています」ではなく「完了: M/D」、取りやめなら「取りやめ: 理由」と書きます。
 *
 * task: search が返した 1 件か、その配列。search が返していない、自分で作ったものは断ります。
 * today: 今日（YYYY-MM-DD、日本時間）。なければ今の日本時間の日付。
 * reportTo: 書けば、未完了のタスクがあるとき、最後に「終わったら ○○ に知らせてください。」と添えます。
 */
export const noticeOf = (task, { today, reportTo } = {}) => {
  const tasks = Array.isArray(task) ? task : [task];
  if (!tasks.length) throw new Error('noticeOf には、t.search が返したタスクを 1 件以上渡します。');
  for (const entry of tasks) {
    if (!entry || typeof entry !== 'object' || !entry.id || !entry.listId || !['open', 'completed', 'cancelled'].includes(entry.status)) {
      throw new Error('noticeOf には、t.search が返したタスクをそのまま渡します。題名や内容を自分で書いたものは使えません。');
    }
  }
  const day = checkDay(today) ?? tokyoDay();
  const lines = ['【タスクのお知らせ】'];
  for (const entry of tasks) {
    const state = stateLabel(entry, day);
    lines.push(`・${entry.due ? `${dayLabel(entry.due)} ` : ''}${entry.title}${state ? `（${state}）` : ''}`);
    const first = firstLine(entry.body);
    if (first) lines.push(`  ${first}`);
  }
  if (reportTo && String(reportTo).trim() && tasks.some((entry) => entry.status === 'open')) {
    lines.push(`終わったら ${String(reportTo).trim()} に知らせてください。`);
  }
  return lines.join('\n');
};
