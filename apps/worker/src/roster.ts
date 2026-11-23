import { readContactCsv, type ContactImportPreview, type ContactImportSkip } from '@mail/domain';

/** A Contact already in the roster, as the import compares a row against it. */
export interface RosterEntry {
  name: string;
  email: string;
}

const nameKey = (name: string): string => name.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('ja-JP');

/**
 * What importing a Contact CSV would do, without writing anything. A row whose
 * email an existing Contact or an earlier row holds is skipped, and so is a row
 * without an email whose name one of them already has: the import adds
 * Contacts and never changes one.
 */
export const previewContactCsv = (csv: string, roster: readonly RosterEntry[]): ContactImportPreview => {
  const { rows, problems } = readContactCsv(csv);
  const byEmail = new Map(roster.filter((entry) => entry.email).map((entry) => [entry.email.toLowerCase(), entry.name]));
  const byName = new Map(roster.map((entry) => [nameKey(entry.name), entry.name]));
  const accepted: ContactImportPreview['accepted'] = [];
  const skipped: ContactImportSkip[] = [];
  const takenEmails = new Map<string, number>();
  const takenNames = new Map<string, number>();
  for (const row of rows) {
    const skip = (reason: string): void => { skipped.push({ line: row.line, name: row.name, email: row.email, reason }); };
    const holder = row.email ? byEmail.get(row.email) : undefined;
    if (holder !== undefined) { skip(`このメールアドレスは既に「${holder}」に登録されています。`); continue; }
    const earlier = row.email ? takenEmails.get(row.email) : undefined;
    if (earlier !== undefined) { skip(`${earlier} 行目と同じメールアドレスです。`); continue; }
    if (!row.email) {
      const named = byName.get(nameKey(row.name));
      if (named !== undefined) { skip(`メールアドレスがなく、同じ名前の「${named}」が既にあります。`); continue; }
      const earlierName = takenNames.get(nameKey(row.name));
      if (earlierName !== undefined) { skip(`メールアドレスがなく、${earlierName} 行目と同じ名前です。`); continue; }
    }
    if (row.email) takenEmails.set(row.email, row.line);
    takenNames.set(nameKey(row.name), row.line);
    accepted.push(row);
  }
  return { accepted, skipped, invalid: problems };
};
