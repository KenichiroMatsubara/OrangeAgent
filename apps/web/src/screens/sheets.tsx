import { Check, CircleAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { CONVERSATION_TITLE_LENGTH } from '@mail/domain';

import { errorText } from '../parts';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Banner } from '../ui/notice';
import { Note } from '../ui/page';
import { Sheet } from '../ui/sheet';

/** What a conversation is called until its first message names it. */
export const UNTITLED = '新しい会話';

/**
 * Renaming a conversation of Operator Chat, from its own screen or the list
 * of conversations: its place in the list stays, as the old chat's did.
 */
export const RenameSheet = ({ title, onRename, onClose }: {
  title: string;
  onRename: (title: string) => Promise<void>;
  onClose: () => void;
}) => {
  const [value, setValue] = useState(title);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    const named = value.replace(/\s+/gu, ' ').trim();
    if (!named) {
      setError('名前を入力してください。');
      return;
    }
    setBusy(true);
    try {
      await onRename(named);
      onClose();
    } catch (cause) {
      setError(errorText(cause, '名前を変えられませんでした。'));
      setBusy(false);
    }
  };
  return <Sheet title="会話の名前を変える" onClose={onClose} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <Field label="名前" hint="一覧での並びは変わりません。" error={error || undefined}>{(control) => <input
      {...control}
      value={value}
      maxLength={CONVERSATION_TITLE_LENGTH}
      onChange={(change) => { setValue(change.target.value); setError(''); }}
    />}</Field>
    <Button type="submit" block busy={busy} icon={<Check size={18} aria-hidden="true" />}>{busy ? '変えています…' : '名前を変える'}</Button>
    <Button variant="secondary" block disabled={busy} onClick={onClose}>やめる</Button>
  </Sheet>;
};

/**
 * Deleting a conversation of Operator Chat, once the member confirms it: an
 * answer being written is stopped first, and the Run each answer was
 * recorded as stays.
 */
export const DeleteSheet = ({ title, onDelete, onClose }: {
  title: string;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) => {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await onDelete();
    } catch (cause) {
      setError(errorText(cause, '会話を削除できませんでした。'));
      setBusy(false);
    }
  };
  return <Sheet title={`「${title || UNTITLED}」を削除しますか？`} onClose={onClose}>
    <Note>やり取りと、その中のファイルは元に戻せません。書いている途中の答えは止めてから削除します。各答えの実行の記録は残ります。</Note>
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    <Button variant="danger" block busy={busy} icon={<Trash2 size={18} aria-hidden="true" />} onClick={() => void remove()}>{busy ? '削除しています…' : '削除する'}</Button>
    <Button variant="secondary" block disabled={busy} onClick={onClose}>やめる</Button>
  </Sheet>;
};
