# Notice

The code under `src/` was copied from t3code (https://github.com/pingdotgg/t3code) at commit
`0dc32b5c8b`, under the MIT licence in `LICENSE`.

The copy is owned by FlareChat and is not synced: we never merge upstream again
(docs/adr/0201-rebuild-operator-chat-on-t3code.md). Changes made here are FlareChat's own.

Layout: t3code's `apps/web/src/*` is at `src/web/*`, each `packages/<name>/src/*` is at
`src/<name>/*`, and `apps/web/gt.config.json` is at `src/gt.config.json`, so that every
relative import between the copied files resolves as it did upstream.
