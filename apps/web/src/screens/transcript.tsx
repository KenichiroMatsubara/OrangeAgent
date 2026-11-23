import { CircleAlert, Copy, Download, FileText, LoaderCircle, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from 'react-router-dom';

import { MINUTES_MISSING, elapsed, transcriptPlainText, type TranscriptDetail } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { saveFile } from '../folder';
import { minutesState, named, transcriptState } from '../labels';
import { Markdown } from '../markdown';
import { useCopied } from '../parts';
import { pendingKey, usePendingOperations } from '../pending';
import { useRefreshed } from '../refresh';
import { Button } from '../ui/button';
import { Deferred, later } from '../ui/deferred';
import { Field } from '../ui/field';
import { Banner, Chip, Chips } from '../ui/notice';
import { Note, Page, Section, Toolbar } from '../ui/page';
import { Sheet } from '../ui/sheet';
import { SkeletonBlock } from '../ui/skeleton';
import styles from './transcript.module.css';
import { recordingFacts, working } from './transcripts';

export interface TranscriptData {
  transcript: TranscriptDetail;
  /** Whether an AI Connection is saved to write minutes with; read beside the transcript, so the page does not wait on it. */
  minutes: Promise<boolean>;
}

export const loader = async (args: LoaderFunctionArgs): Promise<TranscriptData> => {
  const accountId = await accountIdOf();
  const id = args.params.transcriptId ?? '';
  try {
    const transcript = await api.transcript(accountId, id);
    return { transcript, minutes: later(api.transcripts(accountId).then((list) => list.minutes)) };
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 404) throw new Response('Transcript was not found', { status: 404 });
    throw error;
  }
};

/** The name a download is saved under: the transcript's own, without the recording's extension. */
const downloadName = (title: string, kind: string, extension: string): string =>
  `${title.replace(/\.[A-Za-z0-9]{2,4}$/u, '').replace(/[\\/:*?"<>|]/gu, '_')}_${kind}.${extension}`;

/** Renames the transcript; the recording's own file name stays as it was uploaded. */
const RenameSheet = ({ transcript, onClose, onRenamed }: { transcript: TranscriptDetail; onClose: () => void; onRenamed: (title: string) => void }) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const [title, setTitle] = useState(transcript.title);
  const busy = operations.pending(pendingKey.transcriptRename(transcript.id));
  const save = (event: FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.transcriptRename(transcript.id), async () => {
      const renamed = await api.renameTranscript(account.accountId, transcript.id, title);
      onRenamed(renamed.title);
      onClose();
    });
  };
  return <Sheet title="名前を変える" onClose={onClose} onSubmit={save}>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Field label="名前">{(control) => <input {...control} value={title} onChange={(change) => setTitle(change.target.value)} />}</Field>
    <Button type="submit" block busy={busy} disabled={!title.trim() || title.trim() === transcript.title}>{busy ? '保存しています…' : '保存'}</Button>
  </Sheet>;
};

/**
 * 議事録にする: how the minutes should be written beyond the usual, and the
 * press that writes them. Without an AI Connection it says where to save one.
 */
const MinutesForm = ({ transcript, available, again, onWriting }: {
  transcript: TranscriptDetail;
  available: boolean;
  again: boolean;
  onWriting: (next: TranscriptDetail) => void;
}) => {
  const { account } = useAccount();
  const operations = usePendingOperations();
  const [instructions, setInstructions] = useState(transcript.minutesInstructions);
  const busy = operations.pending(pendingKey.minutesWrite(transcript.id));
  const write = (event: FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.minutesWrite(transcript.id), async () => {
      onWriting(await api.writeMinutes(account.accountId, transcript.id, { instructions }));
    });
  };
  if (!available) return <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />} action={<Link to="../connections">接続を開く</Link>}>{MINUTES_MISSING}</Banner>;
  return <form onSubmit={write}>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}
    <Field label="書き方の指示（任意）" hint="例: 箇条書きで短く／決定事項と宿題だけ／出席者は山田・佐藤・鈴木">{(control) =>
      <textarea {...control} rows={2} value={instructions} onChange={(change) => setInstructions(change.target.value)} />}</Field>
    <Toolbar>
      <Button type="submit" icon={again ? <RotateCcw size={18} aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />} busy={busy}>
        {busy ? '頼んでいます…' : again ? '議事録を作り直す' : '議事録にする'}
      </Button>
    </Toolbar>
  </form>;
};

