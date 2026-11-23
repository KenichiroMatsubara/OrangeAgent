/**
 * What an Account starts with: two Automations, the Skill each runs, and the
 * Skill both read for how the Account keeps its Tasks in Google Tasks.
 * 毎朝のメール処理 reads the mail that arrived since it last ran, keeps the
 * calendar and the Tasks, and tells whoever its Skill names. タスクのリマインド
 * tells each Task's assignee as its deadline nears, and stays off
 * until the Account turns it on. Whom either tells is written in its Skill,
 * and what a Task's notes carry in タスクの管理, so an Account changes either
 * by rewriting the Skill alone.
 *
 * They are made once. An Account that had the mail Automation and the Morning
 * Automation from before migration 0042 is given these in their place: its
 * mail Skill is rewritten for a run that reads a day of mail at once, and the
 * Morning's Skill, which nothing runs any more, is removed.
 */

import { AUTOMATION_TOOLS, type ToolName } from '@mail/domain';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import TASK_PROGRAM from '../starter/tasks.mjs';
import { automationStatements } from './automations';
import { ensureOfficeSkill } from './office';
import { nextScheduledRun } from './schedule';
import type { AccountDatabase } from './storage/database';
import { automations, automationSkills, runs, settings, skillFiles, skillRevisions, skills } from './storage/account-schema';

/** Marks that the Account has been given its starting Automations as they are now. */
const STARTER_SETTING = 'starter-automations-0042';

export const INTAKE_SKILL_NAME = 'mail-intake';

/** The intake Skill's name as a person reads it. */
export const INTAKE_SKILL_TITLE = 'メールの取り込み';

/** When the intake Skill applies. */
export const INTAKE_SKILL_DESCRIPTION = '届いたメールを読んで、予定とタスクを整え、送信先にまとめを知らせるとき。';

