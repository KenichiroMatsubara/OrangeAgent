/**
 * Google Meet as every run reaches it, through the Automation Inbox's grant:
 * finding the meetings the Account held or joined, reading one's transcript,
 * and turning on a meeting's automatic transcription, so that every meeting
 * held in it from then on is transcribed without anyone pressing a button.
 *
 * A transcript is read through Meet's own API, utterance by utterance with
 * who spoke, never as the Google Docs file Meet also writes, so it needs no
 * Drive reach. Meet keeps those utterances for 30 days after a meeting ends.
 */

import { GoogleApiError, type GoogleProvider, type MeetConferenceResource, type MeetParticipantResource } from './providers';
import { createAccountStore } from './storage/account-store';
import { accountDatabase } from './storage/database';

type Refusal = { isError: true; message: string };

const refused = (message: string): Refusal => ({ isError: true, message });

/** What one Meet call needs: the provider and a token of the Automation Inbox. */
export interface MeetSession {
  google: GoogleProvider;
  accessToken: string;
}

const NOT_GRANTED = 'The Automation Inbox’s Google grant does not reach Google Meet yet. Tell the administrator to reconnect the inbox on the 接続 screen.';

/** Why a run cannot reach Meet now, or null when it can. */
export const meetRefusal = async (database: D1Database): Promise<Refusal | null> => {
  const automation = await createAccountStore(accountDatabase(database)).currentAutomation();
  return automation?.meetGranted ? null : refused(NOT_GRANTED);
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** A bound as Meet's filter takes it: a bare day starts at midnight in Asia/Tokyo. */
const instant = (value: string): string | null => {
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00+09:00` : value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/** A meeting's code, from the code itself or from its link; null when it is neither. */
export const meetingCodeOf = (value: unknown): string | null => {
  const given = text(value);
  if (!given) return null;
  let code = given;
  if (/^https?:\/\//iu.test(given)) {
    let url: URL;
    try {
      url = new URL(given);
    } catch {
      return null;
    }
    if (url.hostname !== 'meet.google.com') return null;
    code = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  }
  code = code.toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(code) ? code : null;
};

/** Where Google refuses a Meet call because the Account may not see or change it, the reason the model can act on. */
const forbidden = (error: unknown, message: string): Refusal | null =>
  error instanceof GoogleApiError && (error.status === 403 || error.status === 404) ? refused(message) : null;

/** The meeting codes of the spaces named, each space asked of Meet once. */
const meetingCodes = async (session: MeetSession, spaces: readonly string[]): Promise<Map<string, string | null>> => {
  const unique = [...new Set(spaces)];
  const codes = await Promise.all(unique.map(async (space) => {
    try {
      return (await session.google.meet.readSpace(session.accessToken, space)).meetingCode ?? null;
    } catch {
      return null;
    }
  }));
  return new Map(unique.map((space, index) => [space, codes[index] ?? null]));
};

/** meet.search: the meetings that started between two times, newest first, with whether each was transcribed. */
export const searchMeet = async (session: MeetSession, arguments_: Record<string, unknown>) => {
  const from = instant(text(arguments_.from));
  const to = instant(text(arguments_.to));
  if (!from || !to) return refused('meet.search requires from and to, each RFC3339 or YYYY-MM-DD in Asia/Tokyo.');
  const conferences = await session.google.meet.listConferences(session.accessToken, { startFrom: from, startTo: to });
  const named = conferences.filter((conference): conference is MeetConferenceResource & { name: string } => Boolean(conference.name));
  const [codes, transcripts] = await Promise.all([
    meetingCodes(session, named.flatMap((conference) => conference.space ? [conference.space] : [])),
    Promise.all(named.map((conference) => session.google.meet.listTranscripts(session.accessToken, conference.name))),
  ]);
  return {
    meetings: named.map((conference, index) => ({
      meetingId: conference.name,
      meetingCode: conference.space ? codes.get(conference.space) ?? null : null,
      start: conference.startTime ?? '',
      end: conference.endTime ?? null,
      transcripts: (transcripts[index] ?? []).map((transcript) => (transcript.state ?? '').toLowerCase()),
    })),
  };
};

const speakerName = (participant: MeetParticipantResource): string =>
  participant.signedinUser?.displayName ?? participant.anonymousUser?.displayName ?? participant.phoneUser?.displayName ?? '名前不明';

/** An utterance's moment as a reader of the minutes says it: the time of day in Asia/Tokyo. */
const clock = (value: string | undefined): string => value
  ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value))
  : '';

/**
 * meet.read: one meeting with who joined it and every transcript of it, each
 * as lines of who said what when, in the order spoken.
 */
export const readMeet = async (session: MeetSession, meetingId: string) => {
  if (!/^conferenceRecords\/[^/]+$/u.test(meetingId)) return refused('meet.read requires a meetingId exactly as meet.search returned it.');
  let conference: MeetConferenceResource;
  try {
    conference = await session.google.meet.readConference(session.accessToken, meetingId);
  } catch (error) {
    const refusal = forbidden(error, `${meetingId} is not a meeting the Account held or joined, or Meet no longer keeps it.`);
    if (refusal) return refusal;
    throw error;
  }
  const [participants, transcripts, codes] = await Promise.all([
    session.google.meet.listParticipants(session.accessToken, meetingId),
    session.google.meet.listTranscripts(session.accessToken, meetingId),
    meetingCodes(session, conference.space ? [conference.space] : []),
  ]);
  const speakers = new Map(participants.flatMap((participant) => participant.name ? [[participant.name, speakerName(participant)] as const] : []));
  const read = await Promise.all(transcripts.flatMap((transcript) => transcript.name ? [{ ...transcript, name: transcript.name }] : []).map(async (transcript) => {
    const entries = await session.google.meet.listTranscriptEntries(session.accessToken, transcript.name);
    return {
      state: (transcript.state ?? '').toLowerCase(),
      start: transcript.startTime ?? '',
      end: transcript.endTime ?? null,
      documentUrl: transcript.docsDestination?.exportUri ?? null,
      lines: entries.map((entry) => `${clock(entry.startTime)} ${speakers.get(entry.participant ?? '') ?? '名前不明'}: ${entry.text ?? ''}`),
    };
  }));
  return {
    meetingId,
    meetingCode: conference.space ? codes.get(conference.space) ?? null : null,
    start: conference.startTime ?? '',
    end: conference.endTime ?? null,
    participants: [...new Set(speakers.values())],
    transcripts: read,
    ...(read.length ? {} : { note: 'This meeting was not transcribed.' }),
  };
};

/** A meet.transcribe call as every run reads it: the meeting, and its title as the administrator sees it. */
export interface MeetTranscriptionCall {
  meetingCode: string;
  title: string;
}

export const meetTranscriptionCall = (input: Record<string, unknown>): MeetTranscriptionCall => {
  const meetingCode = meetingCodeOf(input.meeting);
  if (!meetingCode) throw new Error('meet.transcribe requires meeting: the Meet link or meeting code calendar.search returned.');
  const title = text(input.title);
  if (!title) throw new Error('meet.transcribe requires the title of the event the meeting belongs to.');
  return { meetingCode, title };
};

/** Turns on a meeting's automatic transcription, or says it already was. */
export const transcribeMeeting = async (session: MeetSession, call: MeetTranscriptionCall) => {
  const ownerOnly = `Only the owner of meeting ${call.meetingCode} can turn on its transcription, and the Account does not own it.`;
  try {
    const space = await session.google.meet.readSpace(session.accessToken, call.meetingCode);
    if (!space.name) throw new Error('Meet did not return the meeting space.');
    if (space.config?.artifactConfig?.transcriptionConfig?.autoTranscriptionGeneration === 'ON') {
      return { transcribed: true, meetingCode: call.meetingCode, message: 'Automatic transcription was already on.' };
    }
    await session.google.meet.transcribeSpace(session.accessToken, space.name);
    return { transcribed: true, meetingCode: call.meetingCode };
  } catch (error) {
    const refusal = forbidden(error, ownerOnly);
    if (refusal) return refusal;
    throw error;
  }
};
