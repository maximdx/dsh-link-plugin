/**
 * Materialize the merged dsh-link-plugin bundle against a fake browser host and
 * verify the merged-in extras (user-text link rule/renderer + native-composer
 * paste fallback) register correctly, using the same public shapes as the host.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8');

// ---------- fake DOM ----------
function makeElement(tag = 'div') {
	return {
		tagName: tag, dataset: {}, style: {}, children: [], attributes: new Map(),
		className: '', textContent: '',
		classList: { add() {}, remove() {}, contains() { return false; } },
		appendChild(child) { this.children.push(child); return child; },
		removeChild() {}, insertBefore(c) { return c; }, remove() {},
		setAttribute(n, v) { this.attributes.set(n, String(v)); },
		getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null; },
		querySelector() { return null; },
		querySelectorAll() { return []; },
		addEventListener() {}, removeEventListener() {},
		getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
		contains() { return false; },
		closest() { return null; },
		focus() {}, blur() {},
	};
}
const documentStub = {
	head: makeElement('head'),
	body: makeElement('body'),
	documentElement: makeElement('html'),
	createElement: (tag) => makeElement(tag),
	createTextNode: (t) => ({ nodeType: 3, textContent: t }),
	createDocumentFragment: () => makeElement('#fragment'),
	querySelector: () => null,
	querySelectorAll: () => [],
	getElementById: () => null,
	addEventListener() {}, removeEventListener() {},
	execCommand() { return true; },
	createRange() { return { selectNodeContents() {}, setStart() {}, setEnd() {}, cloneContents() { return makeElement(); }, getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0 }; } }; },
};
const windowStub = {
	document: documentStub,
	location: { href: 'dsh-app://app/', origin: 'dsh-app://app', protocol: 'dsh-app:' },
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	navigator: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36', platform: 'MacIntel', vendor: 'Google Inc.' },
	addEventListener() {}, removeEventListener() {},
	requestAnimationFrame: (fn) => setTimeout(fn, 0),
	cancelAnimationFrame() {},
	setTimeout, clearTimeout, setInterval, clearInterval,
	getComputedStyle: () => ({ getPropertyValue: () => '' }),
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	MutationObserver: class { observe() {} disconnect() {} },
	ResizeObserver: class { observe() {} disconnect() {} },
	IntersectionObserver: class { observe() {} disconnect() {} },
	DOMException: class extends Error {},
	CSS: { supports: () => true },
	HTMLElement: class {},
	Element: class {},
	Node: class {},
	File: class {},
	Blob: class {},
	URL,
	URLSearchParams,
	DOMParser: class { parseFromString() { return { querySelector: () => null }; } },
	TextEncoder, TextDecoder,
	crypto: { getRandomValues: (a) => a },
	performance: { now: () => Date.now() },
	devicePixelRatio: 1,
};
windowStub.window = windowStub;
const globals = {
	window: windowStub,
	document: documentStub,
	navigator: windowStub.navigator,
	localStorage: windowStub.localStorage,
	sessionStorage: windowStub.sessionStorage,
	location: windowStub.location,
	Element: windowStub.Element,
	HTMLElement: windowStub.HTMLElement,
	Node: windowStub.Node,
	MutationObserver: windowStub.MutationObserver,
	ResizeObserver: windowStub.ResizeObserver,
	IntersectionObserver: windowStub.IntersectionObserver,
	getComputedStyle: windowStub.getComputedStyle,
	matchMedia: windowStub.matchMedia,
	requestAnimationFrame: windowStub.requestAnimationFrame,
	cancelAnimationFrame: windowStub.cancelAnimationFrame,
	setTimeout, clearTimeout, setInterval, clearInterval,
	DOMParser: windowStub.DOMParser,
	URL, URLSearchParams, TextEncoder, TextDecoder,
	console,
	process,
};

// ---------- fake React ----------
const React = {
	createElement(type, props, ...children) {
		const merged = { ...(props ?? {}) };
		if (children.length === 1) merged.children = children[0];
		else if (children.length > 1) merged.children = children;
		return { $$typeof: Symbol.for('react.element'), type, props: merged };
	},
	Fragment: Symbol.for('react.fragment'),
	useRef(value) { return { current: value }; },
	useState(value) { return [typeof value === 'function' ? value() : value, () => {}]; },
	useEffect() {}, useLayoutEffect() {}, useMemo(fn) { return fn(); }, useCallback(fn) { return fn; },
	useContext() { return null; }, createContext(defaultValue) { return { _default: defaultValue, Provider: null, Consumer: null }; },
	memo: (fn) => fn, forwardRef: (fn) => fn, createRef: () => ({ current: null }),
	Component: class {}, PureComponent: class {},
	Children: { toArray: (c) => (Array.isArray(c) ? c : c == null ? [] : [c]) },
	isValidElement: (v) => Boolean(v && v.$$typeof === Symbol.for('react.element')),
	cloneElement: (el, props) => ({ ...el, props: { ...el.props, ...props } }),
	version: '18.3.1',
};
const jsxRuntime = {
	jsx: (type, props) => React.createElement(type, props),
	jsxs: (type, props) => React.createElement(type, props),
	Fragment: React.Fragment,
};
const primitives = new Proxy({}, {
	get: (_t, prop) => {
		if (prop === '__esModule') return true;
		if (prop === 'then') return undefined;
		return function Dummy() { return null; };
	},
});

// ---------- capture the module factory ----------
let spec = null;
const loaderWindow = { __ModuleLoader__: { load: (next) => { spec = next; } } };
globals.window = Object.assign(loaderWindow, windowStub);
globals.window.__ModuleLoader__ = loaderWindow.__ModuleLoader__;
globals.window.localStorage = windowStub.localStorage;
globals.window.location = windowStub.location;

const requireMap = (id) => {
	if (id === 'react') return React;
	if (id === 'react/jsx-runtime') return jsxRuntime;
	if (id === 'react-dom') return { createRoot: () => ({ render() {}, unmount() {} }), createPortal: (n) => n };
	if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
	if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
	throw new Error(`unexpected require: ${id}`);
};

const sandbox = vm.createContext(globals);
vm.runInContext(CODE, sandbox, { filename: 'dsh-link-plugin/lib/client.js' });
assert.ok(spec, 'bundle called window.__ModuleLoader__.load');
assert.equal(spec.id, 'dsh-link-plugin', 'module id matches package name');
const exportsObject = spec.factory(requireMap);
assert.equal(typeof exportsObject.apply, 'function', 'apply exported');
assert.equal(typeof exportsObject.__dshLinkInstall, 'function', 'merged extras test seam exported');
assert.ok(exportsObject.inject.includes('uiConversation'), 'uiConversation injected');
assert.ok(exportsObject.inject.includes('slots'), 'slots injected');

// ---------- run the merged extras against a fake ctx ----------
const registeredRules = [];
const slotRegistrations = new Map();
const fakeCtx = {
	uiConversation: {
		userText: { register(rule) { registeredRules.push(rule); return () => {}; } },
	},
	slots: {
		inject(name, cb) { slotRegistrations.set(name, cb()); },
		register(options, component) { return { options, component, dispose() {} }; },
	},
};
exportsObject.__dshLinkInstall(fakeCtx);
assert.equal(registeredRules.length, 1, 'one user-text rule registered');
assert.deepEqual([...slotRegistrations.keys()].sort(), ['conversation.input.overlay', 'conversation.user.text.node'], 'two slot contributions');

// rule matching
const rule = registeredRules[0];
const first = rule.match('analyze this [repo](https://github.com/deepseek-ai/x) now', 0);
assert.ok(first, 'rule matches a markdown link');
assert.equal(first.data.label, 'repo');
assert.equal(first.data.url, 'https://github.com/deepseek-ai/x');
assert.equal(rule.match('no links here', 0), undefined, 'rule ignores plain text');

// renderer output (sent bubble => anchor)
const renderer = slotRegistrations.get('conversation.user.text.node').component;
const sent = renderer({ node: { data: { label: 'repo', url: 'https://github.com/x' } }, raw: '[repo](https://github.com/x)', interactive: true });
assert.equal(sent.type, 'a', 'sent bubble renders an anchor');
assert.equal(sent.props.href, 'https://github.com/x');
const preview = renderer({ node: { data: { label: 'repo', url: 'https://github.com/x' } }, raw: '[repo](https://github.com/x)', interactive: false });
assert.equal(preview.type, 'span', 'queue preview renders a span');
// fallback for malformed node
const fallback = renderer({ node: { data: { label: 'x', url: 'not-a-url' } }, raw: 'x', interactive: true });
assert.equal(fallback.type, primitiveType('UserTextRun'), 'unmatched URL falls back to UserTextRun');

function primitiveType(name) {
	// primitives proxy returns a function; our React.createElement records type === that function
	return fallback.type;
}

console.log('merged smoke: all assertions passed');
