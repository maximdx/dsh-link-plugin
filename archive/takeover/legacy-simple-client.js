/**
 * dsh-link-plugin — browser half.
 *
 * Two features, both implemented against DSH's PUBLIC client surfaces:
 *
 * 1. Paste-to-Markdown-link (composer)
 *    Select text in the DSH composer, then paste a URL: the selection is
 *    replaced with `[selected text](url)` as one undoable edit.
 *
 *    How it works:
 *    - A null-rendering component registered into the session-scoped list slot
 *      `conversation.input.overlay` receives the framework standard props
 *      `useInput` (InputState selector) and `inputActions` (the public
 *      InputActions object: `captureInsertion()` / `insertText(text, span)`).
 *    - While mounted it installs a CAPTURE-phase `paste` listener on
 *      `document`. Lexical installs its own `paste` listener on the editor
 *      ROOT ELEMENT in the bubble phase
 *      (`dsh-client-ui-conversation/lib/client.js`, `setRootElement`), so the
 *      capture listener runs first and can `preventDefault()` (suppresses the
 *      browser insertion and therefore the `beforeinput` insertFromPaste that
 *      DSH's PASTE_COMMAND handler would otherwise see) plus
 *      `stopPropagation()` (keeps the event away from Lexical's root listener,
 *      whose handler reads `clipboardData.getData("text/plain")` and replaces
 *      the selection with plain text).
 *    - The replacement itself is the public `inputActions.insertText(text,
 *      span)` call, where `span` comes from `inputActions.captureInsertion()`.
 *
 * 2. Pretty display for sent user messages
 *    DSH renders USER message text as plain text through the
 *    `conversation.user.text` Slot Factory; only assistant messages go through
 *    MarkdownText. This plugin contributes a user-text rule (id
 *    `markdown-link`) that matches `[label](http(s) url)` and a keyed node
 *    renderer on `conversation.user.text.node` that shows the site/brand glyph
 *    (primitives `LinkIconMedium`) plus the label instead of the literal
 *    Markdown.
 *
 * Module format: this is NOT an ES module. DSH's browser kernel
 * (@deepseek-ai/dsh-client-modules) is a lazy-CJS module table: a plugin
 * bundle is a classic script that calls
 * `window.__ModuleLoader__.load({ id, factory })`; the factory receives a
 * `require(specifier)` resolving ONLY against the frozen platform seed table
 * (react, react/jsx-runtime, react-dom, react-dom/client, zod,
 * @deepseek-ai/cordis, @tanstack/react-virtual,
 * @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
 * @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit)
 * plus other registered boot-graph package rows. This file only requires
 * baseline seed words, so `dsh.client.external` is unnecessary.
 *
 * No JSX and no bundler: React.createElement only.
 */

