/**
 * The Skill every Account is given for Office files and PDFs: how a run's
 * JavaScript makes, reads, and fills them with the libraries FlareChat lends
 * it (`lent.ts`). It does in JavaScript what the docx, xlsx, pptx, and pdf
 * Skills of Anthropic's collection, which Pi's documentation points to, do in
 * Python and the shell, and says what an isolate without LibreOffice cannot.
 *
 * It is written once into each Account, new or old; an Account that already
 * has a Skill of its name keeps its own, and one may rewrite or remove it.
 */

import { eq } from 'drizzle-orm';

import type { AccountDatabase } from './storage/database';
import { settings, skillRevisions, skills } from './storage/account-schema';

/** Marks that the Account has been given the Office Skill. */
const OFFICE_SETTING = 'office-skill-1';

export const OFFICE_SKILL_NAME = 'office-files';

/** The Office Skill's name as a person reads it. */
export const OFFICE_SKILL_TITLE = 'Officeファイル';

/** When the Office Skill applies. */
export const OFFICE_SKILL_DESCRIPTION = 'Word（docx）・Excel（xlsx）・PowerPoint（pptx）・PDF を作る・読む・届いた用紙や雛形に書き込むとき。JavaScript で、FlareChat が貸すライブラリを使います。';

/** How a run makes, reads, and fills Office files and PDFs in JavaScript. */
export const OFFICE_SKILL = `Office のファイル（docx・xlsx・pptx）と PDF は、code.run の JavaScript で扱います。Python では書きません。

## 使えるもの

code.run に language "javascript" を渡すと、次のライブラリを npm の名前でそのまま import できます（入れる手順は要りません。fetch もできません）。

- exceljs: xlsx を作る・読む・書き換える
- docx: docx を新しく作る（既存の docx は開けません）
- pptxgenjs: pptx を新しく作る
- pdf-lib: PDF を作る・結合する・分ける・回す・フォームに書く
- fflate: zip を開く・作る（Office のファイルは XML の zip です）
- @xmldom/xmldom: XML を読む・書き換える（DOMParser と XMLSerializer）

渡したファイルは files['名前'] に Uint8Array で入っています。スキルのファイルは import で読めます（例: import tpl from './skills/<スキルの名前>/templates/雛形.xlsx' は ArrayBuffer、new Uint8Array(tpl) で使います）。作ったファイルは output('名前.xlsx', バイト) で返します。バイトのまま返し、base64 にしません。

    import ExcelJS from 'exceljs';

    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('名簿');
    sheet.addRow(['氏名', '出欠']);
    output('名簿.xlsx', new Uint8Array(await book.xlsx.writeBuffer()));

## 届いた用紙・雛形に書き込む

届いた申込書や、スキルに置いた雛形に書くときは、ライブラリで開いて保存し直しません。exceljs で開いて保存すると、図形・テキストボックス・一部の書式が消える用紙があります。docx と pptx はライブラリで開けません。代わりに、zip を開いて、書くところの XML だけを直し、ほかの部品は 1 バイトも変えずに zip に戻します。

    import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
    import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

    const parts = unzipSync(files['申込書.xlsx']);
    const sheet = new DOMParser().parseFromString(strFromU8(parts['xl/worksheets/sheet1.xml']), 'text/xml');
    // … セルを直す …
    parts['xl/worksheets/sheet1.xml'] = strToU8(new XMLSerializer().serializeToString(sheet));
    output('申込書（記入済み）.xlsx', zipSync(parts));

- 書く前に、用紙の中身を読みます。どのセルに何を書くか、結合セル、入力規則（ドロップダウン）、式、コメント（「○月○日時点の年齢」のような書き方の指示）を確かめます。
- xlsx: シートの場所は xl/workbook.xml と xl/_rels/workbook.xml.rels で引きます（sheet1.xml とは限りません）。文字は xl/sharedStrings.xml に足して、その番号を <v> に書き、セルに t="s" を付けます。結合セルは左上のセルにだけ書きます。式の入ったセルには書きません。入力規則のあるセルには、選べる値だけを書きます。xl/workbook.xml の <calcPr> に fullCalcOnLoad="1" を立て、開いたときに計算し直させます。
- docx: 本文は word/document.xml、ヘッダーとフッターは word/header*.xml・word/footer*.xml です。Word は見た目には続いている文字をいくつもの <w:r>（run）に分けて持つので、探す文字が XML の中で続いているとは限りません。差し替える目印（{{氏名}} など）は、雛形の段階で 1 つの run に収めておきます。
- pptx: 各スライドは ppt/slides/slideN.xml です。並べ替え・足し引きは ppt/presentation.xml と ppt/_rels/presentation.xml.rels と [Content_Types].xml を合わせて直します。
- XML を整形し直したり、要素の順を入れ替えたりしません。Office は要素の順を決まりとして読みます。
- 書いたあと、もう一度 unzipSync で開き、部品の名前が元と同じこと、書いた値が入っていることを確かめてから返します。

## 新しく作るときの落とし穴

- docx: 紙の大きさの既定は A4 です。改行は "\\n" でなく段落（Paragraph）を分けます。表は columnWidths と各セルの width を両方 DXA で書き、合計を表の幅にそろえます。網掛けは ShadingType.CLEAR です（SOLID は黒くなります）。箇条書きの「•」を文字で書かず、numbering の LevelFormat.BULLET を使います。ImageRun には type（"png" など）が要ります。日本語は font に「游明朝」「游ゴシック」などを指定します。
- pptx: pptxgenjs はオプションのオブジェクトを使うたびに書き換えるので、影などの設定を 2 つの要素で使い回さず、毎回新しく作ります。write({ outputType: 'arraybuffer' }) で受け取り、new Uint8Array にして返します。
- xlsx: 式は { formula: 'B4*1000' } で書きます。exceljs は式の計算結果を持たないので、Excel で開くまで値が空に見えます。日付・割合・金額のセルには numFmt を付けます。
- PDF: pdf-lib の標準の書体は日本語を持ちません。日本語の入った PDF はここでは新しく作れないので、docx か xlsx で作り、そのことを答えに書きます。PDF の結合・分割・回転・ページの抜き出し・英数字のフォームへの記入はできます。

## ここでできないこと

LibreOffice・pandoc・画像化の道具はありません。PDF への変換、ページの画像での確認、式の計算し直し（保存されている計算結果を正しい値にすること）、PDF からの文字の抜き出しはできません。必要なときは、できなかったことと、人がすること（Excel で開いて保存し直す など）を答えに書きます。`;

/**
 * Gives the Account the Office Skill once. An Account that already has a
 * Skill of its name, its own or one it was given, keeps it as it is.
 */
export const ensureOfficeSkill = async (db: AccountDatabase, accountId: string, at: Date = new Date()): Promise<void> => {
  const given = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, OFFICE_SETTING)).get();
  if (given) return;
  const timestamp = at.toISOString();
  const named = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, OFFICE_SKILL_NAME)).get();
  const id = named?.id ?? crypto.randomUUID();
  await db.batch([
    db.insert(settings).values({ key: OFFICE_SETTING, value: JSON.stringify({ skillId: id }), updatedAt: timestamp }),
    ...(named ? [] : [
      db.insert(skills).values({
        id, accountId, name: OFFICE_SKILL_NAME, title: OFFICE_SKILL_TITLE, description: OFFICE_SKILL_DESCRIPTION, instructions: OFFICE_SKILL,
        revision: 1, published: false, createdAt: timestamp, updatedAt: timestamp,
      }),
      db.insert(skillRevisions).values({ skillId: id, revision: 1, instructions: OFFICE_SKILL, createdAt: timestamp }),
    ]),
  ]);
};
