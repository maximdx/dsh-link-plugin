/**
 * Host half of dsh-link-plugin.
 *
 * Every behavior this package has lives in the browser half:
 * `lib/client.js` registers (1) a paste interceptor that turns
 * "selected text + pasted URL" into one inline Markdown link inside the DSH
 * composer, and (2) a user-text rule + keyed node renderer that pretty-prints
 * unsent/sent user messages containing `[label](url)`.
 *
 * This host module exists only because @deepseek-ai/dsh-client-modules
 * discovers browser bundles through ENABLED Loader rows: the profile's bundle
 * patch inserts a row whose `name` is this package, and that row must import
 * cleanly. Requiring no host service keeps the row inert.
 *
 * @module dsh-link-plugin
 */

/** Loader row name; must match the `cordis.patch.yml` insert and the package name. */
export const name = 'dsh-link-plugin'

/** No host service is required. */
export const inject = []

/** No-op: the host contributes nothing. */
export function apply() {}
