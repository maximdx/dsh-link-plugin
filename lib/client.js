/**
 * dsh-link-plugin — browser half (link-only, upgrade-tolerant build).
 *
 * Two small, independent features, both built only on DSH's documented client
 * extension surfaces:
 *
 * 1. Paste a URL over selected composer text
 *    Select text in the DSH composer, paste a URL, and the selection becomes
 *    `[selected text](url)` as one undoable edit.
 *    - A hidden `conversation.input.overlay` entry receives the composer's
 *      standard provide-channel props (`useInput`, `inputActions`). While
 *      mounted it installs a document CAPTURE-phase `paste` listener; the host
 *      editor handles paste in the bubble phase, so this listener runs first
 *      and can suppress the native plain-text paste only after the public
 *      `inputActions.insertText(text, span)` call has accepted the edit.
 *    - If any of the host surfaces is absent or has changed, the handler
 *      returns early and the native paste happens unchanged.
 *
 * 2. Rendered links in sent user messages
 *    User messages are rendered as plain text by the host. A `userText` rule
 *    (id `markdown-link`) matches inline `[label](http(s)://…)` /
 *    `[label](mailto:…)`, and a keyed `conversation.user.text.node` renderer
 *    draws a small inline icon + underlined label instead of the raw
 *    Markdown. Model input and the clipboard keep the Markdown source; in a
 *    sent bubble the link is a normal external anchor.
 *
 * Upgrade-tolerance rules used here (DSH plugin guidance):
 * - No `require()` of host client packages (`@deepseek-ai/dsh-client-ui-*`).
 *   The only runtime import is React from the browser module table. Host
 *   components change without notice; icons and markup are ours.
 * - Styling uses only `--dsw-alias-*` theme tokens where possible, so a
 *   renamed token degrades appearance instead of breaking rendering.
 * - Each feature registers inside its own guarded context; a missing service
 *   or slot disables that feature only, never the whole plugin.
 * - The plugin declares no `engines.dsh` pin, so a DSH update can never skip
 *   it at the compatibility preflight. Instead it loads and degrades.
 * - `tools/compat-check.mjs` verifies the small host surface after every DSH
 *   app update and reports exactly what changed.
 *
 * Module format: the DSH browser kernel (@deepseek-ai/dsh-client-modules) is a
 * lazy-CJS table. A plugin bundle is a classic script calling
 * `window.__ModuleLoader__.load({ id, factory })`; the factory receives a
 * `require(specifier)` resolving only seed words and other boot-graph rows.
 * No JSX, no bundler: React.createElement only.
 */