/** What the Account's mail Automation is told to do with the mail that arrived since it last ran. */
export const INTAKE_SKILL = `前回この自動化が動いてから届いたメールを読み、この Account の予定とタスクを整えて、送信先にまとめを知らせてください。

送信先: 要約送信グループ（この名前の連絡先がないときは、誰にも送りません）

1. 依頼に書かれた mail.search の条件（after:…）で、前回から届いたメールを探します。初めて動くときは newer_than:1d で探します。この Account 自身のアドレスから送ったメールと、Google カレンダーの招待・出欠の通知メールは読み飛ばします。残りを 1 通ずつ mail.read で読みます。
2. メールごとに、何かを決めます。行事・会議の案内か、案内済みの予定の変更・中止か、案内済みの予定への返信（出欠の返事、受付の確認、申込書の返送など）か、そのどれでもないお知らせか。引用された過去のメールではなく、この送信者がこのメールで何をしているかで判断します。引用があるだけの返信を案内と見なしません。
3. 案内の場合は、日付と開始時刻が書かれている催しごとに予定を 1 件ずつ作ります（式典と懇親会のように、それぞれに日時があれば別の予定です）。messageId にそのメールを指定します。
   - 締め切り・支払い日・案内の送信日は予定にしません。別の催しの日時を流用しません。月か日が書かれていない催しは作りません。
   - 年が書かれていない日付は、メールの受信日以降で最も早い年にします。本文に書かれた日付を今日と見なしません。
   - query_scheduled_events ですでにある予定は、題名や会場の書き方が違っても作り直さず、変わった点だけを変更します。
   - 終了時刻が書かれていないときは開始の 2 時間後を終了とし、予定の説明に「終了時刻は案内に書かれていません。」と書きます。
   - 予定の説明は、カレンダーでこの予定を開く会員に向けて、来てほしい気持ちが伝わる案内として書きます。会員はアプリで出欠を登録するだけなので、主催者への出欠の返し方（申込書・送り先・締め切り）は書かず、アプリでの出欠登録をお願いします。主催者への返事は幹事のタスクにします。
   - メールの添付ファイルは、関係する予定に添付します。置き場所の Drive フォルダは自分で選びます。このスキルに置き場所が書いてあればそこに、なければ drive.search で内容にふさわしいフォルダを探します。メールごとにまとめるときは、subfolder にメールの受信日と件名を書きます。
4. 変更・中止の場合は、該当する予定を変更し、中止が明記されているときだけ中止します。予定を動かしたり中止したりしたら、その予定のタスクを t.search({ event: '予定の題名' }) で探し、合わせて t.update で期限を動かすか、その予定のためだけのものなら t.cancel で取りやめにします。新しい版の資料が届いたら、古い資料と差し替えます。
5. 返信の場合は予定を作らず、返信している予定に record_event_response で記録します。申込書などで外部の参加者が書かれていれば、その人数を所属ごとに記録します。添付ファイルがあれば、その予定に添付します。
6. タスクは Google ToDo に置き、探すのも書くのもスキル task-management（タスクの管理）の scripts/tasks.mjs で行います（始めに読んでいなければ activate_skill で読み、そこにある手順で code.run から使います）。メモ欄を自分で書いたり読み取ったりしません。タスクにするのは、この Account 自身（またはその連絡先が Account に代わって）がやる仕事だけです。誰が誰に頼んでいるかを先に決めます。
   - この Account が外部の団体や人に頼んだことは相手の仕事で、タスクにしません。この Account が出した案内・招待・申込書にある依頼はすべてそうです（この Account のアドレスから送ったメールでも、返信に引用されたものでも同じです）。この Account やそのアドレスへ送る・返す・提出する・支払う仕事は、相手がします。
   - メールにある仕事を 1 件ずつ、title（題名）、due（書かれた期限 YYYY-MM-DD、なければ null）、body（仕事の内容。時刻・場所・金額・提出先など）、assignee（担当者がはっきりしているときだけ、その連絡先の名前）、event（関係する予定「題名（月/日）」）、mail（メールの件名）、mailId（mail.read の messageId）に書き出し、メールごとに t.upsert にまとめて渡します。同じメールの同じ仕事は tasks.mjs が見分けるので、二度動いても二重になりません。
   - 別のメールで届いた仕事が、すでにあるタスクと同じ仕事かどうかは、t.search の結果を見て自分で判断します。題名や期限の書き方はよく違います。未完了のタスクの仕事なら upsert せず、t.update で変えます（期限や担当者の変更も同じです）。完了・取りやめ済みのタスクの仕事なら何も変えません。改めてはっきり頼まれたときだけ、新しいタスクとして upsert します。
   - 完了にする（t.complete）のは、受領や支払いが確認されたか、担当者が終えたと伝えたときだけです。取りやめにする（t.cancel）のは、依頼がはっきり取り下げられたか、その予定が中止されたときだけです。
   - upsert の結果が refused のもの（担当者が連絡先で 1 人に決まらない、期限が読めない など）は書かれていません。reason を添えて、まとめの【保留】に書きます。
7. この指示で決められない場合や、人の判断が必要な場合は、そのメールについては何もせず、まとめの【保留】に書きます。
8. 最後に、送信先の一人ひとりに、まとめを 1 通だけ送ります。LINE か Discord で届く人には channel.send、メールアドレスしかない人には mail.send を使います。読んだメールが 1 通もなかったときは送りません。まとめは、読む人がスマートフォンで数秒見て、自分が何かすべきかを判断できるように、次の形で書きます。当てはまらない見出しは書きません。
   【予定】作った・変えた予定を 1 件 1 行で「・月/日(曜) 時刻 題名（場所）」。中止した予定は「・中止 月/日 題名」。
   【タスク】立てた・変えたタスク（upsert や update の結果が created、planned、updated のもの）を 1 件 1 行で「・期限 題名（担当）」。
   【保留】人がすべきことを 1 件 1 行（80 字以内）。
   【メール】読んだメールを 1 通 1 行で「・送信者：何のメールか」（60 字以内）。
   日時・場所・金額は、メールから一字も変えずに写します。ツールの名前や「Event Response」のような内部の言葉は書きません。`;

export const REMINDER_SKILL_NAME = 'task-reminder';

/** The reminder Skill's name as a person reads it. */
export const REMINDER_SKILL_TITLE = 'タスクのリマインド';

/** When the reminder Skill applies. */
export const REMINDER_SKILL_DESCRIPTION = '期限が近い・過ぎたタスクを、担当者に知らせるとき。';

