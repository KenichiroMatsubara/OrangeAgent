import { CircleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { api } from './api';
import { errorText } from './parts';
import { Button } from './ui/button';
import { Field } from './ui/field';
import { Banner } from './ui/notice';
import { Note } from './ui/page';
import { Sheet } from './ui/sheet';

/**
 * The Discord Channel's credentials. Workers cannot hold the Gateway connection
 * a bot normally reads messages on, so the endpoint it answers with is where an
 * Account's people reach it, and it must be set in Discord for anything to arrive.
 */
export const DiscordSheet = ({ accountId, onClose }: { accountId: string; onClose: () => void }) => {
  const [botToken, setBotToken] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [interactionsUrl, setInteractionsUrl] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveDiscordConnection(accountId, { botToken: botToken.trim(), applicationPublicKey: publicKey.trim() });
      setInteractionsUrl(saved.interactionsUrl);
      setBotToken('');
    } catch (cause) {
      setError(errorText(cause, 'Discord の接続を保存できませんでした。'));
    } finally {
      setSaving(false);
    }
  };

  return <Sheet title="Discord" onClose={onClose} onSubmit={(event) => void save(event)}>
    <Note>Discord からは、スラッシュコマンドとボタンの操作だけが届きます。ふつうのメッセージは読めません。</Note>
    {error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{error}</Banner>}
    <Field label="Bot トークン">{(control) => <input {...control} type="password" value={botToken} onChange={(change) => setBotToken(change.target.value)} autoComplete="off" required />}</Field>
    <Field label="アプリケーションの公開鍵">{(control) => <input {...control} value={publicKey} onChange={(change) => setPublicKey(change.target.value)} placeholder="64 文字の 16 進数" autoCapitalize="none" spellCheck={false} required />}</Field>
    <Button type="submit" block busy={saving}>{saving ? '保存しています…' : '保存する'}</Button>
    {interactionsUrl && <Field label="Discord の Interactions Endpoint URL に設定してください">{(control) => <input {...control} readOnly value={interactionsUrl} />}</Field>}
  </Sheet>;
};
