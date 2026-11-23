/**
 * What the Worker uses of the copied code to serve a conversation: t3code's own schemas, to encode
 * every event, snapshot, and frame exactly as the copied client decodes them (the snapshot through
 * the ID-table codec, `withRecordIdTable`), and t3code's own projection reducer, to fold events
 * into the conversation the client would hold. Server and client therefore share one definition of
 * the wire and one reducer, and cannot drift apart.
 *
 * Nothing here reaches the web app (`~/`), so the Worker bundles it without the browser code.
 */
import { EventId, MessageId, NodeId, ProviderSessionId, RuntimeRequestId, ProjectId, RunId, ThreadId, TurnItemId } from '@t3tools/contracts/baseSchemas.ts';
import { ChatAttachmentId } from '@t3tools/contracts/chatAttachment.ts';
import { OrchestrationV2DomainEvent, OrchestrationV2ThreadProjection, OrchestrationV2ThreadStreamItem } from '@t3tools/contracts/orchestrationV2.ts';
import { ProviderInstanceId } from '@t3tools/contracts/providerInstance.ts';
import { applyOrchestrationV2ProjectionEvent } from '@t3tools/client-runtime/state/orchestrationV2Projection.ts';
import * as DateTime from 'effect/DateTime';
import * as Schema from 'effect/Schema';

export { chatModeOf, runtimeModeOf } from './modes.ts';
export type { ChatMode } from './api.ts';

export type {
  ChatAttachment,
  OrchestrationV2AppThread as Thread,
  OrchestrationV2DomainEvent as DomainEvent,
  OrchestrationV2Run as Run,
  OrchestrationV2RunUsage as RunUsage,
  OrchestrationV2RuntimeRequest as RuntimeRequest,
  OrchestrationV2ThreadProjection as Projection,
  OrchestrationV2ThreadStreamItem as StreamItem,
  OrchestrationV2TurnItem as TurnItem,
} from '@t3tools/contracts';

/** The JSON text of one stream item, as the client's `decodeFrame` reads it. */
export const encodeFrame = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2ThreadStreamItem));
export const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationV2ThreadStreamItem));

// A record's times are DateTime values; its JSON form, which `toCodecJson` adds, writes them as ISO strings.
const EventJson = Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2DomainEvent));
const ProjectionJson = Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadProjection));

/** The JSON text of one domain event, as a conversation's log keeps it. */
export const encodeEvent = Schema.encodeSync(EventJson);
export const decodeEvent = Schema.decodeUnknownSync(EventJson);

/** The JSON text of a whole conversation, as its row keeps it once an answer ends. */
export const encodeProjection = Schema.encodeSync(ProjectionJson);
export const decodeProjection = Schema.decodeUnknownSync(ProjectionJson);

/** Folds one event into the conversation with the reducer the client folds it with. */
export const foldEvent = (
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection => applyOrchestrationV2ProjectionEvent(projection, event) ?? projection;

/** A time in the form every t3code record carries. */
export const utc = (milliseconds: number): DateTime.Utc => DateTime.makeUnsafe(milliseconds);
export const utcMillis = (time: DateTime.Utc): number => DateTime.toEpochMillis(time);

/** The identifiers t3code's records are typed by, each made from OrangeAgent's own. */
export const ids = {
  attachment: (id: string) => ChatAttachmentId.make(id),
  event: (id: string) => EventId.make(id),
  item: (id: string) => TurnItemId.make(id),
  message: (id: string) => MessageId.make(id),
  node: (id: string) => NodeId.make(id),
  request: (id: string) => RuntimeRequestId.make(id),
  session: (id: string) => ProviderSessionId.make(id),
  project: (id: string) => ProjectId.make(id),
  provider: (id: string) => ProviderInstanceId.make(id),
  run: (id: string) => RunId.make(id),
  thread: (id: string) => ThreadId.make(id),
};