window.__ModuleLoader__.load({
  id: "dsh-link-plugin",
  factory(require) {
    const React = require("react");

    //#region identity and log helpers
    /** Package name; also the module id, Loader row name, and style owner id. */
    const PLUGIN_ID = "dsh-link-plugin";
    /** User-text rule id AND the keyed `conversation.user.text.node` renderer key. */
    const RULE_ID = "markdown-link";
    /** List-slot entry id for the hidden paste interceptor. */
    const OVERLAY_ENTRY_ID = "markdown-link-paste";
    /** Session-scoped list slot rendered inside the composer card. */
    const COMPOSER_OVERLAY_SLOT = "conversation.input.overlay";
    /** Session-scoped keyed slot rendering one user-text JSON node. */
    const USER_TEXT_NODE_SLOT = "conversation.user.text.node";
    const LOG_PREFIX = `[${PLUGIN_ID}]`;
    /** Log one diagnostic per topic, so a degraded surface does not spam the console. */
    const warnedTopics = new Set();
    function warnOnce(topic, message, detail) {
      if (warnedTopics.has(topic)) return;
      warnedTopics.add(topic);
      if (detail === undefined) console.warn(`${LOG_PREFIX} ${message}`);
      else console.warn(`${LOG_PREFIX} ${message}`, detail);
    }
    function reportError(topic, error) {
      if (warnedTopics.has(`error:${topic}`)) return;
      warnedTopics.add(`error:${topic}`);
      console.warn(`${LOG_PREFIX} ${topic} failed; that feature is disabled.`, error);
    }
    //#endregion

    //#region styles
    /** Style tag owner id, used to find/replace our own tag on reload. */
    const STYLE_TAG_ID = `${PLUGIN_ID}/link.css`;
    const STYLE_CLASS = {
      root: "dsh-mdlink",
      static: "dsh-mdlink-static",
      icon: "dsh-mdlink-icon",
      label: "dsh-mdlink-label",
      fallback: "dsh-mdlink-fallback",
    };
    const STYLES = [
      `.${STYLE_CLASS.root}{display:inline;color:inherit;text-decoration:none;white-space:normal;overflow-wrap:anywhere}`,
      `.${STYLE_CLASS.root}:hover .${STYLE_CLASS.label}{text-decoration-color:currentColor}`,
      `.${STYLE_CLASS.icon}{width:14px;min-width:14px;height:14px;margin-right:4px;vertical-align:-2px;opacity:.8}`,
      `.${STYLE_CLASS.label}{text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 45%,transparent);text-underline-offset:2px}`,
      `.${STYLE_CLASS.fallback}{white-space:pre-wrap}`,
    ].join("");
    /**
     * Install the plugin stylesheet; returns a disposer removing it. Styles are
     * owned by the plugin's effect so unload/reload cannot leave duplicates.
     */
    function installStyles() {
      if (typeof document === "undefined" || document.head === null) return function noop() {};
      const selector = `style[data-dsh-plugin-css="${STYLE_TAG_ID}"]`;
      const previous = document.querySelector(selector);
      if (previous !== null) previous.remove();
      const tag = document.createElement("style");
      tag.dataset.dshPlugin = PLUGIN_ID;
      tag.dataset.dshPluginCss = STYLE_TAG_ID;
      tag.textContent = STYLES;
      document.head.appendChild(tag);
      return function removeStyles() {
        tag.remove();
      };
    }
    //#endregion

    //#region link parsing helpers
    /** Schemes this plugin turns into inline Markdown links. */
    const LINK_SCHEME_RE = /^(?:https?:\/\/|mailto:)/iu;
    /** A single-token absolute URL, or undefined when the value is not one. */
    function normalizeLinkUrl(value) {
      if (typeof value !== "string") return undefined;
      const url = value.trim();
      if (url === "" || /\s/u.test(url)) return undefined;
      if (!LINK_SCHEME_RE.test(url)) return undefined;
      if (typeof URL === "function") {
        try {
          // Throws for garbage; mailto: is accepted by the URL parser.
          new URL(url);
        } catch {
          return undefined;
        }
      }
      return url;
    }
    /** Inline-link text escaping: backslash, brackets, and no line breaks. */
    function escapeLinkText(text) {
      return text.replace(/[\\[\]]/gu, (character) => `\\${character}`);
    }
    /** A Markdown link destination; angle wrapping keeps parentheses/space-bearing URLs valid. */
    function linkDestination(url) {
      if (!/[\s()<>]/u.test(url)) return url;
      return `<${url.replace(/</gu, "%3C").replace(/>/gu, "%3E")}>`;
    }
    /** `[label](url)` for one URL pasted over one selection. */
    function buildMarkdownLink(selectedText, url) {
      const label = escapeLinkText(selectedText.replace(/\s+/gu, " ").trim());
      return `[${label}](${linkDestination(url)})`;
    }
    /** Matches inline Markdown links whose destination this plugin can display. */
    const MARKDOWN_LINK_RE =
      /\[((?:\\.|[^\[\]\n])*)\]\((<[^>\n]*>|https?:\/\/[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*|mailto:[^\s()<>]+)\)/gu;
    /** Decide whether one line of user text has an inline link at/after `from`. */
    function nextMarkdownLink(text, from) {
      MARKDOWN_LINK_RE.lastIndex = from;
      const match = MARKDOWN_LINK_RE.exec(text);
      if (match === null) return undefined;
      const rawDestination = match[2];
      const destination = rawDestination.startsWith("<") ? rawDestination.slice(1, -1) : rawDestination;
      const url = normalizeLinkUrl(destination);
      if (url === undefined) return undefined;
      const label = match[1].replace(/\\([\\[\]])/gu, "$1");
      return {
        start: match.index,
        end: match.index + match[0].length,
        label,
        url,
      };
    }
    //#endregion

    //#region inline site icon (our own artwork; no host package)
    /**
     * Brand glyph paths (24×24, filled) for common link hosts, plus a generic
     * chain-link glyph for everything else. Path data is from Simple Icons
     * (CC0 1.0); see THIRD_PARTY_NOTICES.md. The map is deliberately small and
     * purely cosmetic — an unknown host simply gets the generic glyph.
     */
    const BRAND_ICONS = {
      "github": "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
      "npm": "M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z",
      "gitlab": "m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z",
      "youtube": "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
      "x": "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
      "figma": "M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z",
      "notion": "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
      "bilibili": "M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z",
      "zhihu": "M5.721 0C2.251 0 0 2.25 0 5.719V18.28C0 21.751 2.252 24 5.721 24h12.56C21.751 24 24 21.75 24 18.281V5.72C24 2.249 21.75 0 18.281 0zm1.964 4.078c-.271.73-.5 1.434-.68 2.11h4.587c.545-.006.445 1.168.445 1.171H9.384a58.104 58.104 0 01-.112 3.797h2.712c.388.023.393 1.251.393 1.266H9.183a9.223 9.223 0 01-.408 2.102l.757-.604c.452.456 1.512 1.712 1.906 2.177.473.681.063 2.081.063 2.081l-2.794-3.382c-.653 2.518-1.845 3.607-1.845 3.607-.523.468-1.58.82-2.64.516 2.218-1.73 3.44-3.917 3.667-6.497H4.491c0-.015.197-1.243.806-1.266h2.71c.024-.32.086-3.254.086-3.797H6.598c-.136.406-.158.447-.268.753-.594 1.095-1.603 1.122-1.907 1.155.906-1.821 1.416-3.6 1.591-4.064.425-1.124 1.671-1.125 1.671-1.125zM13.078 6h6.377v11.33h-2.573l-2.184 1.373-.401-1.373h-1.219zm1.313 1.219v8.86h.623l.263.937 1.455-.938h1.456v-8.86z",
      "wikipedia": "M12.09 13.119c-.936 1.932-2.217 4.548-2.853 5.728-.616 1.074-1.127.931-1.532.029-1.406-3.321-4.293-9.144-5.651-12.409-.251-.601-.441-.987-.619-1.139-.181-.15-.554-.24-1.122-.271C.103 5.033 0 4.982 0 4.898v-.455l.052-.045c.924-.005 5.401 0 5.401 0l.051.045v.434c0 .119-.075.176-.225.176l-.564.031c-.485.029-.727.164-.727.436 0 .135.053.33.166.601 1.082 2.646 4.818 10.521 4.818 10.521l.136.046 2.411-4.81-.482-1.067-1.658-3.264s-.318-.654-.428-.872c-.728-1.443-.712-1.518-1.447-1.617-.207-.023-.313-.05-.313-.149v-.468l.06-.045h4.292l.113.037v.451c0 .105-.076.15-.227.15l-.308.047c-.792.061-.661.381-.136 1.422l1.582 3.252 1.758-3.504c.293-.64.233-.801.111-.947-.07-.084-.305-.22-.812-.24l-.201-.021c-.052 0-.098-.015-.145-.051-.045-.031-.067-.076-.067-.129v-.427l.061-.045c1.247-.008 4.043 0 4.043 0l.059.045v.436c0 .121-.059.178-.193.178-.646.03-.782.095-1.023.439-.12.186-.375.589-.646 1.039l-2.301 4.273-.065.135 2.792 5.712.17.048 4.396-10.438c.154-.422.129-.722-.064-.895-.197-.172-.346-.273-.857-.295l-.42-.016c-.061 0-.105-.014-.152-.045-.043-.029-.072-.075-.072-.119v-.436l.059-.045h4.961l.041.045v.437c0 .119-.074.18-.209.18-.648.03-1.127.18-1.443.421-.314.255-.557.616-.736 1.067 0 0-4.043 9.258-5.426 12.339-.525 1.007-1.053.917-1.503-.031-.571-1.171-1.773-3.786-2.646-5.71l.053-.036z",
      "linkedin": "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
      "google": "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
      "reddit": "M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z",
      "discord": "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
      "telegram": "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
      "wechat": "M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z",
      "stackoverflow": "M15.725 0l-1.72 1.277 6.39 8.588 1.716-1.277L15.725 0zm-3.94 3.418l-1.369 1.644 8.225 6.85 1.369-1.644-8.225-6.85zm-3.15 4.465l-.905 1.94 9.702 4.517.904-1.94-9.701-4.517zm-1.85 4.86l-.44 2.093 10.473 2.201.44-2.092-10.473-2.203zM1.89 15.47V24h19.19v-8.53h-2.133v6.397H4.021v-6.396H1.89zm4.265 2.133v2.13h10.66v-2.13H6.154Z",
      "medium": "M4.21 0A4.201 4.201 0 0 0 0 4.21v15.58A4.201 4.201 0 0 0 4.21 24h15.58A4.201 4.201 0 0 0 24 19.79v-1.093c-.137.013-.278.02-.422.02-2.577 0-4.027-2.146-4.09-4.832a7.592 7.592 0 0 1 .022-.708c.093-1.186.475-2.241 1.105-3.022a3.885 3.885 0 0 1 1.395-1.1c.468-.237 1.127-.367 1.664-.367h.023c.101 0 .202.004.303.01V4.211A4.201 4.201 0 0 0 19.79 0Zm.198 5.583h4.165l3.588 8.435 3.59-8.435h3.864v.146l-.019.004c-.705.16-1.063.397-1.063 1.254h-.003l.003 10.274c.06.676.424.885 1.063 1.03l.02.004v.145h-4.923v-.145l.019-.005c.639-.144.994-.353 1.054-1.03V7.267l-4.745 11.15h-.261L6.15 7.569v9.445c0 .857.358 1.094 1.063 1.253l.02.004v.147H4.405v-.147l.019-.004c.705-.16 1.065-.397 1.065-1.253V6.987c0-.857-.358-1.094-1.064-1.254l-.018-.004zm19.25 3.668c-1.086.023-1.733 1.323-1.813 3.124H24V9.298a1.378 1.378 0 0 0-.342-.047Zm-1.862 3.632c-.1 1.756.86 3.239 2.204 3.634v-3.634z",
      "huggingface": "M1.4446 11.5059c0 1.1021.1673 2.1585.4847 3.1563-.0378-.0028-.0691-.0058-.1058-.0058-.4209 0-.8015.16-1.0704.4512-.3454.3737-.4984.8335-.4316 1.293a1.576 1.576 0 0 0 .2148.5978c-.2319.1864-.4018.4456-.4844.7578-.0646.2448-.131.7543.2149 1.2794a1.4552 1.4552 0 0 0-.0625.1055c-.208.3923-.2207.8372-.0371 1.25.2783.6258.9696 1.1175 2.3126 1.6467.8356.3292 1.5988.5411 1.6056.543 1.1046.2847 2.104.4277 2.969.4277 1.4173 0 2.4754-.3849 3.1525-1.1446 1.538.2651 2.791.1403 3.592.006.6773.7555 1.7332 1.1387 3.1467 1.1387.8649 0 1.8643-.143 2.969-.4278.0068-.0019.77-.2138 1.6056-.543 1.343-.5292 2.0343-1.0208 2.3126-1.6466.1836-.4129.171-.8577-.037-1.25a1.4685 1.4685 0 0 0-.0626-.1056c.346-.525.2795-1.0346.2149-1.2793-.0826-.3122-.2525-.5714-.4844-.7579.11-.1816.1831-.3788.2148-.5977.0669-.4595-.0862-.9193-.4316-1.293-.2688-.2913-.6495-.4513-1.0704-.4513-.0209 0-.0376.0008-.0588.0018.3162-.9966.4846-2.0518.4846-3.1523 0-5.807-4.7362-10.5144-10.5789-10.5144-5.8426 0-10.5788 4.7073-10.5788 10.5144Zm10.5788-9.4831c5.2727 0 9.5476 4.246 9.5476 9.483a9.4201 9.4201 0 0 1-.2696 2.2365c-.0039-.0047-.0079-.011-.0117-.0156-.274-.3255-.6679-.5059-1.1075-.5059-.352 0-.714.1155-1.0763.3438-.2403.1517-.5058.422-.7793.7598-.2534-.3492-.608-.5832-1.0137-.6465a1.5174 1.5174 0 0 0-.2344-.0176c-.9263 0-1.4828.7993-1.6935 1.5177-.1046.2426-.6065 1.3482-1.3614 2.0978-1.1681 1.1601-1.4458 2.3534-.8396 3.6382-.843.1029-1.5836.0927-2.365-.006.5906-1.212.3626-2.4388-.8426-3.6322-.755-.7496-1.2568-1.8552-1.3614-2.0978-.2107-.7184-.7673-1.5177-1.6935-1.5177-.078 0-.1568.0054-.2344.0176-.4057.0633-.7604.2973-1.0137.6465-.2735-.3379-.539-.6081-.7794-.7598-.3622-.2283-.7243-.3438-1.0762-.3438-.4266 0-.8094.171-1.0821.4786a9.4208 9.4208 0 0 1-.2598-2.1936c0-5.237 4.2749-9.483 9.5475-9.483zM8.6443 7.0036c-.4838.0043-.9503.2667-1.1934.7227-.3536.6633-.1006 1.4873.5645 1.84.351.1862.4883-.5261.836-.6485.3107-.1095.841.399 1.0078.086.3536-.6634.1025-1.4874-.5625-1.84a1.3659 1.3659 0 0 0-.6524-.1602Zm6.8403 0c-.2199-.002-.4426.05-.6504.1602-.665.3526-.9181 1.1766-.5645 1.84.1669.313.6971-.1955 1.0079-.086.3476.1224.4867.8347.838.6485.6649-.3527.916-1.1767.5624-1.84-.243-.456-.7096-.7184-1.1934-.7227Zm-9.7565 1.418a.8768.8768 0 0 0-.877.877c0 .4846.3925.877.877.877a.8768.8768 0 0 0 .877-.877.8768.8768 0 0 0-.877-.877zm12.6434 0c-.4845 0-.879.3925-.879.877 0 .4846.3945.877.879.877a.8768.8768 0 0 0 .877-.877.8768.8768 0 0 0-.877-.877zM8.7927 11.459c-.179-.003-.2793.1107-.2793.416 0 .8097.3874 2.125 1.4279 2.924.207-.7123 1.3453-1.2832 1.5079-1.2012.2315.1167.2191.4417.6074.7266.3884-.285.374-.6098.6056-.7266.1627-.082 1.3009.4889 1.5079 1.2012 1.0404-.799 1.4278-2.1144 1.4278-2.924 0-1.2212-1.583.6402-3.5413.6485-1.4686-.0061-2.7266-1.0558-3.2639-1.0645zM4.312 14.4768c.5792.365 1.6964 2.2751 2.1056 3.0177.1371.2488.371.3536.582.3536.4188 0 .7465-.4138.0391-.9395-1.0636-.791-.6914-2.0846-.1836-2.1642a.4302.4302 0 0 1 .0664-.004c.4616 0 .666.7892.666.7892s.5959 1.4898 1.6213 2.508c.942.9356 1.062 1.703.4961 2.6661-.0164-.004-.0159.0236-.1484.2149-.1853.2673-.4322.4688-.7188.6152-.5062.2269-1.1397.2696-1.7833.2696-1.037 0-2.1017-.1824-2.6975-.336-.0293-.0075-3.6505-.9567-3.1916-1.8224.0771-.1454.2033-.2031.3633-.2031.6463 0 1.823.9551 2.3283.9551.113 0 .196-.0865.2285-.2031.2249-.8045-3.2787-1.0522-2.9846-2.1642.0519-.1967.193-.2757.3907-.2754.854 0 2.7704 1.4923 3.172 1.4923.0307 0 .0525-.0085.0645-.0274.2012-.3227.1096-.5865-1.3087-1.4395-1.4182-.8533-2.4315-1.329-1.8653-1.9416.0651-.0707.1574-.1015.2695-.1015.8611.0002 2.8948 1.84 2.8948 1.84s.5487.5683.8809.5683c.0762 0 .1416-.0315.1855-.1054.2355-.3946-2.1858-2.2183-2.3224-2.971-.0926-.51.0641-.7676.3555-.7676-.0006.008.1701-.0285.4942.1759zm16.2257.5918c-.1366.7526-2.5579 2.5764-2.3224 2.9709.044.074.1092.1055.1855.1055.3321 0 .881-.5684.881-.5684s2.0336-1.8397 2.8947-1.84c.1121 0 .2044.0308.2695.1016.5662.6125-.447 1.0882-1.8653 1.9415-1.4183.853-1.51 1.1168-1.3087 1.4396.012.0188.0337.0273.0644.0273.4016 0 2.3181-1.4923 3.1721-1.4923.1977-.0002.3388.0787.3907.2754.294 1.112-3.2095 1.3597-2.9846 2.1642.0325.1166.1156.2032.2285.2032.5054 0 1.682-.9552 2.3283-.9552.16 0 .2862.0577.3633.2032.459.8656-3.1623 1.8149-3.1916 1.8224-.5958.1535-1.6605.336-2.6975.336-.6351 0-1.261-.0409-1.7638-.2599-.2949-.1472-.5488-.3516-.7383-.625-.0411-.0682-.1026-.1476-.1426-.205-.5726-.9679-.455-1.7371.4903-2.676 1.0254-1.0182 1.6212-2.508 1.6212-2.508s.2044-.7891.666-.7891a.4318.4318 0 0 1 .0665.0039c.5078.0796.88 1.3732-.1836 2.1642-.7074.5257-.3797.9395.039.9395.211 0 .445-.1047.5821-.3535.4092-.7426 1.5264-2.6527 2.1056-3.0178.5588-.3524.99-.1816.8497.5918z",
      "substack": "M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z",
    };
    /** Domain-suffix → brand slug. Order matters only for readability. */
    const BRAND_DOMAINS = [
      ["github.com", "github"],
      ["githubusercontent.com", "github"],
      ["npmjs.com", "npm"],
      ["npmjs.org", "npm"],
      ["npm.io", "npm"],
      ["gitlab.com", "gitlab"],
      ["youtube.com", "youtube"],
      ["youtu.be", "youtube"],
      ["x.com", "x"],
      ["twitter.com", "x"],
      ["figma.com", "figma"],
      ["notion.so", "notion"],
      ["notion.site", "notion"],
      ["bilibili.com", "bilibili"],
      ["b23.tv", "bilibili"],
      ["zhihu.com", "zhihu"],
      ["wikipedia.org", "wikipedia"],
      ["linkedin.com", "linkedin"],
      ["google.com", "google"],
      ["reddit.com", "reddit"],
      ["discord.com", "discord"],
      ["t.me", "telegram"],
      ["telegram.org", "telegram"],
      ["weixin.qq.com", "wechat"],
      ["stackoverflow.com", "stackoverflow"],
      ["medium.com", "medium"],
      ["huggingface.co", "huggingface"],
      ["substack.com", "substack"],
    ];
    /** Resolve the brand slug for one href, or undefined when unknown. */
    function brandSlugForHref(href) {
      if (typeof href !== "string" || typeof URL !== "function") return undefined;
      let host;
      try {
        host = new URL(href).hostname.toLowerCase().replace(/^www\./u, "");
      } catch {
        return undefined;
      }
      for (const [domain, slug] of BRAND_DOMAINS) {
        if (host === domain || host.endsWith(`.${domain}`)) return slug;
      }
      return undefined;
    }
    /** Inline site icon; brand glyph when known, generic link glyph otherwise. */
    function LinkIcon(props) {
      const slug = brandSlugForHref(props.href);
      const path = slug === undefined ? undefined : BRAND_ICONS[slug];
      if (path !== undefined) {
        return React.createElement(
          "svg",
          {
            className: STYLE_CLASS.icon,
            viewBox: "0 0 24 24",
            fill: "currentColor",
            "aria-hidden": "true",
            focusable: "false",
          },
          React.createElement("path", { d: path }),
        );
      }
      const iconProps = {
        className: STYLE_CLASS.icon,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
      };
      return React.createElement(
        "svg",
        iconProps,
        React.createElement("path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }),
        React.createElement("path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }),
      );
    }
    //#endregion

    //#region sent-user-message link rendering
    /**
     * User-text rule: find the next inline link in the original user text.
     * Contract (host): `match(text, from)` returns ONE non-empty node at/after
     * `from` whose `id` equals the rule id, or undefined. Rules are ordered by
     * ascending `order`; the earliest start wins across rules.
     */
    const MARKDOWN_LINK_RULE = {
      id: RULE_ID,
      order: 500,
      match(text, from) {
        try {
          if (typeof text !== "string") return undefined;
          const start = typeof from === "number" && Number.isFinite(from) ? Math.max(0, from) : 0;
          const found = nextMarkdownLink(text, start);
          if (found === undefined) return undefined;
          return {
            id: RULE_ID,
            start: found.start,
            end: found.end,
            data: { label: found.label, url: found.url },
          };
        } catch (error) {
          reportError("user-text rule", error);
          return undefined;
        }
      },
    };
    /**
     * Keyed node renderer for `conversation.user.text.node` under key
     * `markdown-link`. Receives `{ node, raw, interactive }`; `interactive` is
     * true in a sent user message bubble and false in queue previews.
     */
    function MarkdownLinkNode(props) {
      const node = props === null || props === undefined ? undefined : props.node;
      const raw = props !== null && props !== undefined && typeof props.raw === "string" ? props.raw : "";
      const data = node !== null && typeof node === "object" ? node.data : undefined;
      const url = data !== null && typeof data === "object" ? normalizeLinkUrl(data.url) : undefined;
      if (url === undefined) {
        // Never break the message: render the raw slice as plain text.
        return React.createElement("span", { className: STYLE_CLASS.fallback }, raw);
      }
      const label =
        data !== null && typeof data === "object" && typeof data.label === "string" && data.label !== ""
          ? data.label
          : url;
      const children = [
        React.createElement(LinkIcon, { key: "icon", href: url }),
        React.createElement("span", { key: "label", className: STYLE_CLASS.label, title: url }, label),
      ];
      if (props.interactive === true) {
        return React.createElement(
          "a",
          {
            className: STYLE_CLASS.root,
            href: url,
            target: "_blank",
            rel: "noopener noreferrer",
            title: raw === "" ? url : raw,
          },
          children,
        );
      }
      return React.createElement(
        "span",
        { className: `${STYLE_CLASS.root} ${STYLE_CLASS.static}`, title: raw === "" ? url : raw },
        children,
      );
    }
    /**
     * Register feature 2 on a context that has `slots` and `uiConversation`.
     * Each surface is checked first, so a renamed/removed API disables only
     * this feature.
     */
    function installUserTextRendering(ctx) {
      const uiConversation = ctx.get("uiConversation");
      const userText = uiConversation === undefined ? undefined : uiConversation.userText;
      if (userText === undefined || typeof userText.register !== "function") {
        warnOnce(
          "user-text",
          "sent-link rendering disabled: uiConversation.userText.register is missing (host API changed; run `node tools/compat-check.mjs`).",
        );
        return;
      }
      try {
        userText.register(MARKDOWN_LINK_RULE);
      } catch (error) {
        reportError("user-text rule registration", error);
        return;
      }
      try {
        ctx.slots.inject(USER_TEXT_NODE_SLOT, () =>
          ctx.slots.register(
            {
              name: USER_TEXT_NODE_SLOT,
              key: RULE_ID,
              priority: 100,
            },
            MarkdownLinkNode,
          ),
        );
      } catch (error) {
        reportError("user-text node registration", error);
      }
    }
    //#endregion

    //#region composer paste-to-Markdown-link
    /** Set true while the hidden paste anchor is mounted in a composer card. */
    let pasteAnchorMounted = false;
    /**
     * The editor's detect-projection text, rebuilt from the public InputState
     * (clipboard projection + chip occurrences). The evaluator/editor maps
     * selections onto this projection; a chip occupies one U+FFFC there.
     */
    function detectTextOf(inputState) {
      try {
        const draft = typeof inputState.draft === "string" ? inputState.draft : "";
        const occurrences = Array.isArray(inputState.occurrences) ? inputState.occurrences : [];
        if (occurrences.length === 0) return draft;
        let text = "";
        let cursor = 0;
        for (const occurrence of occurrences) {
          const offset = occurrence.offset;
          const length = occurrence.length;
          if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < cursor || length < 0) return undefined;
          text += `${draft.slice(cursor, offset)}\uFFFC`;
          cursor = offset + length;
        }
        return text + draft.slice(cursor);
      } catch {
        return undefined;
      }
    }
    /** Read the pasted URL from ClipboardData, or undefined when this paste is not one. */
    function pastedUrl(clipboardData) {
      if (clipboardData === null || clipboardData === undefined) return undefined;
      const read = (type) => {
        try {
          return clipboardData.getData(type) ?? "";
        } catch {
          return "";
        }
      };
      // Never steal image/file pastes: the host's own paste path handles them.
      try {
        const items = Array.from(clipboardData.items ?? []);
        if (items.some((item) => item.kind === "file")) return undefined;
      } catch {
        // items is optional; continue with the data types below.
      }
      const fromPlain = normalizeLinkUrl(read("text/plain"));
      if (fromPlain !== undefined) return fromPlain;
      // Dragged/copied URI lists carry one URI per line; "#" starts a comment.
      for (const line of read("text/uri-list").split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const candidate = normalizeLinkUrl(trimmed);
        if (candidate !== undefined) return candidate;
      }
      // Copying a rendered hyperlink usually puts its text in text/plain and
      // the destination in text/html; accept the first anchor with a link href.
      const html = read("text/html");
      if (html !== "" && typeof DOMParser === "function") {
        try {
          const anchor = new DOMParser().parseFromString(html, "text/html").querySelector("a[href]");
          const candidate = anchor === null ? undefined : normalizeLinkUrl(anchor.getAttribute("href") ?? "");
          if (candidate !== undefined) return candidate;
        } catch {
          // Fall through to "not a URL paste".
        }
      }
      return undefined;
    }
    /** The Lexical contenteditable root inside one composer card. */
    function editorRootOf(card) {
      // `data-composer-input` is set by the host's composer contenteditable;
      // `data-lexical-editor` is Lexical's own attribute on the same element.
      return card.querySelector("[data-composer-input]") ?? card.querySelector('[data-lexical-editor="true"]');
    }
    /**
     * Handle one capture-phase paste. Uses only host-provided public actions:
     * `useInput` state for the draft/phase, `inputActions.captureInsertion()`
     * for the revision-guarded span, `inputActions.insertText()` for the edit.
     * Every failure falls through to the native paste (nothing swallowed).
     * @param event - the DOM paste event.
     * @param host - hidden anchor element rendered inside the composer card.
     * @param stateRef - ref holding the latest InputState (or undefined).
     * @param actionsRef - ref holding the latest InputActions (or undefined).
     */
    function handlePaste(event, host, stateRef, actionsRef) {
      if (event.defaultPrevented) return;
      if (host === null || host === undefined) return;
      const card = host.closest("[data-composer-card]");
      if (card === null) return;
      const target = event.target;
      if (!(target instanceof Element) || !card.contains(target)) return;
      const editor = editorRootOf(card);
      if (editor === null || !editor.contains(target)) return;
      if (editor.getAttribute("contenteditable") === "false") return;
      const actions = actionsRef.current;
      const inputState = stateRef.current;
      if (actions === undefined || inputState === undefined) return;
      // Submit/adjudication phases freeze the draft; leave the paste to the host.
      if (inputState.phase !== "plain" && inputState.phase !== "claimed") return;
      const url = pastedUrl(event.clipboardData);
      if (url === undefined) return;
      const selection = window.getSelection();
      if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return;
      if (!editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return;
      const selectedText = selection.toString();
      if (selectedText.trim() === "") return;
      const detectText = detectTextOf(inputState);
      if (detectText === undefined) return;
      const span = actions.captureInsertion();
      // Non-collapsed span inside the current draft revision.
      if (span.start === span.end) return;
      // Fail-safe stale-selection guard: the captured span must still address
      // exactly the text the DOM selection shows. Chips in the range or a
      // projection that has not caught up both fall through to a normal paste.
      if (detectText.slice(span.start, span.end) !== selectedText) return;
      const markdown = buildMarkdownLink(selectedText, url);
      // Insert FIRST: a refused public action (locked editor or changed draft
      // revision) must let the native plain-text paste proceed untouched.
      if (!actions.insertText(markdown, span)) return;
      event.preventDefault();
      event.stopPropagation();
    }
    /**
     * Hidden paste interceptor, registered in `conversation.input.overlay`
     * (list, session scope). The composer's standard provide channel supplies
     * `useInput` and `inputActions`; the hidden span is only the DOM handle
     * that ties a listener to "the composer card this entry lives in".
     *
     * Hooks note: `useInput` is called only when the host provides it. The
     * presence of the standard props is stable for the life of a slot entry
     * (either the host provides the channel or it does not), so this does not
     * change a component's hook order between renders.
     */
    function MarkdownLinkPaste(props) {
      const useInput = props === null || props === undefined ? undefined : props.useInput;
      const inputActions = props === null || props === undefined ? undefined : props.inputActions;
      const input = typeof useInput === "function" ? useInput((state) => state) : undefined;
      const hostRef = React.useRef(null);
      const stateRef = React.useRef(input);
      const actionsRef = React.useRef(inputActions);
      stateRef.current = input;
      actionsRef.current = inputActions;
      React.useEffect(() => {
        const listener = (event) => {
          try {
            handlePaste(event, hostRef.current, stateRef, actionsRef);
          } catch (error) {
            reportError("paste handler", error);
          }
        };
        document.addEventListener("paste", listener, true);
        pasteAnchorMounted = true;
        return () => {
          document.removeEventListener("paste", listener, true);
          pasteAnchorMounted = false;
        };
      }, []);
      return React.createElement("span", {
        ref: hostRef,
        hidden: true,
        "data-dsh-link-anchor": "",
      });
    }
    /**
     * Register feature 1. `slots.inject` waits for the composer's slot
     * declaration and re-registers when the owning plugin reloads; if the slot
     * never exists, this feature simply stays absent.
     */
    function installPasteToLink(ctx) {
      if (ctx.slots === undefined || typeof ctx.slots.inject !== "function") {
        warnOnce(
          "slots",
          "paste-link disabled: ctx.slots.inject is missing (host API changed; run `node tools/compat-check.mjs`).",
        );
        return;
      }
      try {
        ctx.slots.inject(COMPOSER_OVERLAY_SLOT, () =>
          ctx.slots.register(
            {
              name: COMPOSER_OVERLAY_SLOT,
              id: OVERLAY_ENTRY_ID,
              order: 100,
            },
            MarkdownLinkPaste,
          ),
        );
      } catch (error) {
        reportError("paste anchor registration", error);
      }
    }
    //#endregion

    //#region cordis client plugin
    function apply(ctx) {
      // Owned stylesheet: removed with the plugin on unload/reload.
      try {
        ctx.effect(() => installStyles(), `${PLUGIN_ID}: styles`);
      } catch (error) {
        reportError("style installation", error);
      }
      // Feature 1: paste URL over a selection (needs only `slots`).
      installPasteToLink(ctx);
      // Feature 2: rendered links in sent user messages (needs uiConversation).
      // Optional service: if it is absent the paste feature still works.
      try {
        ctx.inject(["uiConversation"], (scope) => {
          installUserTextRendering(scope);
        });
      } catch (error) {
        reportError("uiConversation injection", error);
      }
      console.info(
        `${LOG_PREFIX} active: paste URL over a selection -> Markdown link; sent-message link rendering.`,
      );
    }
    //#endregion

    return {
      name: "markdown-link",
      inject: ["slots"],
      apply,
    };
  },
});