/** What the Account's reminder Automation is told to do each morning. */
export const REMINDER_SKILL = `未完了のタスクのうち、今日が次のどれかに当たるものを、その担当者に知らせてください。タスクは Google ToDo にあり、読むのはスキル task-management（タスクの管理）の scripts/tasks.mjs です（始めに読んでいなければ activate_skill で読み、そこにある手順で code.run から使います）。

知らせる日: 期限の 7 日前、3 日前、当日、期限を過ぎた次の日
送り先: 各タスクの担当者（担当者が書かれていないタスクは知らせません）
完了の伝え先: （ここに名前を書くと、お知らせの最後に「終わったら ○○ に知らせてください。」と添えます。書かなければ添えません）

1. await t.reminders({ today: '依頼に書かれた今日の日付（日本時間、YYYY-MM-DD）', days: [7, 3, 0, -1], reportTo: 完了の伝え先の名前か null }) を呼びます。知らせる日を変えるときは days を変えます（-1 は期限を過ぎた次の日）。担当者ごとの 1 通の本文と、その連絡先が返ります。
2. 返った messages の 1 件ごとに、text を一字も変えずに contact に送ります。contact の channels に line か discord があれば channel.send（contactId に contact の id）、なければ contact の email に mail.send を使います。どちらもない人には送りません。
3. skipped にあるタスク（担当者が連絡先で 1 人に決まらないなど）は送らず、その理由を最後の答えに書きます。
4. messages が空のときは、誰にも送りません。

## 見本・過去の行事・タスクを指定して通知を送るとき

見本として、過去の行事のものとして、または名前を挙げて頼まれたタスクを知らせるときも、通知の文は自分で書きません。

1. 1 回の code.run の中で、t.search（status、event、text などで絞ります。完了済みも探すときは status を省きます）でそのタスクを探し、返った 1 件（か、その配列）をそのまま noticeOf(task, { today: '今日の日付（日本時間、YYYY-MM-DD）' }) に渡して通知の文を作り、console.log します。noticeOf は import { Tasks, noticeOf } で読み込みます。
2. 題名・内容・期限・状態を自分でオブジェクトに書いて渡しません。noticeOf は search が返していないものを断ります。完了済みのタスクは「完了: M/D」、取りやめは「取りやめ: 理由」と書かれます。
3. 見つからないとき、どれか 1 件に決められないときは送らず、そのことを答えに書きます。
4. 返った文を一字も変えずに送ります。送り先と送り方は上の 2. と同じです。`;

export const TASK_SKILL_NAME = 'task-management';

/** The Task Skill's name as a person reads it. */
export const TASK_SKILL_TITLE = 'タスクの管理';

/** When the Task Skill applies. */
export const TASK_SKILL_DESCRIPTION = 'タスクを探す・作る・変える・完了にする・取りやめる・担当者に知らせるとき。タスクは Google ToDo に置いていて、読み書きする scripts/tasks.mjs とその決まりがここにあります。';

