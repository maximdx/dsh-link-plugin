/**
 * Host half of dsh-link-plugin.
 *
 * Every behavior this package has lives in the browser half `lib/client.js`
 * (two extension surfaces: a composer paste interceptor that binds a pasted
 * URL to the current selection as one inline Markdown link, and a user-text
 * rule + keyed renderer that displays inline Markdown links in sent user
 * messages).
 *
 * This host module exists only because @deepseek-ai/dsh-client-modules
 * discovers browser bundles through ENABLED Loader rows: the profile's bundle
 * patch inserts a row whose `name` is this package, and that row must import
 * cleanly. Requiring no host service keeps the row inert, and the row has no
 * DSH version requirement (see package.json: no `engines.dsh`, no
 * `@deepseek-ai/dsh*` peers), so a DSH update cannot disable the plugin at the
 * compatibility preflight.
 *
 * @module dsh-link-plugin
 */

/** Loader row name; must match the `cordis.patch.yml` insert and the package name. */
export const name = 'dsh-link-plugin'

/** No host service is required. */
export const inject = []

/** No-op: the host contributes nothing. */
export function apply() {}
