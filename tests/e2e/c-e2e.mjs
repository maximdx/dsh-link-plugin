// End-to-end acceptance for the hardened link-only variant C (0.3.0).
// Covers: boot row + console contract, paste-URL-over-selection -> Markdown link,
// sent-bubble rendered link, unknown-host generic icon, non-URL native paste.
// Usage: node c-e2e.mjs --url '<token url>' [--out /tmp/e2e/variants/c-hardened] [--server-log path]
import { connect } from './cdp.mjs';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const URL_ = opt('url');
const OUT = opt('out', '/tmp/e2e/variants/c-hardened');
const SERVER_LOG = opt('server-log', null);
const GITHUB_URL = 'https://github.com/foo/bar';
const EXAMPLE_URL = 'https://example.org/x';
const TYPED = 'hello repo world';
mkdirSync(OUT, { recursive: true });

const res = {
  variant: 'c-hardened',
  url: URL_,
  startedAt: new Date().toISOString(),
  release: null,
  boot: {},
  serverLog: {},
  overlayProbe: {},
  console: { count: 0, pluginLines: [], warnings: [], errors: [], exceptions: [], all: [] },
  tests: {},
  checks: {},
  artifacts: {},
  verdict: null,
};

const { cdp } = await connect(9311);
const events = [];
cdp.on('Runtime.consoleAPICalled', (p) => {
  const text = p.args.map((a) => a.value !== undefined ? String(a.value) : a.unserializableValue ?? a.description ?? JSON.stringify(a.preview ?? '')).join(' ');
  events.push({ kind: 'console', type: p.type, text });
});
cdp.on('Runtime.exceptionThrown', (p) => {
  const d = p.exceptionDetails || {};
  events.push({ kind: 'exception', text: d.exception?.description || d.text, url: d.url, line: d.lineNumber });
});
cdp.on('Log.entryAdded', (p) => {
  const e = p.entry || {};
  events.push({ kind: 'log', level: e.level, source: e.source, text: e.text, url: e.url });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (expr) => cdp.evaluate(expr);
const shot = async (name, clip) => {
  const p = `${OUT}/${name}`;
  await cdp.screenshot(p, clip ? { clip } : {});
  res.artifacts[name] = p;
  return p;
};

// ---- boot ---------------------------------------------------------------
await cdp.send('Page.navigate', { url: URL_ });
await cdp.waitFor('document.readyState === "complete"', { timeout: 30000, label: 'readyState' });
await cdp.waitFor('document.body && document.body.innerText.length > 0', { timeout: 30000, label: 'body' });
const bootRaw = JSON.parse(await cdp.waitFor('window.__DSH_BOOT__ && JSON.stringify(window.__DSH_BOOT__)', { timeout: 30000, label: '__DSH_BOOT__' }));
res.release = bootRaw.release;
const entries = bootRaw.entries;
const rows = Array.isArray(entries) ? entries.filter((e) => e && e.id === 'dsh-link-plugin') : [];
res.boot = {
  entriesShape: Array.isArray(entries) ? `array(${entries.length})` : Object.prototype.toString.call(entries),
  entryKeys: entries?.[0] ? Object.keys(entries[0]) : [],
  linkPluginRows: rows,
  hasPluginRow: rows.length > 0,
  total: entries?.length ?? null,
};
await sleep(800); // let plugin effects + console.info run
await shot('00-boot.png');

// ---- overlay mount probe (runs before any typing) -----------------------
res.overlayProbe = await ev(`(() => {
  const card = document.querySelector('[data-composer-card]');
  const overlaySlot = document.querySelector('[data-composer-card] [data-slot="conversation.input.overlay"]');
  const anchors = [...document.querySelectorAll('[data-composer-card] [data-dsh-link-anchor]')];
  const editors = [...document.querySelectorAll('[data-composer-card] [contenteditable]')].map((e) => ({
    tag: e.tagName, cls: String(e.className).slice(0, 60), dataComposerInput: e.getAttribute('data-composer-input'),
  }));
  const overlayEntryIds = overlaySlot ? [...overlaySlot.children].map((c) => ({ tag: c.tagName, hidden: c.hidden, attrs: [...c.attributes].map((a) => a.name + '=' + String(a.value).slice(0, 40)) })) : null;
  return {
    composerCard: !!card,
    overlaySlotInCard: !!overlaySlot,
    overlaySlotChildren: overlayEntryIds,
    anchorCount: anchors.length,
    anchor: anchors[0] ? { tag: anchors[0].tagName, hidden: anchors[0].hidden, attrs: [...anchors[0].attributes].map((a) => a.name + '=' + String(a.value).slice(0, 40)) } : null,
    editors,
    cmEditors: document.querySelectorAll('.cm-editor').length,
  };
})()`);
await shot('00b-overlay-probe.png');

// ---- helpers -------------------------------------------------------------
const EDITOR_SEL = '[data-composer-input]';
async function dismissAllDialogs(maxRounds = 8) {
  const clicked = [];
  for (let i = 0; i < maxRounds; i++) {
    const hit = await ev(`(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const buttons = [...document.querySelectorAll('button,[role=button]')].filter(visible);
      const byText = (re) => buttons.find((b) => re.test((b.innerText || '').trim()));
      const b = byText(/^Continue$/i) || byText(/^Close$/i) || byText(/^Skip$/i) || byText(/^Got it$/i);
      if (b) { b.click(); return (b.innerText || '').trim() || 'x'; }
      const dlg = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(visible)[0];
      if (dlg) {
        const x = [...dlg.querySelectorAll('button')].find((q) => /close/i.test(q.getAttribute('aria-label') || ''));
        if (x) { x.click(); return 'dialog-x'; }
      }
      return null;
    })()`).catch(() => null);
    if (!hit) break;
    clicked.push(hit);
    await sleep(500);
  }
  return clicked;
}
async function clickEditor() {
  const rect = await ev(`(() => { const el = document.querySelector(${JSON.stringify(EDITOR_SEL)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 20) }; })()`);
  if (!rect) throw new Error('composer not found');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(200);
}
async function readComposer() {
  return ev(`(() => {
    const el = document.querySelector('[data-composer-input]');
    const sendBtn = document.querySelector('button[aria-label="Send message"]');
    return { text: el ? el.innerText : null, html: el ? el.innerHTML.slice(0, 600) : null, sendDisabled: sendBtn ? sendBtn.disabled : null, phase: el ? el.getAttribute('data-phase') : null };
  })()`);
}
async function clearComposer() {
  const t = (await readComposer()).text;
  if (!t) return { cleared: false, before: t };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 0, modifiers: 4, commands: ['SelectAll'] });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 0, modifiers: 4, commands: ['SelectAll'] });
  await sleep(100);
  if ((await readComposer()).text !== '') {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await sleep(150);
  }
  return { cleared: true, before: t, after: (await readComposer()).text };
}
async function typeText(text) {
  await cdp.send('Input.insertText', { text });
  await sleep(350);
  return readComposer();
}
async function selectWord(word) {
  return ev(`(() => {
    const el = document.querySelector(${JSON.stringify(EDITOR_SEL)});
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = []; let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const tn of nodes) {
      const i = tn.data.indexOf(${JSON.stringify(word)});
      if (i >= 0) {
        const range = document.createRange();
        range.setStart(tn, i); range.setEnd(tn, i + ${word.length});
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        el.focus();
        return { ok: true, selected: String(sel), nodeData: tn.data };
      }
    }
    return { ok: false, nodes: nodes.map((x) => x.data), html: el.innerHTML.slice(0, 400) };
  })()`);
}
async function dispatchPaste(text) {
  return ev(`(() => {
    const el = document.querySelector(${JSON.stringify(EDITOR_SEL)});
    const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    const ret = el.dispatchEvent(e);
    return { dispatchReturn: ret, defaultPrevented: e.defaultPrevented, sel: String(window.getSelection()) };
  })()`);
}
async function pressEnter() {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}
async function userBubbleCount() { return ev('document.querySelectorAll("[data-chat-flow-kind=user]").length'); }
async function lastBubbleInfo() {
  return ev(`(() => {
    const nodes = [...document.querySelectorAll('[data-chat-flow-kind=user]')];
    const node = nodes[nodes.length - 1];
    if (!node) return null;
    const bubbleEl = node.querySelector('[class*=bubble]') || node;
    const links = [...node.querySelectorAll('a.dsh-mdlink')];
    const link = links[0];
    return {
      turn: node.getAttribute('data-chat-turn'),
      count: nodes.length,
      bubbleText: bubbleEl.innerText,
      textContent: bubbleEl.textContent,
      rawMarkdown: /\\[[^\\]]+\\]\\(https?:/.test(bubbleEl.textContent || ''),
      mdlinkCount: links.length,
      link: link ? {
        href: link.getAttribute('href'), label: link.innerText, title: link.getAttribute('title'),
        cls: String(link.className), target: link.getAttribute('target'), rel: link.getAttribute('rel'),
        hasSvg: !!link.querySelector('svg'),
        svgClass: link.querySelector('svg')?.getAttribute('class'),
        iconPath: link.querySelector('svg path')?.getAttribute('d')?.slice(0, 60) || null,
        labelSpan: !!link.querySelector('.dsh-mdlink-label'),
      } : null,
    };
  })()`);
}
async function screenshotBubble(name) {
  const rect = await ev(`(() => {
    const nodes = [...document.querySelectorAll('[data-chat-flow-kind=user]')];
    const n = nodes[nodes.length - 1];
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: Math.max(0, r.x - 24), y: Math.max(0, r.y - 12), width: Math.min(1440, r.width + 48), height: Math.min(913, r.height + 24) };
  })()`);
  if (rect) await cdp.screenshot(`${OUT}/${name}`, { clip: { ...rect, scale: 1 } });
  else await cdp.screenshot(`${OUT}/${name}`);
  res.artifacts[name] = `${OUT}/${name}`;
}
async function screenshotComposer(name) {
  const rect = await ev(`(() => {
    const el = document.querySelector('[data-composer-card]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: Math.min(1440, r.width + 20), height: Math.min(913, r.height + 20) };
  })()`);
  if (rect) await cdp.screenshot(`${OUT}/${name}`, { clip: { ...rect, scale: 1 } });
  else await cdp.screenshot(`${OUT}/${name}`);
  res.artifacts[name] = `${OUT}/${name}`;
}
async function sendAndVerify(testKey, expect) {
  const before = await userBubbleCount();
  await pressEnter();
  let bubble = null;
  try {
    await cdp.waitFor(`document.querySelectorAll("[data-chat-flow-kind=user]").length > ${before}`, { timeout: 25000, label: `${testKey} new user bubble` }).catch(async () => {
      await cdp.waitFor('!!document.querySelector("[data-chat-flow-kind=user]")', { timeout: 5000, label: 'bubble' });
    });
    await sleep(600);
    bubble = await lastBubbleInfo();
  } catch (e) { bubble = { error: e.message }; }
  const ok = !!(bubble && bubble.mdlinkCount > 0 && bubble.link && bubble.link.href === expect.href && bubble.link.label === expect.label && bubble.link.hasSvg && bubble.rawMarkdown === false);
  return { bubblesBefore: before, bubble, ok };
}

