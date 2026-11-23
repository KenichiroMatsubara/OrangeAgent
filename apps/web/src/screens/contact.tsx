import { CircleAlert, Mail, MessageCircle, Pencil, Send, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useLoaderData, useNavigate, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { ChannelTestTarget, Contact, LineHandleKind } from '@mail/domain';

import { api } from '../api';
import { ChannelTestSheet } from '../channel';
import { accountIdOf, useAccount } from '../dashboard';
import { lineHandleKind } from '../labels';
import { pendingKey, usePendingOperations } from '../pending';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { List, Row } from '../ui/list';
import { Banner } from '../ui/notice';
import { Note, Page, Section, Toolbar } from '../ui/page';
import { Sheet } from '../ui/sheet';
import { hasEmail } from './contacts';

export interface ContactData {
  contact: Contact;
  target: ChannelTestTarget | null;
}

/** One Contact and the Channels a test can reach it on. A missing Contact is the screen's 404. */
export const loader = async (args: LoaderFunctionArgs): Promise<ContactData> => {
  const accountId = await accountIdOf();
  const contactId = args.params.contactId ?? '';
  const [contacts, targets] = await Promise.all([api.contacts(accountId), api.channelTestTargets(accountId)]);
  const contact = contacts.find((value) => value.id === contactId);
  if (!contact) throw new Response('Contact was not found', { status: 404 });
  return {
    contact,
    target: targets.find((target) => target.id === contactId) ?? null,
  };
};

const EditContact = ({ contact, onClose }: { contact: Contact; onClose: () => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  // A masked address is kept as it is unless the Account types a new one.
  const masked = contact.email === '***';
  const [name, setName] = useState(contact.name);
  const [email, setEmail] = useState(masked ? '' : contact.email);
  const [description, setDescription] = useState(contact.description);
  const [tagText, setTagText] = useState(contact.tags.join(', '));
  const [state, setState] = useState<Contact['state']>(contact.state);
  const saving = operations.pending(pendingKey.contactUpdate(contact.id));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.contactUpdate(contact.id), async () => {
      await api.updateContact(account.accountId, contact.id, {
        name: name.trim(),
        ...(masked && !email.trim() ? {} : { email: email.trim() }),
        description: description.trim(),
        tags: tagText.split(/[,、]/u).map((tag) => tag.trim()).filter(Boolean),
        state,
      });
      await revalidator.revalidate();
      onClose();
    });
  };
  return <Sheet title="連絡先を編集" onClose={onClose} onSubmit={submit}>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Field label="名前">{(control) => <input {...control} value={name} onChange={(change) => setName(change.target.value)} required />}</Field>
    <Field label="メールアドレス" hint={masked ? '登録済みのアドレスは表示しません。変えるときだけ入力します。' : undefined}>{(control) => <input {...control} type="email" value={email} onChange={(change) => setEmail(change.target.value)} />}</Field>
    <Field label="説明">{(control) => <input {...control} value={description} onChange={(change) => setDescription(change.target.value)} />}</Field>
    <Field label="タグ" hint="カンマで区切ります。">{(control) => <input {...control} value={tagText} onChange={(change) => setTagText(change.target.value)} />}</Field>
    <Field label="状態" hint="停止中の連絡先には何も送りません。">{(control) => <select {...control} value={state} onChange={(change) => setState(change.target.value as Contact['state'])}>
      <option value="active">有効</option><option value="inactive">停止中</option>
    </select>}</Field>
    <Button type="submit" block busy={saving}>{saving ? '保存しています…' : '保存する'}</Button>
  </Sheet>;
};

const SetLineHandle = ({ contact, onClose }: { contact: Contact; onClose: () => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const [destinationId, setDestinationId] = useState('');
  const [kind, setKind] = useState<LineHandleKind>(contact.lineDestinations.find((handle) => handle.source === 'manual')?.kind ?? 'user');
  const saving = operations.pending(pendingKey.lineDestinationSet(contact.id));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.lineDestinationSet(contact.id), async () => {
      await api.setContactLineHandle(account.accountId, contact.id, { destinationId: destinationId.trim(), kind });
      await revalidator.revalidate();
      onClose();
    });
  };
  return <Sheet title="LINE を設定" onClose={onClose} onSubmit={submit}>
    <Note>LINE から届いた相手を結び付けるときは、連絡先の一覧の「LINE から届いた相手」から選べます。ここでは ID を直接入れます。</Note>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Field label="LINE ID">{(control) => <input {...control} value={destinationId} onChange={(change) => setDestinationId(change.target.value)} placeholder="例: U4af498062…" required />}</Field>
    <Field label="種類">{(control) => <select {...control} value={kind} onChange={(change) => setKind(change.target.value as LineHandleKind)}>
      <option value="user">個人</option><option value="group">グループ</option><option value="room">トークルーム</option>
    </select>}</Field>
    <Button type="submit" block busy={saving} disabled={!destinationId.trim()}>{saving ? '設定しています…' : '設定する'}</Button>
  </Sheet>;
};