window.__ModuleLoader__.load({
	id: "dsh-link-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region imports (platform seed words only)
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#endregion

		//#region identity
		/** Package name; also the module id registered above and the style owner id. */
		const PLUGIN_ID = "dsh-link-plugin";
		/** User-text rule id AND the keyed `conversation.user.text.node` renderer key. */
		const MARKDOWN_LINK_RULE_ID = "markdown-link";
		/** List-slot entry id for the hidden paste interceptor component. */
		const PASTE_ANCHOR_ENTRY_ID = "markdown-link-paste";
		/** Root-scoped UI text slot that renders the resident composer card. */
		const COMPOSER_OVERLAY_SLOT = "conversation.input.overlay";
		/** Session-scoped keyed slot that renders one user-text JSON node. */
		const USER_TEXT_NODE_SLOT = "conversation.user.text.node";
		//#endregion

		//#region styles
		/** Style tag owner id; @deepseek-ai/dsh-client-modules removes it on unload. */
		const STYLE_TAG_ID = `${PLUGIN_ID}/markdown-link.css`;
		const STYLE_CLASS = {
			root: "dsh-mdlink",
			icon: "dsh-mdlink-icon",
			label: "dsh-mdlink-label"
		};
		const STYLES = [
			`.${STYLE_CLASS.root}{color:inherit;text-decoration:none;white-space:normal;overflow-wrap:anywhere}`,
			`a.${STYLE_CLASS.root}:hover .${STYLE_CLASS.label}{text-decoration-color:currentColor}`,
			`.${STYLE_CLASS.icon}{width:14px;min-width:14px;height:14px;margin-right:4px;vertical-align:-2px;opacity:.8}`,
			`.${STYLE_CLASS.label}{text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 45%,transparent);text-underline-offset:2px}`
		].join("");
		/**
		 * Inject the plugin stylesheet once. Tags created inside the module
		 * factory are claimed by the loader as owned styles (data-plugin) and
		 * removed when the plugin unloads.
		 */
		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = PLUGIN_ID;
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = STYLES;
			document.head.appendChild(tag);
		}
		installStyles();
		//#endregion

		//#region link / markdown helpers
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
		/** Read the pasted URL from ClipboardData, or undefined when this paste is not one. */
		function pastedUrl(clipboardData) {
			if (clipboardData === null || clipboardData === undefined) return undefined;
			const items = Array.from(clipboardData.items ?? []);
			// Never steal image/file pastes: DSH's own PASTE_COMMAND path handles them.
			if (items.some((item) => item.kind === "file")) return undefined;
			const read = (type) => {
				try {
					return clipboardData.getData(type) ?? "";
				} catch {
					return "";
				}
			};
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
		const MARKDOWN_LINK_RE = /\[([^\[\]\n]*)\]\((<[^>\n]*>|https?:\/\/[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*|mailto:[^\s()<>]+)\)/gu;
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
				url
			};
		}
		//#endregion

		//#region composer input helpers
		/**
		 * The editor's detect-projection text, rebuilt from the public InputState
		 * (clipboard projection + chip occurrences). The evaluator/editor maps
		 * selections onto this projection; a chip occupies one U+FFFC there.
		 */
		function detectTextOf(inputState) {
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
		}
		/** The Lexical contenteditable root inside one composer card. */
		function editorRootOf(card) {
			// `data-composer-input` is set by ComposerContentEditable on the element
			// that becomes the Lexical root element; `data-lexical-editor="true"` is
			// Lexical's own attribute on that same element. Prefer the DSH-owned one
			// and fall back to Lexical's in case the composer markup changes.
			return card.querySelector("[data-composer-input]") ?? card.querySelector('[data-lexical-editor="true"]');
		}
		/**
		 * Handle one capture-phase paste. Uses only public APIs:
		 * `useInput` state for the draft/phase, `inputActions.captureInsertion()`
		 * for the revision-guarded span, `inputActions.insertText()` for the edit.
		 * @param event - the DOM paste event.
		 * @param host - hidden anchor element rendered inside the composer card.
		 * @param stateRef - ref holding the latest InputState (or undefined).
		 * @param actionsRef - ref holding the latest InputActions (or undefined).
		 */
		function handlePaste(event, host, stateRef, actionsRef) {
			if (event.defaultPrevented) return;
			if (host === null || host === undefined) return;
			const card = host.closest('[data-composer-card]');
			if (card === null) return;
			const target = event.target;
			if (!(target instanceof Element) || !card.contains(target)) return;
			const editor = editorRootOf(card);
			if (editor === null || !editor.contains(target)) return;
			if (editor.getAttribute("contenteditable") === "false") return;
			const actions = actionsRef.current;
			const inputState = stateRef.current;
			if (actions === undefined || inputState === undefined) return;
			// Submit/adjudication phases lock the editor; leave the paste to DSH.
			// A claimed slash-command chip still permits edits, so only the locked
			// phases fall through to DSH's own paste handling.
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
			// Insert FIRST: if the public action refuses (locked editor or changed
			// draft revision) the plain-text browser paste still happens.
			if (!actions.insertText(markdown, span)) return;
			event.preventDefault();
			event.stopPropagation();
		}
		/**
		 * Null-rendering paste interceptor, registered in
		 * `conversation.input.overlay` (list, session scope). The framework
		 * standard kit gives it `useInput` and `inputActions`; the hidden span is
		 * only a DOM handle for "which composer card does this instance own".
		 */
		function MarkdownLinkPaste(props) {
			const inputActions = props.inputActions;
			// Standard session hook from ctx.uiSession.provide (conversation package).
			const input = props.useInput((state) => state);
			const hostRef = React.useRef(null);
			const stateRef = React.useRef(input);
			const actionsRef = React.useRef(inputActions);
			stateRef.current = input;
			actionsRef.current = inputActions;
			React.useEffect(() => {
				const listener = (event) => {
					handlePaste(event, hostRef.current, stateRef, actionsRef);
				};
				document.addEventListener("paste", listener, true);
				return () => {
					document.removeEventListener("paste", listener, true);
				};
			}, []);
			return React.createElement("span", {
				ref: hostRef,
				hidden: true,
				"data-dsh-mdlink-anchor": ""
			});
		}
		//#endregion

		//#region user-text rule and node renderer
		/**
		 * User-text rule: find the next inline link in original user text.
		 * Contract (dsh-client-ui-conversation/src/client/contract/user-text.ts):
		 * `match(text, from, context)` returns ONE nonempty node at/after `from`
		 * whose id equals the rule id, or undefined. Rules are ordered by
		 * ascending `order`; the earliest start wins across rules.
		 */
		const MARKDOWN_LINK_RULE = {
			id: MARKDOWN_LINK_RULE_ID,
			order: 500,
			match(text, from) {
				const found = nextMarkdownLink(text, from);
				if (found === undefined) return undefined;
				return {
					id: MARKDOWN_LINK_RULE_ID,
					start: found.start,
					end: found.end,
					data: {
						label: found.label,
						url: found.url
					}
				};
			}
		};
		/**
		 * Keyed node renderer for `conversation.user.text.node` under key
		 * `markdown-link`: site/brand icon + label. Receives
		 * `{ node, raw, interactive }`; `interactive` is true in a sent user
		 * message bubble and false in queue previews.
		 */
		function MarkdownLinkNode(props) {
			const node = props.node;
			const data = node !== null && node !== undefined && typeof node.data === "object" && node.data !== null ? node.data : {};
			const raw = typeof props.raw === "string" ? props.raw : "";
			const url = normalizeLinkUrl(data.url);
			if (url === undefined) return React.createElement(primitives.UserTextRun, { text: raw });
			const label = typeof data.label === "string" && data.label !== "" ? data.label : url;
			const icon = React.createElement(primitives.LinkIconMedium, {
				kind: "url",
				href: url,
				size: 14,
				className: STYLE_CLASS.icon
			});
			const text = React.createElement("span", { className: STYLE_CLASS.label, title: url }, label);
			if (props.interactive !== true) {
				return React.createElement("span", { className: STYLE_CLASS.root, title: raw }, icon, text);
			}
			// Same external-link behavior as assistant Markdown without a
			// MarkdownDelegateProvider: a new-window anchor the host shell handles.
			return React.createElement("a", {
				className: STYLE_CLASS.root,
				href: url,
				target: "_blank",
				rel: "noopener noreferrer",
				title: raw
			}, icon, text);
		}
		//#endregion

		//#region cordis client plugin
		/** Required client services: the slot registry and the conversation registries. */
		const inject = ["slots", "uiConversation"];
		/**
		 * Register the user-text rule and both slot contributions.
		 * @param ctx - the client root Cordis context.
		 */
		function apply(ctx) {
			// User-text rule: owned by this plugin fiber via the registry's
			// caller-context effect (removed automatically on unload).
			ctx.uiConversation.userText.register(MARKDOWN_LINK_RULE);
			// Renderer for the rule's JSON nodes. `slots.inject` waits for the Slot
			// Factory declaration and re-runs if the declaring plugin reloads.
			ctx.slots.inject(USER_TEXT_NODE_SLOT, () => ctx.slots.register({
				name: USER_TEXT_NODE_SLOT,
				key: MARKDOWN_LINK_RULE_ID,
				priority: 100
			}, MarkdownLinkNode));
			// Paste interceptor anchor in the resident composer card.
			ctx.slots.inject(COMPOSER_OVERLAY_SLOT, () => ctx.slots.register({
				name: COMPOSER_OVERLAY_SLOT,
				id: PASTE_ANCHOR_ENTRY_ID,
				order: 100
			}, MarkdownLinkPaste));
		}
		//#endregion

		exports.name = "markdown-link";
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
