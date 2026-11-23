import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay/index.ts";
import { RelayWebClientId } from "@t3tools/contracts/relay.ts";
import * as Layer from "effect/Layer";

import { loadOrCreateProofKey } from "./dpop";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "indexed-db",
  loadOrCreateKey: loadOrCreateProofKey(),
});

export const layer = (relayUrl: string) =>
  ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId }).pipe(
    Layer.provideMerge(layerRelayDpopSigner),
  );
