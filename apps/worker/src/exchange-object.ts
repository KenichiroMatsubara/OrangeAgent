/**
 * The Durable Object that carries on the minutes written from a transcript,
 * or a recording's transcription where no Transcriber Workflow is bound
 * (transcriber.ts), once the request that started it ends: at
 * `/transcripts` it answers at once and records what came of the work on the
 * transcript's row. It keeps nothing in its own storage.
 *
 * It was where each exchange of the Operator Chat before ADR 0201 ran, which
 * is why the class and its binding are named for chat exchanges. Those
 * exchanges kept nothing here either, so removing the class would lose no
 * data, but a deleted class takes a `deleted_classes` migration that cannot be
 * undone, and the transcripts still need an object. Any other path it is asked
 * for is that chat's, which is gone (410).
 */

import { DurableObject } from 'cloudflare:workers';

import { productionProviders } from './providers';
import { performTranscriptWork, type TranscriptWork } from './transcripts';
import { activeAccountDatabase } from './routes/request-context';
import type { Bindings } from './types';

export class ChatExchanges extends DurableObject<Bindings> {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/transcripts') return new Response('The Operator Chat this object once answered has been replaced.', { status: 410 });
    const work = await request.json() as TranscriptWork;
    const database = await activeAccountDatabase(this.env, work.accountId);
    if (!database) return new Response('Account database is unavailable.', { status: 503 });
    this.ctx.waitUntil(performTranscriptWork({ env: this.env, providers: productionProviders(), database, work }));
    return new Response(null, { status: 202 });
  }
}