/** How the Account keeps its Tasks in Google Tasks: what a Task's notes carry, and when one is completed or cancelled. */
export const TASK_SKILL = `この Account のタスクは Google ToDo のリスト「OrangeAgent」に置きます。OrangeAgent の中にタスクの控えはなく、Google ToDo にあるものがすべてです。人が Google ToDo で足したり、直したり、完了にしたりしたものも、そのまま正しいものとして扱います。

タスクを探す・作る・変える・完了にする・取りやめる・担当者に知らせるときは、このスキルに同梱の tasks.mjs を使います。メモ欄の書き方と読み方、担当者と連絡先の照合、同じタスクを二度作らないことは tasks.mjs が決まった手順で行うので、メモ欄を自分で書いたり読み取ったりしません。何が同じ仕事か、いつ完了・取りやめにするかは、下の決まりに従って自分で判断します。

## 読み込み方

tasks.mjs は code.run で、JavaScript として動かします。language に "javascript" を、skills に ["task-management"] を、tools に true を渡すと、このスキルが ./skills/task-management/ に置かれ、tasks.mjs は tools であなたのツールを呼びます（その呼び出しはあなた自身の呼び出しとして扱われます）。tasks.mjs の関数は async なので、1 回の code.run の中で必要な作業をすべて行い、結果を console.log します（code.run は毎回まっさらな環境で始まるので、登録した仕事を覚えておくために、一連の作業は 1 回にまとめます）。

    import { Tasks, noticeOf } from './skills/task-management/scripts/tasks.mjs';

    const t = new Tasks(tools);
    const found = await t.search({ status: 'open' });
    console.log(JSON.stringify(found));

Python ではなく JavaScript で書きます。tools はそのプログラムの中だけで使い、メッセージやファイルには書きません。

## 使い方

- 探す: await t.search({ status, assignee, event, text, dueFrom, dueTo })。どれも省けます。何も指定しなければ、リスト「OrangeAgent」の未完了すべてと、この 60 日に完了・変更されたものです。status は 'open'（未完了）、'completed'（終えた）、'cancelled'（取りやめ）。assignee は担当者の名前、'' なら担当者のいないもの。1 件は id、listId、title、due、status、body（仕事の内容）、assignee、event、mail、key、remarks、completedAt、cancelReason、url のオブジェクトです。
- 登録する: await t.upsert([{ title: …, due: 'YYYY-MM-DD' か null, body: …, assignee: 連絡先の名前, event: '題名（月/日）', mail: 元メールの件名, mailId: 元メールの ID, remark: 備考 }, …])。title のほかは省けます。同じメールの同じ題名のタスクがあれば、作らずにそれを変えます。1 件ごとの result は、created（作った）、planned（自動化が作ると計画した）、updated、unchanged、closed（完了・取りやめ済みなので何もしなかった）、duplicate（この実行で登録済み）、refused（書かなかった。reason に理由）です。
- 変える: await t.update(task, { due, assignee, body, event, remark })。task は search が返した 1 件で、渡した項目だけが変わります。ほかの行と、人が Google ToDo で書き足した内容は残ります。
- 完了: await t.complete(task, '入金を確認')。取りやめ: await t.cancel(task, '例会が中止')。
- 担当者に知らせる: await t.reminders({ today: 'YYYY-MM-DD', days: [7, 3, 0, -1], reportTo: null })。担当者ごとの 1 通の本文（text）と送り先の連絡先（contact）が返ります。送るのは channel.send か mail.send です。
- 1 件や数件のタスクを知らせる文を作る: noticeOf(task, { today: 'YYYY-MM-DD' })。task は search が返した 1 件か、その配列をそのまま渡します。自分で書いたオブジェクトは断られます。完了済みは「完了: M/D」、取りやめは「取りやめ: 理由」、未完了は期限まであと何日かが書かれます。
- 担当者の名前は連絡先と照合されます。見つからない、同じ名前が複数いるときは書かずに refused（または Error）になるので、その理由を報告します。
- ツールが断ったとき（Google の権限が足りない など）は ToolError になります。その理由を報告します。

## 決まり

- タスクにするのは、この Account 自身（またはその連絡先が Account に代わって）がやる仕事だけです。この Account が外部の団体や人に頼んだことは相手の仕事で、タスクにしません。
- 別のメールで届いた仕事がすでにあるタスクと同じかどうかは、t.search の結果を見て自分で判断します。題名や期限の書き方はよく違います。未完了のタスクの仕事なら新しく作らず、t.update で変えます。
- 完了済み・取りやめ済みのタスクの仕事なら何も変えません。改めてはっきり頼まれたときだけ、新しいタスクを作ります。
- 完了にするのは、受領や支払いが確認されたか、担当者が終えたと伝えたときだけです。取りやめにするのは、依頼がはっきり取り下げられたか、その予定が中止されたときだけです。
- 完了済みのタスクを未完了に戻すこと、タスクを消すことはできません。戻すのは人が Google ToDo で行います。もう一度頼まれたと読めるときは、そのことを人に伝えます。
- リスト「OrangeAgent」以外のリストにあるものは、この Google アカウントを使う人が自分で書いた ToDo です。t.search({ allLists: true }) で読んでかまいませんが、頼まれないかぎり変えません。

## コードを実行できないとき

code.run が使えないときは、tasks.search、tasks.create、tasks.update を直接呼び、メモ欄を tasks.mjs と同じ形で書きます。仕事の内容のあとに 1 行空け、「担当: 連絡先の名前のとおり」「予定: 題名（月/日）」「元メール: 件名」「備考: …」を 1 行ずつ、当てはまるものだけ書きます。取りやめは「取りやめ: 理由」の行を足して completed にします。「鍵:」の行は変えずに残します。`;

/** Where タスクの管理 carries its program: a module JavaScript imports in a Dynamic Worker. */
export const TASK_PROGRAM_PATH = 'scripts/tasks.mjs';

/** The program タスクの管理 carries, as its text. */
export { TASK_PROGRAM };

/**
 * The files タスクの管理 carries beside its SKILL.md: the program that reads
 * and writes a Task's notes, finds its assignee among the Contacts, and keeps
 * one Task to one piece of work, so that none of that rests on Claude's reading.
 */
export const TASK_SKILL_FILES: ReadonlyArray<{ path: string; content: string }> = [{ path: TASK_PROGRAM_PATH, content: TASK_PROGRAM }];

/** The tools 毎朝のメール処理 starts with: every tool an Automation can be granted. */
const INTAKE_TOOLS: readonly string[] = AUTOMATION_TOOLS.map(({ name }) => name);

