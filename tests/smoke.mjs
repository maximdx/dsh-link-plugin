#!/usr/bin/env node
/**
 * Dependency-free smoke test for lib/client.js.
 *
 * The plugin bundle is a lazy-CJS script (`window.__ModuleLoader__.load(...)`),
 * so this harness emulates just enough of the browser kernel and DSH client
 * context to materialize the factory and exercise the registrations it makes:
 *
 * - the module id / package name contract;
 * - the user-text rule (matching `[label](url)`) and its keyed node renderer;
 * - the `conversation.input.overlay` paste-anchor registration;
 * - the owned stylesheet install/cleanup via ctx.effect;
 * - the upgrade-tolerance invariants (no host client-package imports; every
 *   registration guarded so a missing surface cannot throw out of apply).
 *
 * It cannot simulate Lexical's composer; the real paste + send path is covered
 * by the isolated DSH rc.3 browser test (see README, "Verification").
 *
 * Run: node tests/smoke.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const bundleSource = readFileSync(join(repo, "lib", "client.js"), "utf8");

const failures = [];
const passes = [];
function check(name, condition, detail = "") {
  if (condition) {
    passes.push(name);
  } else {
    failures.push(`${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
}
function normalizeNode(node) {
  // Resolve function components so assertions see real host elements.
  let current = node;
  let guard = 0;
  while (typeof current?.type === "function" && guard < 20) {
    current = current.type(current.props);
    guard += 1;
  }
  return current;
}
function containsText(node, text) {
  const normalized = normalizeNode(node);
  if (normalized === null || normalized === undefined) return false;
  if (typeof normalized === "string") return normalized === text;
  if (Array.isArray(normalized)) return normalized.some((child) => containsText(child, text));
  if (typeof normalized === "object" && normalized.props) {
    if (normalized.props.className === text) return true;
    return containsText(normalized.props.children, text);
  }
  return false;
}
function collectByType(node, type, out = []) {
  const normalized = normalizeNode(node);
  if (normalized === null || normalized === undefined) return out;
  if (Array.isArray(normalized)) {
    for (const child of normalized) collectByType(child, type, out);
    return out;
  }
  if (typeof normalized === "object" && normalized.props) {
    if (normalized.type === type) out.push(normalized);
    collectByType(normalized.props.children, type, out);
  }
  return out;
}

//#region fake React
const FakeReact = {
  createElement(type, props, ...children) {
    const flat = [];
    for (const child of children) {
      if (Array.isArray(child)) flat.push(...child);
      else flat.push(child);
    }
    return { type, props: { ...(props ?? {}), children: flat.length <= 1 ? flat[0] : flat } };
  },
  useRef(initial) {
    return { current: initial };
  },
  useEffect(effect) {
    // The paste listener needs a real DOM; registration shape is enough here.
    return undefined;
  },
};
//#endregion

//#region fake browser + module loader
const loaded = [];
const fakeWindow = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition);
    },
  },
};
new Function("window", bundleSource)(fakeWindow);

check("bundle registers exactly one module", loaded.length === 1, `saw ${loaded.length}`);
const definition = loaded[0] ?? {};
check("module id equals package name", definition.id === "dsh-link-plugin", String(definition.id));
check("module has a factory", typeof definition.factory === "function");

const factory = definition.factory;
const moduleExports = typeof factory === "function" ? factory((specifier) => {
  if (specifier === "react") return FakeReact;
  throw new Error(`smoke: unexpected host require(${JSON.stringify(specifier)})`);
}) : undefined;
//#endregion

//#region fake client context
const styleTags = [];
const fakeDocument = {
  head: {
    appendChild(tag) {
      styleTags.push(tag);
    },
  },
  querySelector() {
    return null;
  },
  createElement() {
    const tag = {
      dataset: {},
      textContent: "",
      remove() {
        const index = styleTags.indexOf(tag);
        if (index >= 0) styleTags.splice(index, 1);
      },
    };
    return tag;
  },
};
const registrations = [];
const userTextRules = [];
const injectedSlots = [];
const effects = [];
function makeCtx(services = {}) {
  const ctx = {
    get(name) {
      if (name === "uiConversation") return services.uiConversation;
      return undefined;
    },
    inject(deps, callback) {
      callback(ctx);
    },
    effect(callback, label) {
      const disposer = callback();
      effects.push({ label, disposer });
      return () => {};
    },
    slots: {
      inject(ownerKey, callback) {
        injectedSlots.push(ownerKey);
        const result = callback();
        registrations.push({ ownerKey, result });
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return { dispose() {} };
      },
    },
  };
  return ctx;
}
const fakeUiConversation = {
  userText: {
    register(rule) {
      userTextRules.push(rule);
    },
  },
};
//#endregion

//#region tests
check("exports a plugin object", moduleExports !== null && typeof moduleExports === "object");
check(
  "plugin injects the slots service only",
  JSON.stringify(moduleExports?.inject) === JSON.stringify(["slots"]),
  JSON.stringify(moduleExports?.inject),
);
check("plugin has an apply function", typeof moduleExports?.apply === "function");

const previousDocument = globalThis.document;
globalThis.document = fakeDocument;
try {
  moduleExports.apply(makeCtx({ uiConversation: fakeUiConversation }));
} finally {
  globalThis.document = previousDocument;
}

// stylesheet ownership
check("apply installs one owned stylesheet", styleTags.length === 1, `saw ${styleTags.length}`);
check(
  "stylesheet has the plugin id data attribute",
  styleTags[0]?.dataset?.dshPlugin === "dsh-link-plugin",
  JSON.stringify(styleTags[0]?.dataset),
);
check("stylesheet content includes the link classes", String(styleTags[0]?.textContent).includes(".dsh-mdlink"));
check("style cleanup is owned by ctx.effect", effects.some((entry) => String(entry.label).includes("styles")));

// user-text rule
check("registers exactly one user-text rule", userTextRules.length === 1, `saw ${userTextRules.length}`);
const rule = userTextRules[0] ?? {};
check("rule id is markdown-link", rule.id === "markdown-link", String(rule.id));
check("rule order is a finite number", Number.isFinite(rule.order), String(rule.order));
const matched = rule.match?.("see [repo](https://github.com/foo/bar) now", 0);
check(
  "rule matches an inline Markdown link",
  matched?.id === "markdown-link" &&
    matched?.start === 4 &&
    matched?.end === 4 + "[repo](https://github.com/foo/bar)".length &&
    matched?.data?.label === "repo" &&
    matched?.data?.url === "https://github.com/foo/bar",
  JSON.stringify(matched),
);
check("rule ignores plain text", rule.match?.("no link here", 0) === undefined);
check("rule ignores non-http destinations", rule.match?.("[x](ftp://example.com/a)", 0) === undefined);
check("rule matches mailto", rule.match?.("[mail](mailto:a@b.co)", 0)?.data?.url === "mailto:a@b.co");
check(
  "rule unescapes label brackets",
  rule.match?.("[a\\[b\\]](https://example.com)", 0)?.data?.label === "a[b]",
  JSON.stringify(rule.match?.("[a\\[b\\]](https://example.com)", 0)),
);

// slot registrations
const overlayRegistration = registrations.find(
  (entry) => entry.options?.name === "conversation.input.overlay",
);
check("registers a conversation.input.overlay entry", overlayRegistration !== undefined);
check(
  "overlay entry has the paste id",
  overlayRegistration?.options?.id === "markdown-link-paste",
  JSON.stringify(overlayRegistration?.options),
);
check("overlay entry has a component", typeof overlayRegistration?.component === "function");
const nodeRegistration = registrations.find(
  (entry) => entry.options?.name === "conversation.user.text.node",
);
check("registers a conversation.user.text.node renderer", nodeRegistration !== undefined);
check(
  "node renderer is keyed by the rule id",
  nodeRegistration?.options?.key === "markdown-link",
  JSON.stringify(nodeRegistration?.options),
);
check("node renderer has a component", typeof nodeRegistration?.component === "function");

// renderer output
const interactive = nodeRegistration?.component?.({
  node: { id: "markdown-link", start: 0, end: 20, data: { label: "repo", url: "https://github.com/foo/bar" } },
  raw: "[repo](https://github.com/foo/bar)",
  interactive: true,
});
check("interactive renderer returns an anchor", interactive?.type === "a", String(interactive?.type));
check("anchor href is the link destination", interactive?.props?.href === "https://github.com/foo/bar");
check("anchor opens outside the app", interactive?.props?.target === "_blank");
check("anchor renders the label", containsText(interactive, "dsh-mdlink-label"));
check("anchor renders an inline icon svg", collectByType(interactive, "svg").length === 1);
const brandSvg = collectByType(interactive, "svg")[0];
check(
  "github href uses the brand glyph path",
  brandSvg?.props?.children?.props?.d?.startsWith("M12 .297c-6.63") === true,
  String(brandSvg?.props?.children?.props?.d).slice(0, 40),
);
const nonInteractive = nodeRegistration?.component?.({
  node: { id: "markdown-link", data: { label: "repo", url: "https://example.org/x" } },
  raw: "[repo](https://example.org/x)",
  interactive: false,
});
check("non-interactive renderer returns a span", nonInteractive?.type === "span", String(nonInteractive?.type));
check("non-interactive span does not navigate", nonInteractive?.props?.href === undefined);
const fallback = nodeRegistration?.component?.({
  node: { id: "markdown-link", data: { label: "x", url: "javascript:alert(1)" } },
  raw: "[x](javascript:alert(1))",
  interactive: true,
});
check("invalid destination degrades to plain text", fallback?.type === "span", String(fallback?.type));
check("fallback keeps the raw slice", fallback?.props?.children === "[x](javascript:alert(1))");

// upgrade-tolerance invariants
const hostRequires = [...bundleSource.matchAll(/require\(\s*["'](@deepseek-ai\/[^"']+)["']\s*\)/gu)].map(
  (match) => match[1],
);
check("bundle imports no host client packages", hostRequires.length === 0, hostRequires.join(", "));
const requires = [...bundleSource.matchAll(/require\(\s*["']([^"']+)["']\s*\)/gu)].map((match) => match[1]);
check(
  "bundle imports only React from the module table",
  requires.length === 1 && requires[0] === "react",
  requires.join(", "),
);
check("manifest declares no dsh version pin", !/engines\.dsh|"dsh":\s*"0\./u.test(readFileSync(join(repo, "package.json"), "utf8")));
check("manifest client inject list is empty", JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).dsh.client.inject.length === 0);
//#endregion

if (failures.length > 0) {
  console.error(`smoke: ${failures.length} failure(s), ${passes.length} pass(es)`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`smoke: all ${passes.length} checks passed`);
}