// ---- run -----------------------------------------------------------------
res.dialogsDismissed = await dismissAllDialogs();
await cdp.waitFor('!!document.querySelector("[data-composer-card] [data-composer-input]")', { timeout: 20000, label: 'composer' });
await clickEditor();
await clearComposer();

// TEST 1: paste known-brand URL over selection -> link -> send -> rendered bubble
{
  const typed = await typeText(TYPED);
  const sel = await selectWord('repo');
  const paste = await dispatchPaste(GITHUB_URL);
  await sleep(450);
  const after = await readComposer();
  const expected = `hello [repo](${GITHUB_URL}) world`;
  const composerOK = after.text === expected;
  await screenshotComposer('01-composer-github.png');
  const send = await sendAndVerify('github', { href: GITHUB_URL, label: 'repo' });
  if (send.bubble) await screenshotBubble('02-bubble-github.png');
  res.tests.github = {
    typed: typed.text, selection: sel, paste, composerExpected: expected, composerActual: after.text,
    composerOK, defaultPrevented: paste.defaultPrevented, ...send,
    pass: composerOK && paste.defaultPrevented === true && send.ok,
  };
}

// TEST 2: unknown host -> generic svg icon, link still renders
{
  await clickEditor();
  await clearComposer();
  const typed = await typeText('see docs page');
  const sel = await selectWord('page');
  const paste = await dispatchPaste(EXAMPLE_URL);
  await sleep(450);
  const after = await readComposer();
  const expected = `see docs [page](${EXAMPLE_URL})`;
  const composerOK = after.text === expected;
  await screenshotComposer('03-composer-example-host.png');
  const send = await sendAndVerify('example', { href: EXAMPLE_URL, label: 'page' });
  if (send.bubble) await screenshotBubble('04-bubble-example-host.png');
  res.tests.exampleHost = {
    typed: typed.text, selection: sel, paste, composerExpected: expected, composerActual: after.text,
    composerOK, defaultPrevented: paste.defaultPrevented, ...send,
    pass: composerOK && paste.defaultPrevented === true && send.ok,
  };
}