/** The tools タスクのリマインド starts with: reading the Tasks and the Contacts, and telling them. */
const REMINDER_TOOLS: readonly ToolName[] = ['tasks.search', 'query_contacts', 'channel.send', 'mail.send'];

/** The Skill the Morning Automation ran before migration 0042. */
const MORNING_SKILL_NAME = 'morning-notice';

/** The name a starting Automation takes, unless the Account already gave it to one of its own. */
const freeName = async (db: AccountDatabase, name: string, alternative: string): Promise<string> =>
  (await db.select({ id: automations.id }).from(automations).where(eq(automations.name, name)).get()) ? alternative : name;

/** Gives a rewritten revision the text files the one before it carried, written as rows as that one's were. */
const carrySkillFiles = (db: AccountDatabase, input: { skillId: string; from: number; to: number; at: string }) =>
  db.insert(skillFiles).select(db.select({
    skillId: skillFiles.skillId, revision: sql<number>`${input.to}`.as('revision'), path: skillFiles.path, content: skillFiles.content, createdAt: sql<string>`${input.at}`.as('created_at'),
  }).from(skillFiles).where(and(eq(skillFiles.skillId, input.skillId), eq(skillFiles.revision, input.from))));

/**
 * The Skill of this name with these words, written as rows that become its
 * folder the first time it is read: made when the Account has none,
 * and rewritten as a new revision when it has one that `rewrite` says to
 * replace, such as the mail Skill written for one Source Message at a time.
 */
const skillNamed = async (db: AccountDatabase, input: {
  accountId: string;
  name: string;
  /** The name a person reads. */
  title: string;
  description: string;
  instructions: string;
  /** The text files a new Skill starts with beside its SKILL.md. */
  files?: ReadonlyArray<{ path: string; content: string }>;
  at: string;
  rewrite: boolean;
}) => {
  const named = await db.select({ id: skills.id, revision: skills.revision }).from(skills).where(eq(skills.name, input.name)).get();
  if (named && !input.rewrite) return { id: named.id, statements: [] };
  if (named) {
    const revision = named.revision + 1;
    return {
      id: named.id,
      statements: [
        // A rewritten Skill is moved to its directory again from these rows, the next time it is read.
        db.update(skills).set({ description: input.description, instructions: input.instructions, revision, directory: null, updatedAt: input.at }).where(eq(skills.id, named.id)),
        db.insert(skillRevisions).values({ skillId: named.id, revision, instructions: input.instructions, createdAt: input.at }),
        // New words are no reason to lose the files the Account put beside the old ones.
        carrySkillFiles(db, { skillId: named.id, from: named.revision, to: revision, at: input.at }),
      ],
    };
  }
  const id = crypto.randomUUID();
  return {
    id,
    statements: [
      db.insert(skills).values({
        id, accountId: input.accountId, name: input.name, title: input.title, description: input.description, instructions: input.instructions,
        revision: 1, published: false, createdAt: input.at, updatedAt: input.at,
      }),
      db.insert(skillRevisions).values({ skillId: id, revision: 1, instructions: input.instructions, createdAt: input.at }),
      ...(input.files ?? []).map((file) => db.insert(skillFiles).values({ skillId: id, revision: 1, path: file.path, content: file.content, createdAt: input.at })),
    ],
  };
};

/**
 * The Morning's Skill, when nothing runs it any more: the Morning Automation
 * that named it is archived, and no Automation of the Account names it now.
 */
const retiredMorningSkill = async (db: AccountDatabase): Promise<string | null> => {
  const skill = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, MORNING_SKILL_NAME)).get();
  if (!skill) return null;
  const named = await db.select({ id: automationSkills.automationId }).from(automationSkills)
    .innerJoin(automations, eq(automations.id, automationSkills.automationId))
    .where(and(eq(automationSkills.skillId, skill.id), ne(automations.trigger, 'morning'))).get();
  return named ? null : skill.id;
};

/**
 * Gives the Account its starting Automations once: 毎朝のメール処理,
 * unattended at 05:00 with every tool, and タスクのリマインド, off, at
 * 07:00 that only reads Tasks and Contacts and sends. Both also start with
 * タスクの管理, which an Account that already wrote a Skill of that name keeps.
 * The mail Automation is on when the Account already has a mailbox and
 * otherwise waits, off, until one is connected. An Account that ran a mail Automation before
 * migration 0042 has its mail Skill rewritten for this; one that ran none
 * keeps a mail Skill of its own name as it wrote it. Every Account, however
 * old, is also given the Office Skill once (`office.ts`).
 */