const RemoveContact = ({ contact, onClose }: { contact: Contact; onClose: () => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const navigate = useNavigate();
  const removing = operations.pending(pendingKey.contactDelete(contact.id));
  const remove = (): void => void operations.run(pendingKey.contactDelete(contact.id), async () => {
    await api.deleteContact(account.accountId, contact.id);
    navigate('../contacts', { replace: true, relative: 'route' });
  });
  return <Sheet title={`「${contact.name}」を削除しますか？`} onClose={onClose}>
    <Note>LINE の結び付きとリストへの登録は外れます。Google ToDo のタスクのメモに書かれた担当者の名前は、そのまま残ります。</Note>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Button variant="danger" block busy={removing} icon={<Trash2 size={18} aria-hidden="true" />} onClick={remove}>{removing ? '削除しています…' : '削除する'}</Button>
    <Button variant="secondary" block disabled={removing} onClick={onClose}>やめる</Button>
  </Sheet>;
};

type Sheets = 'edit' | 'line' | 'test' | 'remove' | null;

/** One Contact: how the product reaches it, what it was given, and how to change either. */
const ContactScreen = () => {
  const { contact, target } = useLoaderData<ContactData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const [sheet, setSheet] = useState<Sheets>(null);
  const close = (): void => setSheet(null);
  const unlink = (handleId: string): void => void operations.run(pendingKey.lineDestinationUnlink(handleId), async () => {
    await api.removeContactLineHandle(account.accountId, contact.id, handleId);
    await revalidator.revalidate();
  });
  const reachable = hasEmail(contact) || contact.lineDestinations.length > 0;
  return <Page
    title={contact.name}
    back={{ to: '../contacts', label: '連絡先' }}
    lead={[contact.description, contact.tags.join('・')].filter(Boolean).join(' ・ ') || undefined}
    actions={<Button variant="secondary" small icon={<Pencil size={16} aria-hidden="true" />} onClick={() => setSheet('edit')}>編集</Button>}
    narrow
  >
    {contact.state === 'inactive' && <Banner tone="neutral">停止中の連絡先です。何も送りません。</Banner>}
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Section title="届け先">
      {!reachable && <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />}>メールアドレスも LINE もありません。要約もリマインドも届きません。</Banner>}
      {reachable && <List>
        {contact.lineDestinations.map((handle) => <Row
          key={handle.id}
          leading={<MessageCircle size={20} aria-hidden="true" />}
          title={handle.displayName || 'LINE'}
          sub={`LINE ・ ${lineHandleKind[handle.kind]}${handle.source === 'manual' ? ' ・ 手で登録' : ''} ・ ${handle.destinationId}`}
          aside={<Button variant="quiet" small busy={operations.pending(pendingKey.lineDestinationUnlink(handle.id))} aria-label={`${handle.displayName || 'LINE'}の結び付きを外す`} onClick={() => unlink(handle.id)}>外す</Button>}
        />)}
        {hasEmail(contact) && <Row leading={<Mail size={20} aria-hidden="true" />} title={contact.email === '***' ? '登録済み（表示しません）' : contact.email} sub="メール" />}
      </List>}
      <Toolbar>
        {target && target.channels.length > 0 && <Button variant="secondary" icon={<Send size={18} aria-hidden="true" />} onClick={() => setSheet('test')}>テスト送信</Button>}
        <Button variant="secondary" icon={<MessageCircle size={18} aria-hidden="true" />} onClick={() => setSheet('line')}>LINE を設定</Button>
      </Toolbar>
    </Section>
    <Button variant="danger" block icon={<Trash2 size={18} aria-hidden="true" />} onClick={() => setSheet('remove')}>この連絡先を削除</Button>
    {sheet === 'edit' && <EditContact contact={contact} onClose={close} />}
    {sheet === 'line' && <SetLineHandle contact={contact} onClose={close} />}
    {sheet === 'test' && target && <ChannelTestSheet accountId={account.accountId} contactId={contact.id} channels={target.channels} onClose={close} />}
    {sheet === 'remove' && <RemoveContact contact={contact} onClose={close} />}
  </Page>;
};

export default ContactScreen;
