import { AudioLines, CircleAlert, Upload } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { Link, useLoaderData, useNavigate } from 'react-router-dom';

import {
  RECORDING_BYTES,
  RECORDING_PICKABLE,
  TRANSCRIPTION_MISSING,
  elapsed,
  oversizedRecordingText,
  recordingType,
  sizeLabel,
  unsupportedRecordingText,
  type TranscriptList,
  type TranscriptSummary,
} from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { minutesState, named, transcriptState } from '../labels';
import { pendingKey, usePendingOperations } from '../pending';
import { useRefreshed } from '../refresh';
import { dateTimeLabel } from '../time';
import { Button } from '../ui/button';
import { Deferred, later } from '../ui/deferred';
import { List, Row } from '../ui/list';
import { Banner, Chip, Empty } from '../ui/notice';
import { Note, Page, Toolbar } from '../ui/page';
import { SkeletonRows } from '../ui/skeleton';

export interface TranscriptsData {
  list: Promise<TranscriptList>;
}

/** Returns at once; the recordings fill in as they are read. */
export const loader = async (): Promise<TranscriptsData> => ({ list: later(api.transcripts(await accountIdOf())) });

/** Whether anything listed is still being worked on, so the list is read again until it is not. */
export const working = (transcript: Pick<TranscriptSummary, 'state' | 'minutesState'>): boolean =>
  transcript.state === 'transcribing' || transcript.minutesState === 'writing';

/** What one recording is, under its name: when it was uploaded, how long it is, and who uploaded it. */
export const recordingFacts = (transcript: TranscriptSummary): string => [
  dateTimeLabel(transcript.createdAt),
  transcript.durationSeconds === null ? sizeLabel(transcript.size) : elapsed(transcript.durationSeconds),
  transcript.speakers === null ? null : `話者${transcript.speakers}人`,
  transcript.createdBy || null,
].filter(Boolean).join(' ・ ');

/**
 * Why a chosen file cannot be uploaded, read from its first bytes and its
 * size before anything is sent, or null when it can.
 */
const refusalOf = async (file: File): Promise<string | null> => {
  if (!recordingType(new Uint8Array(await file.slice(0, 12).arrayBuffer()))) return unsupportedRecordingText(file.name);
  return file.size > RECORDING_BYTES ? oversizedRecordingText(file.name) : null;
};

const TranscriptRows = ({ initial }: { initial: TranscriptList }) => {
  const { account } = useAccount();
  const navigate = useNavigate();
  const operations = usePendingOperations();
  const picker = useRef<HTMLInputElement>(null);
  const [refusal, setRefusal] = useState('');
  const [list] = useRefreshed(initial, () => api.transcripts(account.accountId), (value) => value.transcripts.some(working));
  const uploading = operations.pending(pendingKey.recordingUpload);

  const choose = (event: ChangeEvent<HTMLInputElement>): void => {
    const [file] = [...event.target.files ?? []];
    event.target.value = '';
    if (!file) return;
    setRefusal('');
    void refusalOf(file).then((refused) => {
      if (refused) {
        setRefusal(refused);
        return;
      }
      void operations.run(pendingKey.recordingUpload, async () => {
        const uploaded = await api.uploadRecording(account.accountId, file);
        navigate(`../transcripts/${encodeURIComponent(uploaded.id)}`);
      });
    });
  };

  return <>
    {!list.transcription && <Banner tone="warn" icon={<CircleAlert size={18} aria-hidden="true" />} action={<Link to="../connections">接続を開く</Link>}>{TRANSCRIPTION_MISSING}</Banner>}
    <Toolbar>
      <Button icon={<Upload size={18} aria-hidden="true" />} busy={uploading} disabled={!list.transcription} onClick={() => picker.current?.click()}>
        {uploading ? 'アップロードしています…' : '録音をアップロード'}
      </Button>
    </Toolbar>
    <input ref={picker} type="file" className="fc-sr-only" tabIndex={-1} accept={RECORDING_PICKABLE} aria-label="文字起こしする録音" onChange={choose} />
    <Note>MP3・M4A（MP4）・WAV・WebM・Ogg・FLAC・AAC の録音を、1 つ {RECORDING_BYTES / 1024 / 1024} MB まで（64 kbps でおよそ 70 分）。文字起こしには OpenRouter の料金が録音の長さに応じてかかります。ページを閉じても文字起こしは続きます。</Note>
    {(refusal || operations.error) && <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden="true" />}>{refusal || operations.error}</Banner>}
    {list.transcripts.length === 0
      ? <Empty icon={<AudioLines size={28} aria-hidden="true" />} title="録音はまだありません" text="会議の録音をアップロードすると、話者ごとに文字起こしします。そこから議事録も作れます。" />
      : <List label="録音">{list.transcripts.map((transcript) => {
        // One chip, so the name keeps its width on a phone: where the minutes are once there are any, and otherwise the transcript.
        const shown = transcript.minutesState ? named(minutesState, transcript.minutesState) : named(transcriptState, transcript.state);
        return <Row
          key={transcript.id}
          to={encodeURIComponent(transcript.id)}
          label={`${transcript.title}を開く`}
          leading={<AudioLines size={20} aria-hidden="true" />}
          title={transcript.title}
          sub={recordingFacts(transcript)}
          aside={<Chip tone={shown.tone}>{shown.label}</Chip>}
        />;
      })}</List>}
  </>;
};

/** Every recording uploaded, newest first, and the one place a recording is uploaded. */
const TranscriptsScreen = () => {
  const data = useLoaderData<TranscriptsData>();
  return <Page
    title="文字起こし"
    lead="会議の録音をアップロードすると、話者ごとに文字起こしします。文字起こしを読んでから「議事録にする」で議事録も作れます。どちらもダウンロードできます。"
    back={{ to: '../more', label: 'その他' }}
    narrow
  >
    <Deferred value={data.list} fallback={<SkeletonRows />}>{(list) => <TranscriptRows initial={list} />}</Deferred>
  </Page>;
};

export default TranscriptsScreen;
