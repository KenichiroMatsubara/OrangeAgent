import { initializeGTSPA } from "gt-react";

import { DEFAULT_LOCALE, ORANGEAGENT_LOCALE, SUPPORTED_LOCALES } from "./locales";

// English is the source text, so it never loads a chunk. OrangeAgent: Japanese is the only
// translation, imported by name so no other catalog is built (the build cuts it, ../../../vite.ts).
async function loadTranslations(locale: string): Promise<unknown> {
  if (locale !== ORANGEAGENT_LOCALE) return {};
  const module: { default: unknown } = await import("./translations/ja.json");
  return module.default;
}

/** Sets up GT's singletons. `onLocaleRequest` receives GT's own locale changes. */
export function initializeI18n(onLocaleRequest: (locale: string) => void): void {
  void initializeGTSPA({
    defaultLocale: DEFAULT_LOCALE,
    locales: [...SUPPORTED_LOCALES],
    locale: DEFAULT_LOCALE,
    loadTranslations,
    // GT's default drops a catalog from its cache after 60 s; call-time `m()` reads that cache.
    cacheExpiryTime: null,
    _reload: (state) => onLocaleRequest(state.locale),
  });
}