const Working = ({ children }: { children: string }) =>
  <Banner tone="info" icon={<LoaderCircle className={styles.spin} size={18} aria-hidden="true" />}><span className={styles.working}>{children}</span></Banner>;

const TranscriptView = ({ initial, minutesAvailable }: { initial: TranscriptDetail; minutesAvailable: Promise<boolean> }) => {
  const { account } = useAccount();
  const navigate = useNavigate();
  const operations = usePendingOperations();
  const player = useRef<HTMLAudioElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const transcriptCopy = useCopied();
  const minutesCopy = useCopied();
  const [transcript, setTranscript] = useRefreshed(initial, () => api.transcript(account.accountId, initial.id), working);
  const state = named(transcriptState, transcript.state);
  const minutes = transcript.minutesState ? named(minutesState, transcript.minutesState) : null;
  const text = transcriptPlainText(transcript.lines);
  const again = (): void => void operations.run(pendingKey.transcriptAgain(transcript.id), async () => {
    const next = await api.transcribeAgain(account.accountId, transcript.id);
    setTranscript({ ...transcript, ...next });
  });
  const remove = (): void => void operations.run(pendingKey.transcriptRemove(transcript.id), async () => {
    await api.removeTranscript(account.accountId, transcript.id);
    navigate('../transcripts', { replace: true });
  });
  const play = (at: number): void => {
    const audio = player.current;
    if (!audio) return;
    audio.currentTime = at;
    void audio.play().catch(() => undefined);
  };

  return <Page title={transcript.title} back={{ to: '../transcripts', label: '文字起こし' }} narrow actions={<Chips>
    <Chip tone={state.tone}>{state.label}</Chip>
    {minutes && <Chip tone={minutes.tone}>{minutes.label}</Chip>}
  </Chips>}>
    <audio ref={player} className={styles.player} controls preload="metadata" src={api.recordingUrl(account.accountId, transcript.id)} aria-label={`${transcript.filename} の録音`} />
    <p className={styles.facts}>{transcript.filename} ・ {recordingFacts(transcript)}{transcript.model ? ` ・ ${transcript.model}` : ''}</p>
    <Toolbar>
      <Button variant="secondary" small icon={<Pencil size={18} aria-hidden="true" />} onClick={() => setRenaming(true)}>名前を変える</Button>
      {removing
        ? <Button variant="danger" small icon={<Trash2 size={18} aria-hidden="true" />} busy={operations.pending(pendingKey.transcriptRemove(transcript.id))} onClick={remove}>録音・文字起こし・議事録を削除する</Button>
        : <Button variant="quiet" small icon={<Trash2 size={18} aria-hidden="true" />} onClick={() => setRemoving(true)}>削除</Button>}
    </Toolbar>
    {operations.error && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{operations.error}</Banner>}

    {transcript.state === 'transcribing' && <Working>話者ごとに文字起こししています。ページを閉じても続きます。</Working>}
    {transcript.state === 'failed' && <Banner
      tone="danger"
      icon={<CircleAlert size={18} aria-hidden="true" />}
      action={<Button variant="secondary" small busy={operations.pending(pendingKey.transcriptAgain(transcript.id))} onClick={again}>もう一度文字起こし</Button>}
    >{transcript.error ?? '文字起こしできませんでした。'}</Banner>}

    {transcript.state === 'completed' && <Section title="議事録">
      {transcript.minutesState === 'writing' && <Working>{`${transcript.minutesModel ?? 'AI'} で議事録を作っています。ページを閉じても続きます。`}</Working>}
      {transcript.minutesState === 'failed' && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{transcript.minutesError ?? '議事録を作れませんでした。'}</Banner>}
      {transcript.minutesState === 'completed' && transcript.minutes && <>
        <div className={styles.minutes}><Markdown text={transcript.minutes} /></div>
        <Note>{`${transcript.minutesModel ?? 'AI'} が文字起こしから書きました。話者の名前は推測です。確かめてから使ってください。`}</Note>
        <Toolbar>
          <Button variant="secondary" small icon={<Copy size={18} aria-hidden="true" />} onClick={() => minutesCopy.copy(transcript.minutes ?? '')}>{minutesCopy.copied ? 'コピーしました' : 'コピー'}</Button>
          <Button variant="secondary" small icon={<Download size={18} aria-hidden="true" />} onClick={() => saveFile(transcript.minutes ?? '', downloadName(transcript.title, '議事録', 'md'), 'text/markdown;charset=utf-8')}>ダウンロード（.md）</Button>
          {!rewriting && <Button variant="quiet" small icon={<RotateCcw size={18} aria-hidden="true" />} onClick={() => setRewriting(true)}>作り直す</Button>}
        </Toolbar>
      </>}
      {transcript.minutesState !== 'writing' && (transcript.minutesState !== 'completed' || rewriting) && <Deferred value={minutesAvailable} fallback={<SkeletonBlock height={96} />}>{(available) =>
        <MinutesForm
          transcript={transcript}
          available={available}
          again={transcript.minutesState !== null}
          onWriting={(next) => {
            setRewriting(false);
            setTranscript(next);
          }}
        />}</Deferred>}
    </Section>}

    {transcript.state === 'completed' && <Section title="文字起こし" lead={transcript.speakers === null
      ? 'このモデルは話者を分けませんでした。'
      : '話者は声で分けたもので、名前ではありません。同じ人が別の話者に分かれることもあります。時刻を押すと、そこから再生します。'}>
      <Toolbar>
        <Button variant="secondary" small icon={<Copy size={18} aria-hidden="true" />} disabled={!text} onClick={() => transcriptCopy.copy(text)}>{transcriptCopy.copied ? 'コピーしました' : 'コピー'}</Button>
        <Button variant="secondary" small icon={<Download size={18} aria-hidden="true" />} disabled={!text} onClick={() => saveFile(text, downloadName(transcript.title, '文字起こし', 'txt'), 'text/plain;charset=utf-8')}>ダウンロード（.txt）</Button>
      </Toolbar>
      {transcript.lines.length === 0
        ? <Note>言葉は聞き取れませんでした。</Note>
        : <ol className={styles.lines} aria-label="文字起こし">{transcript.lines.map((line, index) => <li key={index} className={styles.line}>
          <button type="button" className={styles.at} disabled={line.at === null} onClick={() => line.at !== null && play(line.at)} aria-label={line.at === null ? undefined : `${elapsed(line.at)} から再生`}>
            {line.at === null ? '' : elapsed(line.at)}
          </button>
          {line.speaker && <span className={styles.speaker}>{line.speaker}</span>}
          <p className={styles.text}>{line.text}</p>
        </li>)}</ol>}
    </Section>}

    {renaming && <RenameSheet transcript={transcript} onClose={() => setRenaming(false)} onRenamed={(title) => setTranscript({ ...transcript, title })} />}
  </Page>;
};

/** One recording: its transcript speaker by speaker, and the minutes written from it when asked. */
const TranscriptScreen = () => {
  const data = useLoaderData<TranscriptData>();
  return <TranscriptView key={data.transcript.id} initial={data.transcript} minutesAvailable={data.minutes} />;
};

export default TranscriptScreen;
