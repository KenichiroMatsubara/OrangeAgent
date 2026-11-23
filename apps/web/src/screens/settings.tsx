import type { DriveFolders } from '@mail/domain';
import { CircleAlert, Folder } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useLoaderData, useRevalidator } from 'react-router-dom';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { pendingKey, usePendingOperations } from '../pending';
import { Button } from '../ui/button';
import { Deferred, later } from '../ui/deferred';
import { Field } from '../ui/field';
import { List, Row } from '../ui/list';
import { Banner } from '../ui/notice';
import { Card, FormCard, Note, Page, Section } from '../ui/page';
import { SkeletonBlock } from '../ui/skeleton';

export interface SettingsData {
  driveFolders: Promise<DriveFolders>;
}

/** Returns at once; the settings fill in as they are read. */
export const loader = async (): Promise<SettingsData> => {
  const accountId = await accountIdOf();
  return { driveFolders: later(api.driveFolders(accountId)) };
};

/**
 * The Drive folders beneath which AI reads and files, in Operator Chat and in
 * every Automation; none means the whole Drive. Where in them a mail's files
 * go is the AI's to choose, as the Skills say.
 */
const DriveFolders = ({ drive }: { drive: DriveFolders }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const [link, setLink] = useState('');
  const adding = operations.pending(pendingKey.driveFolderAdd);
  const add = (event: FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.driveFolderAdd, async () => {
      await api.addDriveFolder(account.accountId, link);
      setLink('');
      await revalidator.revalidate();
    });
  };
  const removeFolder = (folderId: string): void => void operations.run(pendingKey.driveFolderRemove(folderId), async () => {
    await api.removeDriveFolder(account.accountId, folderId);
    await revalidator.revalidate();
  });
  return <Section title="AI が触れる Drive" lead="AI に聞く画面でも自動化でも、AI はここに挙げたフォルダとその下にあるものだけを探し、読み、整理します。消すように頼まれたものは「OrangeAgent のゴミ箱」フォルダに移すだけで、削除はしません。">
    <Note>メールの添付ファイルを予定に付けるときも、置き場所はこの中から AI が選びます。決まった場所に置かせたいときは、<Link to="../skills">スキル</Link>に「添付は〇〇フォルダに、メールごとにまとめて置く」のように書きます。</Note>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    {drive.folders.length
      ? <List label="AI が触れるフォルダ">{drive.folders.map((folder) => <Row
        key={folder.id}
        leading={<Folder size={20} aria-hidden="true" />}
        title={<a href={folder.url} target="_blank" rel="noreferrer">{folder.name}</a>}
        aside={<Button variant="quiet" small busy={operations.pending(pendingKey.driveFolderRemove(folder.id))} aria-label={`${folder.name} を外す`} onClick={() => removeFolder(folder.id)}>外す</Button>}
      />)}</List>
      : <Note>まだフォルダを決めていないので、AI は Drive 全体に触れます。フォルダを足すと、その下だけになります。</Note>}
    <FormCard onSubmit={add}>
      <Field label="フォルダのリンク" hint="Google Drive でフォルダの「リンクをコピー」で得たリンクを貼ります。">{(control) => <input {...control} value={link} onChange={(change) => setLink(change.target.value)} placeholder="https://drive.google.com/drive/folders/…" inputMode="url" autoCapitalize="none" spellCheck={false} />}</Field>
      <Button type="submit" variant="secondary" busy={adding} disabled={!link.trim()}>{adding ? '確かめています…' : 'フォルダを足す'}</Button>
    </FormCard>
  </Section>;
};

/** Stopping the whole Account: no Automation runs and nothing is sent, until it is started again. */
const AccountState = () => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const suspended = account.status === 'suspended';
  const changing = operations.pending(pendingKey.accountSuspension);
  const set = (next: boolean): void => void operations.run(pendingKey.accountSuspension, async () => {
    await api.setSuspension(account.accountId, next);
    await revalidator.revalidate();
  });
  return <Section title="アカウント">
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Card>
      <Note>{suspended ? '止まっています。自動化は動かず、何も送りません。' : '動いています。止めると、自動化は動かず、何も送りません。'}</Note>
      {suspended
        ? <Button busy={changing} onClick={() => set(false)}>{changing ? '再開しています…' : '再開する'}</Button>
        : <Button variant="danger" busy={changing} onClick={() => set(true)}>{changing ? '止めています…' : '一時停止する'}</Button>}
    </Card>
  </Section>;
};

/** What the whole Account shares and no one Automation owns, other than its credentials. */
const SettingsScreen = () => {
  const data = useLoaderData<SettingsData>();
  return <Page title="設定" back={{ to: '../more', label: 'その他' }} narrow>
    <Deferred value={data.driveFolders} fallback={<SkeletonBlock height={200} />}>{(drive) => <DriveFolders drive={drive} />}</Deferred>
    <AccountState />
  </Page>;
};

export default SettingsScreen;