// TEST 3: non-URL paste over selection -> plugin must not intercept; native plain paste
{
  await clickEditor();
  await clearComposer();
  const typed = await typeText('plain paste test');
  const sel = await selectWord('paste');
  const paste = await dispatchPaste('hello');
  await sleep(450);
  const after = await readComposer();
  const noBracket = !/[\[\]]/.test(after.text || '');
  const nativeWon = after.text === 'plain hello test';
  await screenshotComposer('05-composer-nonurl-paste.png');
  res.tests.nonUrl = {
    typed: typed.text, selection: sel, paste, composerActual: after.text, expectedNative: 'plain hello test',
    nativeWon, noBracket, defaultPrevented: paste.defaultPrevented,
    // NOTE: defaultPrevented is true here because the HOST (Lexical paste command)
    // preventDefault()s after doing its own plain-text insert; the plugin returns
    // before preventDefault for non-URL pastes. What matters: native plain text won.
    pass: nativeWon && noBracket,
  };
}

// ---- console classification ---------------------------------------------
res.console.count = events.length;
res.console.all = events;
res.console.pluginLines = events.filter((e) => /\[dsh-link-plugin\]/.test(e.text || ''));
res.console.warnings = events.filter((e) => (e.kind === 'console' && (e.type === 'warning' || e.type === 'warn')) || (e.kind === 'log' && e.level === 'warning') || (e.kind === 'log' && e.level === 'error'));
res.console.errors = events.filter((e) => (e.kind === 'console' && (e.type === 'error' || e.type === 'assert')) || e.kind === 'exception' || (e.kind === 'log' && e.level === 'error'));
res.console.exceptions = events.filter((e) => e.kind === 'exception');
writeFileSync(`${OUT}/console.json`, JSON.stringify(res.console, null, 2));
res.artifacts.console = `${OUT}/console.json`;