export const ensureStarterAutomations = async (
  db: AccountDatabase,
  accountId: string,
  input: { mailbox: boolean } = { mailbox: true },
): Promise<void> => {
  await ensureOfficeSkill(db, accountId);
  const installed = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, STARTER_SETTING)).get();
  if (installed) return;
  const at = new Date();
  const timestamp = at.toISOString();
  const [formerMail, morningSkillId] = await Promise.all([
    db.select({ id: automations.id }).from(automations).where(inArray(automations.trigger, ['mail', 'morning'])).limit(1).get(),
    retiredMorningSkill(db),
  ]);
  const [intake, reminder, taskSkill, intakeName, reminderName] = await Promise.all([
    skillNamed(db, {
      accountId, name: INTAKE_SKILL_NAME, title: INTAKE_SKILL_TITLE, description: INTAKE_SKILL_DESCRIPTION, instructions: INTAKE_SKILL, at: timestamp, rewrite: Boolean(formerMail),
    }),
    skillNamed(db, {
      accountId, name: REMINDER_SKILL_NAME, title: REMINDER_SKILL_TITLE, description: REMINDER_SKILL_DESCRIPTION, instructions: REMINDER_SKILL, at: timestamp, rewrite: false,
    }),
    skillNamed(db, {
      accountId, name: TASK_SKILL_NAME, title: TASK_SKILL_TITLE, description: TASK_SKILL_DESCRIPTION, instructions: TASK_SKILL, files: TASK_SKILL_FILES, at: timestamp, rewrite: false,
    }),
    freeName(db, '毎朝のメール処理', '毎朝のメール処理（最初から）'),
    freeName(db, 'タスクのリマインド', 'タスクのリマインド（最初から）'),
  ]);
  const intakeId = crypto.randomUUID();
  const reminderId = crypto.randomUUID();
  await db.batch([
    db.insert(settings).values({ key: STARTER_SETTING, value: JSON.stringify({ intakeAutomationId: intakeId, reminderAutomationId: reminderId }), updatedAt: timestamp }),
    ...intake.statements,
    ...reminder.statements,
    ...taskSkill.statements,
    ...(morningSkillId ? [
      db.delete(automationSkills).where(eq(automationSkills.skillId, morningSkillId)),
      db.delete(skills).where(eq(skills.id, morningSkillId)),
    ] : []),
    ...automationStatements(db, {
      id: intakeId,
      accountId,
      name: intakeName,
      enabled: input.mailbox,
      schedule: 'daily 05:00',
      settings: { skillIds: [intake.id, taskSkill.id], tools: [...INTAKE_TOOLS], executionMode: 'unattended', suppressionWindow: 'none', model: null },
    }, at),
    ...automationStatements(db, {
      id: reminderId,
      accountId,
      name: reminderName,
      enabled: false,
      schedule: 'daily 07:00',
      settings: { skillIds: [reminder.id, taskSkill.id], tools: [...REMINDER_TOOLS], executionMode: 'unattended', suppressionWindow: 'day', model: null },
    }, at),
  ]);
};

/**
 * Turns 毎朝のメール処理 on when the Account's mailbox is connected for the
 * first time: it was made off only because there was no mail to read.
 * One the Account has run, renamed into use, or turned on or off itself is
 * left as it is.
 */
export const startMailIntake = async (db: AccountDatabase, at: Date): Promise<void> => {
  const installed = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, STARTER_SETTING)).get();
  const intakeId = installed ? starterIntakeId(installed.value) : null;
  if (!intakeId) return;
  const intake = await db.select({ enabled: automations.enabled, schedule: automations.schedule, createdAt: automations.createdAt, updatedAt: automations.updatedAt })
    .from(automations).where(eq(automations.id, intakeId)).get();
  if (!intake || intake.enabled || intake.updatedAt !== intake.createdAt || !intake.schedule) return;
  const ran = await db.select({ id: runs.id }).from(runs).where(eq(runs.automationId, intakeId)).limit(1).get();
  if (ran) return;
  await db.update(automations).set({
    enabled: true,
    nextRunAt: nextScheduledRun({ schedule: intake.schedule, after: at }),
    updatedAt: at.toISOString(),
  }).where(and(eq(automations.id, intakeId), eq(automations.enabled, false))).run();
};

const starterIntakeId = (value: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || !('intakeAutomationId' in parsed)) return null;
    return typeof parsed.intakeAutomationId === 'string' ? parsed.intakeAutomationId : null;
  } catch {
    return null;
  }
};
