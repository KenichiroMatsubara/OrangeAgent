import type { BrowserBinding } from './cdp';
import type { Transcription } from './transcripts';
import type { WorkbenchBasic, WorkbenchLite, WorkbenchStandard1, WorkbenchStandard4 } from './workbench';

export interface Bindings {
  CONTROL_DB: D1Database;
  RECOVERY_RECEIPTS: R2Bucket;
  ASSETS: Fetcher;
  APP_URL: string;
  WEB_ORIGIN: string;
  RP_ID: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  CREDENTIAL_MASTER_KEY: string;
  CREDENTIAL_MASTER_KEY_VERSION: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_WORKER_NAME: string;
  /** The Microsoft Entra app FlareChat connects a Microsoft account through; without both, PDFs are rendered by Google alone. */
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  /** Google Picker's browser API key; with the app id, Operator Chat attaches a file from Drive and saves one in a folder a member chooses. */
  GOOGLE_PICKER_API_KEY?: string;
  /** The Google Cloud project number Picker grants `drive.file` access for. */
  GOOGLE_PICKER_APP_ID?: string;
  /** The OpenRouter key Operator Chat's Decider is asked with; without it, a conversation cannot be set to 自動. */
  OPENROUTER_API_KEY?: string;
  /** The deployment's VAPID key pair and contact address (push.ts); without all three, Operator Chat sends no notification and its setting says so. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /**
   * Workers AI, which reads each memory's meaning and predicts what a member is likely to write next in
   * Operator Chat; unbound in local development, where the Memory is searched by its words and nothing is suggested.
   */
  AI?: Ai;
  /** The Vectorize index the Memory's meanings are kept in, one namespace per Account; unbound in local development. */
  MEMORY_INDEX?: Vectorize;
  /** Carries on a recording's transcription or minutes once the screen that asked goes away (exchange-object.ts); the name is the Operator Chat it once ran. */
  CHAT_EXCHANGES?: DurableObjectNamespace;
  /** Transcribes a recording, trying again when the transcription fails (transcriber.ts); unbound, the recording is transcribed once in CHAT_EXCHANGES. */
  TRANSCRIBER?: Workflow<Transcription>;
  /** One object per conversation of Operator Chat (ADR 0201): it answers it, keeps its events, and streams them. */
  CHAT_THREADS?: DurableObjectNamespace;
  /** Where each Run Token's calls meet the run that issued it; unbound, no run issues one. */
  RUN_CALLS?: DurableObjectNamespace;
  /** Cloudflare Browser Run, the browser every run operates (ADR 0200); unbound in local development, where no run is offered one. */
  BROWSER?: BrowserBinding;
  /**
   * The Worker Loader that starts a Dynamic Worker for one run of JavaScript,
   * the lightest environment FlareChat lends a model whose API runs no code
   * (ADR 0202); unbound in local development, where no run is offered one.
   */
  LOADER?: WorkerLoader;
  /** The containers FlareChat lends a run's code, one class per size (ADR 0202); unbound in local development. */
  WORKBENCH_LITE?: DurableObjectNamespace<WorkbenchLite>;
  WORKBENCH_BASIC?: DurableObjectNamespace<WorkbenchBasic>;
  WORKBENCH_STANDARD_1?: DurableObjectNamespace<WorkbenchStandard1>;
  WORKBENCH_STANDARD_4?: DurableObjectNamespace<WorkbenchStandard4>;
}

export interface SessionRow {
  id: string;
  identity_id: string;
  email: string;
  display_name: string;
}

export interface AccountRow {
  id: string;
  name: string;
  status: 'provisioning' | 'active' | 'suspended' | 'failed';
  database_id: string | null;
  binding_name: string;
}

export interface ConnectionRow {
  id: string;
  kind: 'line' | 'ai' | 'discord';
  label: string;
  credential: string;
  status: 'active' | 'disconnected';
}
