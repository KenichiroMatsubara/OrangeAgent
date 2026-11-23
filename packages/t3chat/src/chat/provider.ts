/**
 * The one provider the copied composer offers: FlareChat itself. t3code's composer sends nothing
 * unless a ready provider instance answers the thread's model selection, and every conversation
 * the Worker writes names the instance `flarechat` (apps/worker/src/timeline.ts). Which model
 * answers is the Account's AI Connection's concern, chosen on the Worker.
 */
import { DEFAULT_UNIFIED_SETTINGS, ProviderDriverKind, ProviderInstanceId, type RuntimeMode, type ServerProvider } from '@t3tools/contracts';
import type { UnifiedSettings } from '@t3tools/contracts/settings.ts';

export const FLARECHAT_INSTANCE = 'flarechat';

const instanceId = ProviderInstanceId.make(FLARECHAT_INSTANCE);
const driver = ProviderDriverKind.make(FLARECHAT_INSTANCE);

const FLARECHAT_PROVIDER: ServerProvider = {
  instanceId,
  driver,
  displayName: 'FlareChat',
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
  enabled: true,
  installed: true,
  version: null,
  status: 'ready',
  auth: { status: 'authenticated' },
  checkedAt: '1970-01-01T00:00:00.000Z',
  models: [{ slug: FLARECHAT_INSTANCE, name: 'FlareChat', isCustom: false, isDefault: true, capabilities: null }],
  slashCommands: [],
  skills: [],
};

/** The provider offering exactly `modes`, which the composer lists as its approval modes. */
export const flarechatProvider = (modes: ReadonlyArray<RuntimeMode>): ServerProvider => ({ ...FLARECHAT_PROVIDER, supportedRuntimeModes: [...modes] });

/** t3code's defaults, with the FlareChat instance turned on: an instance no setting names is off unless it is one of t3code's own. */
export const FLARECHAT_SETTINGS: UnifiedSettings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  providerInstances: { ...DEFAULT_UNIFIED_SETTINGS.providerInstances, [instanceId]: { driver, enabled: true } },
};
