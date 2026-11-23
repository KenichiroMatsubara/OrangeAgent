import { msg } from "gt-react";

import { m } from "~/i18n/messages";

// OrangeAgent: the TIFF and HEIF decoder worker is cut. An image the browser cannot show itself
// fails with the same message the decoder gave for an image it could not decode.
export async function decodeImagePreview(_src: string, _heif: boolean, _signal: AbortSignal): Promise<Blob> {
  throw new Error(m(msg("Could not decode this image.")));
}