// ---- server log ----------------------------------------------------------
if (SERVER_LOG && existsSync(SERVER_LOG)) {
  const log = readFileSync(SERVER_LOG, 'utf8');
  res.serverLog = {
    path: SERVER_LOG,
    hasSkipWarning: /skipping profile bundle "dsh-link-plugin"/.test(log),
    skipLine: log.split('\n').find((l) => /skipping profile bundle "dsh-link-plugin"/.test(l)) || null,
    anyIncompatible: /incompatible with dsh/.test(log),
    anyLinkPluginWarn: log.split('\n').filter((l) => /dsh-link-plugin/.test(l) && !/^\[dsh-sidenote\]/.test(l)).slice(0, 5),
  };
}

// ---- checks + verdict ----------------------------------------------------
res.checks = {
  pluginRowInBootEntries: res.boot.hasPluginRow === true,
  noServerSkipWarning: res.serverLog.hasSkipWarning === false,
  noServerIncompatibleLines: res.serverLog.anyIncompatible === false,
  pluginActiveConsoleInfo: res.console.pluginLines.some((e) => /active:/.test(e.text || '') && e.type === 'info'),
  noPluginWarnings: !res.console.warnings.some((e) => /dsh-link-plugin/.test(e.text || '')),
  noExceptions: res.console.exceptions.length === 0,
  overlayAnchorMounted: res.overlayProbe.anchorCount > 0,
  githubComposerLink: res.tests.github.composerOK === true,
  githubPastePrevented: res.tests.github.defaultPrevented === true,
  githubBubbleRendered: res.tests.github.ok === true,
  exampleHostComposerLink: res.tests.exampleHost.composerOK === true,
  exampleHostBubbleRendered: res.tests.exampleHost.ok === true,
  exampleHostGenericIcon: res.tests.exampleHost.bubble?.link?.hasSvg === true,
  nonUrlNativePlainPasteWon: res.tests.nonUrl.nativeWon === true,
  nonUrlNoBrackets: res.tests.nonUrl.noBracket === true,
};
const c = res.checks;
res.verdict = Object.values(c).every(Boolean) ? 'PASS'
  : (c.pluginRowInBootEntries && c.noServerSkipWarning && !c.githubComposerLink && !c.githubBubbleRendered) ? 'FAIL'
  : 'PARTIAL/DEGRADED';
res.finishedAt = new Date().toISOString();
writeFileSync(`${OUT}/result.json`, JSON.stringify(res, null, 2));
cdp.close();
console.log(JSON.stringify({
  variant: res.variant, release: res.release?.version,
  boot: res.boot, overlayProbe: res.overlayProbe,
  serverLog: res.serverLog, console: { count: res.console.count, pluginLines: res.console.pluginLines, warnings: res.console.warnings, errors: res.console.errors, exceptions: res.console.exceptions },
  tests: {
    github: { composerActual: res.tests.github.composerActual, composerOK: res.tests.github.composerOK, defaultPrevented: res.tests.github.defaultPrevented, bubble: res.tests.github.bubble, pass: res.tests.github.pass },
    exampleHost: { composerActual: res.tests.exampleHost.composerActual, composerOK: res.tests.exampleHost.composerOK, defaultPrevented: res.tests.exampleHost.defaultPrevented, bubble: res.tests.exampleHost.bubble, pass: res.tests.exampleHost.pass },
    nonUrl: res.tests.nonUrl,
  },
  checks: c, verdict: res.verdict, artifacts: res.artifacts,
}, null, 2));
