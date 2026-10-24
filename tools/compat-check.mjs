#!/usr/bin/env node
/**
 * dsh-link-plugin -- DSH compatibility checker (post-upgrade verification).
 *
 * The DSH desktop app auto-upgrades. A plugin manifests `engines.dsh` that
 * pins an exact host version makes DSH's compatibility preflight skip the
 * whole bundle on the next upgrade -- silently. This script is the durable
 * tripwire: it reads the *installed* app.asar (no npm installs, no OS tools),
 * resolves the real DSH runtime version, validates the plugin manifest and
 * the thin host extension surface the plugin relies on, and compares the live
 * profile copy against this repo.
 *
 * Usage:
 *   node tools/compat-check.mjs
 *   node tools/compat-check.mjs --app "/Applications/DeepSeek Harness.app" --plugin . --profile-dir ~/.dsh/profiles/desktop
 *   node tools/compat-check.mjs --host-modules /path/to/dsh/node_modules   # npm/source install
 *   node tools/compat-check.mjs --json
 *
 * Options:
 *   --app <path>          DSH app bundle (or its app.asar). Default: $DSH_APP or
 *                         "/Applications/DeepSeek Harness.app".
 *   --host-modules <dir>  Verify against an npm/source install: path to that
 *                         install's `dsh/node_modules` directory.
 *   --plugin <dir>        Plugin package root. Default: this repository.
 *   --profile-dir <dir>   DSH profile whose installed copy is compared against
 *                         this repo. Default: $DSH_PROFILE_DIR, else
 *                         $DSH_HOME/profiles/desktop, else ~/.dsh/profiles/desktop.
 *                         Pass `none` to skip the live-install check.
 *   --json                Print one JSON object with the same data.
 *   -h, --help            Show this help.
 *
 * Exit codes: 0 = PASS or DEGRADED (warnings only), 1 = FAIL.
 *
 * Dependency-free (Node >= 20, ESM). Write scope: tools/ only.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isBuiltin } from 'node:module'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const DEFAULT_APP = process.env.DSH_APP || '/Applications/DeepSeek Harness.app'
const DEFAULT_DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DEFAULT_PROFILE_DIR =
  process.env.DSH_PROFILE_DIR || path.join(DEFAULT_DSH_HOME, 'profiles', 'desktop')

/** Inside app.asar the DSH tree lives under `dsh/`. */
const HOST_NODE_MODULES = 'dsh/node_modules'
const HOST_SCOPED_PKGS = 'dsh/node_modules/@deepseek-ai'
const APP_BOOT_PKG = '@deepseek-ai/dsh-app-boot/package.json'

/** Do not buffer more than this much host JS while scanning for surfaces. */
const MAX_SCAN_BYTES = 80 * 1024 * 1024

/**
 * Host extension surface the plugin's browser half depends on. Everything
 * here is owned by DSH, so a release can rename/remove it; each entry is
 * checked as a plain string against the installed host bundles (the bundles
 * are minified, so exact strings are the stable signal that the API exists).
 *
 * `feature` names what degrades if the string is missing:
 *   paste-link          -- composer paste-URL-as-inline-Markdown-link
 *   sent-link-rendering -- brand-icon + underline rendering of sent links
 */
const REQUIRED_SURFACES = [
  {
    needle: 'conversation.input.overlay',
    feature: 'paste-link',
    degrade: 'conversation.input.overlay is gone: the plugin can no longer register its composer overlay',
  },
  {
    needle: 'conversation.user.text.node',
    feature: 'sent-link-rendering',
    degrade: 'conversation.user.text.node is gone: sent user-message links can no longer be rendered',
  },
  {
    needle: 'uiConversation.userText.register',
    feature: 'sent-link-rendering',
    degrade: 'uiConversation.userText.register is gone: the sent-link Markdown rule cannot be registered',
  },
  {
    needle: 'captureInsertion',
    feature: 'paste-link',
    degrade: 'captureInsertion is gone: the paste fallback cannot capture/insert composer text',
  },
  {
    needle: 'insertText',
    feature: 'paste-link',
    degrade: 'insertText is gone: the paste path cannot insert the Markdown link text',
  },
  {
    needle: 'data-composer-input',
    feature: 'paste-link',
    degrade: 'data-composer-input is gone: paste interception cannot locate the native composer input',
  },
  {
    needle: 'data-composer-card',
    feature: 'paste-link',
    degrade: 'data-composer-card is gone: the overlay cannot anchor to the composer card',
  },
  {
    needle: '"plain"',
    feature: 'paste-link',
    degrade: 'input phase literal "plain" is gone: paste-claim gating logic cannot run',
  },
  {
    needle: '"claimed"',
    feature: 'paste-link',
    degrade: 'input phase literal "claimed" is gone: claimed-phase filtering cannot run',
  },
]

/**
 * Runtime imports the plugin host is expected to provide (seed words + the
 * host packages that may be declared in `dsh.client.inject`). The target
 * design is ZERO `@deepseek-ai` host imports; anything outside this list is a
 * hard failure, and any `@deepseek-ai` import is at least a warning.
 */
const SEED_ALLOWED_IMPORTS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const HOME = os.homedir()
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const STATUS_COLOR = { PASS: 32, OK: 32, WARN: 33, FAIL: 31, MISSING: 31 }

function fmtStatus(status) {
  return paint(STATUS_COLOR[status] || 0, status.padEnd(7))
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** Shorten a path for display. JSON output keeps the full path. */
function prettyPath(p) {
  if (!p) return ''
  const abs = path.resolve(p)
  if (abs === HOME || abs.startsWith(HOME + path.sep)) return '~' + abs.slice(HOME.length)
  const repo = REPO_ROOT
  if (abs === repo) return '<repo>'
  if (abs.startsWith(repo + path.sep)) {
    return '<repo>/' + path.relative(repo, abs).split(path.sep).join('/')
  }
  return abs
}

function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return HOME
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2))
  return p
}

function sha256File(absPath) {
  try {
    return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex')
  } catch {
    return null
  }
}


// ---------------------------------------------------------------------------
// Semver: parser, comparator, mini range evaluator
// (dependency-free; enough for plugin-manifest `engines.dsh` ranges)
// ---------------------------------------------------------------------------

const NUM = '\\d+'
const PRE = '[0-9A-Za-z.-]+'

/** Parse a full semver version (x.y.z[-pre][+build]); null if invalid. */
function parseSemver(input) {
  if (typeof input !== 'string') return null
  const m = new RegExp(
    `^\\s*v?(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE}))?(?:\\+${PRE})?\\s*$`,
  ).exec(input)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  }
}

/** Standard semver precedence comparison. */
function compareSemver(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1 // release > prerelease
  if (b.pre.length === 0) return -1
  const len = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < len; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (xNum) {
      return -1 // numeric identifiers sort before alphanumeric
    } else if (yNum) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

function makeVersion(major, minor, patch, pre) {
  return { major, minor, patch, pre: pre ? [...pre] : [] }
}

/** Pad a comparator's (possibly partial) version parts to x.y.z. */
function padVersion(parts, pre) {
  return makeVersion(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, pre)
}

/** Parse one range comparator token, e.g. ">=1.2.3-rc.1", "^0.2", "1.x". */
function parseComparator(token) {
  const t = String(token || '').trim()
  if (!t) return null
  if (t === '*' || t === 'x' || t === 'X') return { op: 'any', parts: [null, null, null], pre: null, raw: t }
  const m = new RegExp(
    `^(>=|<=|>|<|=|\\^|~)?\\s*(?:v)?(\\d+|[xX*])(?:\\.(\\d+|[xX*]))?(?:\\.(\\d+|[xX*]))?(?:-(${PRE}))?(?:\\+${PRE})?$`,
  ).exec(t)
  if (!m) return null
  const op = m[1] || '='
  const parts = []
  for (const raw of [m[2], m[3], m[4]]) {
    if (raw === undefined || raw === '*' || raw === 'x' || raw === 'X') parts.push(null)
    else parts.push(Number(raw))
  }
  // A prerelease needs a fully specified x.y.z.
  if (m[5] && (parts[1] === null || parts[2] === null)) return null
  return { op, parts, pre: m[5] ? m[5].split('.') : null, raw: t }
}

/** Tokenize whitespace-separated AND comparators, joining ">= 1.2.3". */
function tokenizeRangeSet(set) {
  const raw = set.split(/\s+/).filter(Boolean)
  const out = []
  for (let i = 0; i < raw.length; i++) {
    if (/^(>=|<=|>|<|=|\^|~)$/.test(raw[i]) && i + 1 < raw.length) {
      out.push(raw[i] + raw[++i])
    } else {
      out.push(raw[i])
    }
  }
  return out
}

function bumpLastSpecified(parts) {
  if (parts[2] !== null) return [parts[0], parts[1], parts[2] + 1]
  if (parts[1] !== null) return [parts[0], parts[1] + 1, 0]
  return [parts[0] + 1, 0, 0]
}

function caretUpper(parts) {
  const [major, minor, patch] = parts
  if (major > 0) return [major + 1, 0, 0]
  if (minor === null) return [1, 0, 0] // ^0 -> <1.0.0
  if (minor > 0) return [0, minor + 1, 0] // ^0.2.x -> <0.3.0
  if (patch === null) return [0, 1, 0] // ^0.0 -> <0.1.0
  if (patch > 0) return [0, 0, patch + 1] // ^0.0.3 -> <0.0.4
  return [0, 0, 1] // ^0.0.0 -> <0.0.1
}

function tildeUpper(parts) {
  const [major, minor] = parts
  if (minor === null) return [major + 1, 0, 0] // ~1 -> <2.0.0
  return [major, minor + 1, 0] // ~1.2 / ~1.2.3 -> <1.3.0
}

/** Does one comparator accept the version? (range expansion included) */
function comparatorSatisfies(version, comparator) {
  const { op, parts, pre } = comparator
  if (op === 'any') return true
  if (op === '=') {
    if (parts[1] === null) return version.major === parts[0]
    if (parts[2] === null) return version.major === parts[0] && version.minor === parts[1]
    return compareSemver(version, padVersion(parts, pre)) === 0
  }
  if (op === '>=') return compareSemver(version, padVersion(parts, pre)) >= 0
  if (op === '>') {
    if (parts[2] === null) {
      const bumped = padVersion(bumpLastSpecified(parts), null)
      return compareSemver(version, bumped) >= 0
    }
    return compareSemver(version, padVersion(parts, pre)) > 0
  }
  if (op === '<') return compareSemver(version, padVersion(parts, pre)) < 0
  if (op === '<=') {
    if (parts[2] === null) {
      const bumped = padVersion(bumpLastSpecified(parts), null)
      return compareSemver(version, bumped) < 0
    }
    return compareSemver(version, padVersion(parts, pre)) <= 0
  }
  if (op === '^') {
    const lower = padVersion(parts, pre)
    if (compareSemver(version, lower) < 0) return false
    return compareSemver(version, makeVersion(...caretUpper(parts), null)) < 0
  }
  if (op === '~') {
    const lower = padVersion(parts, pre)
    if (compareSemver(version, lower) < 0) return false
    return compareSemver(version, makeVersion(...tildeUpper(parts), null)) < 0
  }
  return false
}

function parseRangeSets(rangeStr) {
  return String(rangeStr)
    .split('||')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Validate range syntax without a candidate version. */
function isValidRange(rangeStr) {
  const sets = parseRangeSets(rangeStr)
  if (sets.length === 0) return { ok: false, reason: 'empty range' }
  for (const set of sets) {
    const tokens = tokenizeRangeSet(set)
    if (tokens.length === 0) return { ok: false, reason: `empty comparator set in "${set}"` }
    for (const token of tokens) {
      if (!parseComparator(token)) return { ok: false, reason: `unparseable comparator "${token}"` }
    }
  }
  return { ok: true }
}

/**
 * npm-flavoured satisfies(): OR of AND sets; prerelease versions are only
 * admitted by a comparator set that names a prerelease with the SAME
 * major.minor.patch (this is exactly why ">=0.2.1" alone would silently skip
 * a 0.2.1-rc.3 bundle, but ">=0.2.1-rc.2" admits it).
 */
function rangeSatisfies(versionStr, rangeStr) {
  const version = parseSemver(versionStr)
  if (!version) return { ok: false, reason: `invalid version "${versionStr}"` }
  const valid = isValidRange(rangeStr)
  if (!valid.ok) return valid
  for (const set of parseRangeSets(rangeStr)) {
    const comparators = tokenizeRangeSet(set).map(parseComparator)
    if (version.pre.length > 0) {
      const allowsPrerelease = comparators.some(
        (c) =>
          c.pre &&
          c.parts[0] === version.major &&
          c.parts[1] === version.minor &&
          c.parts[2] === version.patch,
      )
      if (!allowsPrerelease) continue
    }
    if (comparators.every((c) => comparatorSatisfies(version, c))) return { ok: true }
  }
  return { ok: false, reason: `"${rangeStr}" does not admit ${versionStr}` }
}

/**
 * Detect an effective EXACT pin. Catches bare "0.2.1-rc.2" (semver.valid) and
 * the equivalent single "=0.2.1-rc.2" comparator, which has the same
 * upgrade-skip failure mode.
 */
function detectExactPin(rangeStr) {
  const bare = parseSemver(String(rangeStr))
  if (bare) return bare
  const sets = parseRangeSets(rangeStr)
  if (sets.length !== 1) return null
  const tokens = tokenizeRangeSet(sets[0])
  if (tokens.length !== 1) return null
  const comparator = parseComparator(tokens[0])
  if (comparator && comparator.op === '=' && comparator.parts[2] !== null) {
    return padVersion(comparator.parts, comparator.pre)
  }
  return null
}

/**
 * Evaluate `engines.dsh` against the runtime version.
 * Returns { status: PASS|WARN|FAIL, detail, value }.
 */
function evaluateEnginesDsh(raw, runtimeVersion) {
  if (raw === undefined) {
    return {
      status: 'PASS',
      detail: 'absent -- no version gate, so DSH preflight will not skip the bundle',
      value: null,
    }
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      status: 'FAIL',
      detail: 'present but is not a non-empty semver range string -- DSH cannot evaluate compatibility',
      value: raw,
    }
  }
  const runtime = runtimeVersion ? parseSemver(runtimeVersion) : null
  const exact = detectExactPin(raw)
  if (exact) {
    if (!runtime) {
      return {
        status: 'WARN',
        detail: `exact pin "${raw}" -- runtime version unavailable, cannot confirm it matches`,
        value: raw,
      }
    }
    if (compareSemver(exact, runtime) === 0) {
      return {
        status: 'WARN',
        detail: `exact pin "${raw}" matches the current runtime, but the NEXT DSH upgrade will make preflight skip the whole bundle -- widen to a range (e.g. ">=${raw}")`,
        value: raw,
      }
    }
    return {
      status: 'FAIL',
      detail: `exact pin "${raw}" != runtime ${runtimeVersion}: DSH's compatibility preflight treats this as incompatible and SKIPS THE WHOLE BUNDLE (the rc.2 -> rc.3 failure mode). Replace with a range such as ">=${runtimeVersion}" or ">=${raw}".`,
      value: raw,
    }
  }
  const valid = isValidRange(raw)
  if (!valid.ok) {
    return { status: 'FAIL', detail: `cannot parse engines.dsh range "${raw}" (${valid.reason})`, value: raw }
  }
  if (!runtime) {
    return {
      status: 'WARN',
      detail: `range "${raw}" is syntactically valid, but the runtime version is unknown -- cannot confirm it admits this DSH build`,
      value: raw,
    }
  }
  const satisfied = rangeSatisfies(runtimeVersion, raw)
  if (satisfied.ok) {
    return {
      status: 'PASS',
      detail: `range "${raw}" admits runtime ${runtimeVersion}`,
      value: raw,
    }
  }
  let hint = ''
  if (runtime.pre.length) {
    hint = ` Prerelease runtimes are only admitted by a range that names a prerelease of ${runtime.major}.${runtime.minor}.${runtime.patch} (e.g. ">=${runtime.major}.${runtime.minor}.${runtime.patch}-rc.${Math.max(1, Number(runtime.pre[1] || 0))}").`
  }
  return {
    status: 'FAIL',
    detail: `range "${raw}" does not admit runtime ${runtimeVersion} -- DSH preflight will skip the whole bundle.${hint}`,
    value: raw,
  }
}

// ---------------------------------------------------------------------------
// Pure-JS ASAR reader (Electron/Chromium Pickle header)
// ---------------------------------------------------------------------------

/**
 * Parse the JSON header of an asar archive.
 *
 * Layout (Electron):
 *   [u32 4][u32 headerSize]                      -- 8-byte size-pickle prefix
 *   [u32 headerSize-4][u32 jsonLength][json...]  -- header buffer at offset 8
 *   file data starts at 8 + headerSize
 * Some descriptions give the simpler [json][NUL padding] layout instead; both
 * are supported so the checker survives Electron packaging changes.
 */
function parseAsarHeader(headerBuf) {
  const attempts = []
  if (headerBuf[0] === 0x7b /* '{' */) attempts.push({ start: 0, len: headerBuf.length })
  if (headerBuf.length >= 16 && headerBuf[8] === 0x7b) {
    const len = headerBuf.readUInt32LE(4)
    attempts.push({ start: 8, len: len > 0 && len <= headerBuf.length - 8 ? len : headerBuf.length - 8 })
  }
  const brace = headerBuf.subarray(0, Math.min(64, headerBuf.length)).indexOf(0x7b)
  if (brace > 0) attempts.push({ start: brace, len: headerBuf.length - brace })

  for (const attempt of attempts) {
    let text = headerBuf.toString('utf8', attempt.start, attempt.start + attempt.len)
    const nul = text.indexOf('\u0000')
    if (nul >= 0) text = text.slice(0, nul)
    text = text.trim()
    if (!text.startsWith('{')) continue
    try {
      return JSON.parse(text)
    } catch {
      // tolerate junk after the last '}' (e.g. stray padding bytes)
      const last = text.lastIndexOf('}')
      if (last > 0) {
        try {
          return JSON.parse(text.slice(0, last + 1))
        } catch {
          /* keep trying */
        }
      }
    }
  }
  throw new Error('could not parse asar JSON header (unexpected layout)')
}

class AsarArchive {
  constructor(asarPath) {
    this.asarPath = asarPath
    this.unpackedDir = `${asarPath}.unpacked`
    this.fd = fs.openSync(asarPath, 'r')
    try {
      const sizeBuf = Buffer.alloc(8)
      fs.readSync(this.fd, sizeBuf, 0, 8, 0)
      const magic = sizeBuf.readUInt32LE(0)
      if (magic !== 4) throw new Error(`unexpected asar header magic ${magic} (expected 4)`)
      const headerSize = sizeBuf.readUInt32LE(4)
      if (headerSize < 8 || headerSize > 64 * 1024 * 1024) {
        throw new Error(`implausible asar header size ${headerSize}`)
      }
      const headerBuf = Buffer.alloc(headerSize)
      let read = 0
      while (read < headerSize) {
        const n = fs.readSync(this.fd, headerBuf, read, headerSize - read, 8 + read)
        if (n <= 0) break
        read += n
      }
      if (read !== headerSize) throw new Error('short read of asar header')
      this.headerSize = headerSize
      this.dataBase = 8 + headerSize
      this.header = parseAsarHeader(headerBuf)
    } catch (error) {
      fs.closeSync(this.fd)
      this.fd = null
      throw error
    }
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd)
      this.fd = null
    }
  }

  /** Resolve a header node by archive-relative path. */
  getEntry(relPath) {
    let node = this.header
    for (const part of String(relPath).split('/').filter(Boolean)) {
      if (!node || !node.files || !node.files[part]) return null
      node = node.files[part]
    }
    return node
  }

  /** Read one file; handles `unpacked: true` entries via app.asar.unpacked. */
  readFile(relPath) {
    const entry = this.getEntry(relPath)
    if (!entry || entry.files) return null
    if (entry.unpacked) {
      try {
        return fs.readFileSync(path.join(this.unpackedDir, relPath))
      } catch {
        return null
      }
    }
    const size = Number(entry.size) || 0
    const offset = Number(entry.offset) || 0
    if (size === 0) return Buffer.alloc(0)
    const buf = Buffer.alloc(size)
    let read = 0
    while (read < size) {
      const n = fs.readSync(this.fd, buf, read, size - read, this.dataBase + offset + read)
      if (n <= 0) break
      read += n
    }
    return read === size ? buf : buf.subarray(0, read)
  }

  /** Walk all files under a directory node; callback gets (relPath, entry). */
  walk(relPath, onFile) {
    const node = this.getEntry(relPath)
    if (!node || !node.files) return
    const rec = (current, rel) => {
      for (const [name, child] of Object.entries(current.files || {})) {
        const childRel = rel ? `${rel}/${name}` : name
        if (child.files) rec(child, childRel)
        else onFile(childRel, child)
      }
    }
    rec(node, '')
  }
}

// ---------------------------------------------------------------------------
// Locating the DSH host + its runtime version
// ---------------------------------------------------------------------------

function resolveAppAsar(appPath) {
  const candidates = []
  if (String(appPath).endsWith('.asar')) candidates.push(appPath)
  if (path.basename(appPath) === 'Resources') candidates.push(path.join(appPath, 'app.asar'))
  candidates.push(
    path.join(appPath, 'Contents', 'Resources', 'app.asar'),
    path.join(appPath, 'app.asar'),
  )
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `could not find app.asar under "${appPath}" (tried: ${candidates.join(', ')})`,
  )
}

function readPkgVersion(archive, relPath) {
  try {
    const buf = archive.readFile(relPath)
    if (!buf) return null
    const pkg = JSON.parse(buf.toString('utf8'))
    return {
      version: typeof pkg.version === 'string' ? pkg.version : null,
      name: typeof pkg.name === 'string' ? pkg.name : null,
      from: relPath,
    }
  } catch {
    return null
  }
}

function findRuntimeVersionAsar(archive) {
  const direct = readPkgVersion(archive, `${HOST_NODE_MODULES}/${APP_BOOT_PKG}`)
  if (direct && direct.version) return direct
  // The desktop-runtime manifest pins the same version; good fallback.
  const desktop = readPkgVersion(archive, 'dsh/package.json')
  if (desktop && desktop.version) return desktop
  // Last resort: find the app-boot package by scanning @deepseek-ai package.json files.
  let found = null
  try {
    archive.walk(HOST_SCOPED_PKGS, (rel, entry) => {
      if (found || !rel.endsWith('/package.json')) return
      if (rel.split('/').length !== 2) return
      const info = readPkgVersion(archive, `${HOST_SCOPED_PKGS}/${rel}`)
      if (info && info.name === '@deepseek-ai/dsh-app-boot' && info.version) {
        found = { ...info, from: `${HOST_SCOPED_PKGS}/${rel}` }
      }
    })
  } catch {
    /* ignore */
  }
  return found
}

function readPkgVersionFs(absPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(absPath, 'utf8'))
    return { version: typeof pkg.version === 'string' ? pkg.version : null, name: pkg.name, from: absPath }
  } catch {
    return null
  }
}

function findRuntimeVersionFs(hostModulesRoot) {
  const scoped = path.join(hostModulesRoot, '@deepseek-ai')
  const direct = readPkgVersionFs(path.join(scoped, 'dsh-app-boot', 'package.json'))
  if (direct && direct.version) return direct
  const desktop = readPkgVersionFs(path.join(hostModulesRoot, '..', 'package.json'))
  if (desktop && desktop.version) return desktop
  let found = null
  try {
    for (const name of fs.readdirSync(scoped)) {
      if (found) break
      const info = readPkgVersionFs(path.join(scoped, name, 'package.json'))
      if (info && info.name === '@deepseek-ai/dsh-app-boot' && info.version) {
        found = { ...info, from: path.join(scoped, name, 'package.json') }
      }
    }
  } catch {
    /* ignore */
  }
  return found
}

function collectAsarCandidates(archive) {
  const candidates = []
  archive.walk(HOST_SCOPED_PKGS, (rel, entry) => {
    const isClientLib = /^[^/]+\/lib\/[^/]+\.js$/.test(rel)
    const isWebAsset = /^dsh-web-frontend\/dist\/assets\/[^/]+\.js$/.test(rel)
    if (!isClientLib && !isWebAsset) return
    candidates.push({
      label: rel,
      relPath: `${HOST_SCOPED_PKGS}/${rel}`,
      size: Number(entry.size) || 0,
      unpacked: Boolean(entry.unpacked),
    })
  })
  return candidates
}

function collectFsCandidates(hostModulesRoot) {
  const scoped = path.join(hostModulesRoot, '@deepseek-ai')
  let stat
  try {
    stat = fs.statSync(scoped)
  } catch {
    throw new Error(`expected an npm/source DSH install at "${scoped}" (no @deepseek-ai directory)`)
  }
  if (!stat.isDirectory()) throw new Error(`"${scoped}" is not a directory`)
  const candidates = []
  const addFile = (pkgName, subPath, absPath) => {
    try {
      const st = fs.statSync(absPath)
      if (!st.isFile()) return
      candidates.push({ label: `${pkgName}/${subPath}`, absPath, size: st.size })
    } catch {
      /* skip broken symlink */
    }
  }
  for (const dirent of fs.readdirSync(scoped, { withFileTypes: true })) {
    const pkgName = dirent.name
    const pkgDir = path.join(scoped, pkgName)
    const libDir = path.join(pkgDir, 'lib')
    try {
      if (fs.statSync(libDir).isDirectory()) {
        for (const file of fs.readdirSync(libDir)) {
          if (file.endsWith('.js')) addFile(pkgName, `lib/${file}`, path.join(libDir, file))
        }
      }
    } catch {
      /* no lib dir */
    }
    if (pkgName === 'dsh-web-frontend') {
      const assetsDir = path.join(pkgDir, 'dist', 'assets')
      try {
        for (const file of fs.readdirSync(assetsDir)) {
          if (file.endsWith('.js')) addFile(pkgName, `dist/assets/${file}`, path.join(assetsDir, file))
        }
      } catch {
        /* no dist */
      }
    }
  }
  return candidates
}

function loadHost(opts) {
  const host = {
    kind: 'asar',
    app: opts.app,
    source: '',
    asarPath: null,
    hostModules: null,
    runtimeVersion: null,
    runtimePackage: null,
    candidates: [],
    archive: null,
    error: null,
  }
  try {
    if (opts.hostModules) {
      host.kind = 'host-modules'
      const root = path.resolve(expandHome(opts.hostModules))
      host.hostModules = root
      host.source = root
      const runtime = findRuntimeVersionFs(root)
      if (runtime) {
        host.runtimeVersion = runtime.version
        host.runtimePackage = runtime.from && path.isAbsolute(runtime.from)
          ? path.relative(root, runtime.from).split(path.sep).join('/')
          : runtime.from
      }
      host.candidates = collectFsCandidates(root)
    } else {
      const appPath = path.resolve(expandHome(opts.app))
      host.app = appPath
      host.asarPath = resolveAppAsar(appPath)
      host.source = host.asarPath
      host.archive = new AsarArchive(host.asarPath)
      const runtime = findRuntimeVersionAsar(host.archive)
      if (runtime) {
        host.runtimeVersion = runtime.version
        host.runtimePackage = runtime.from
      }
      host.candidates = collectAsarCandidates(host.archive)
    }
  } catch (error) {
    host.error = error.message
    if (host.archive) {
      host.archive.close()
      host.archive = null
    }
  }
  return host
}

// ---------------------------------------------------------------------------
// Surface scanning (bounded, one pass per file)
// ---------------------------------------------------------------------------

function scanSurfaces(host) {
  const needles = REQUIRED_SURFACES.map((surface) => surface.needle)
  const hits = new Map(needles.map((needle) => [needle, []]))
  let scanned = 0
  let bytes = 0
  let skipped = 0
  const read =
    host.kind === 'asar'
      ? (candidate) => host.archive.readFile(candidate.relPath)
      : (candidate) => fs.readFileSync(candidate.absPath)
  const ordered = [...host.candidates].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  for (const candidate of ordered) {
    if (bytes + (candidate.size || 0) > MAX_SCAN_BYTES) {
      skipped++
      continue
    }
    let buf = null
    try {
      buf = read(candidate)
    } catch {
      buf = null
    }
    if (!buf) {
      skipped++
      continue
    }
    scanned++
    bytes += buf.length
    const text = buf.toString('utf8')
    for (const needle of needles) {
      if (text.includes(needle)) hits.get(needle).push(candidate.label)
    }
  }
  return { hits, scanned, bytes, skipped, candidates: host.candidates.length }
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

function resolveExportTarget(exportValue) {
  if (typeof exportValue === 'string') return exportValue
  if (exportValue && typeof exportValue === 'object') {
    for (const key of ['default', 'import', 'node', 'browser', 'require']) {
      const inner = resolveExportTarget(exportValue[key])
      if (inner) return inner
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Live profile install check
// ---------------------------------------------------------------------------

function profileDeclaresBundle(profileDir, pkgName) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes(pkgName)
  } catch {
    return false
  }
}

function findInstalledCopy(profileDir, pkgName) {
  const candidates = [
    path.join(profileDir, 'node_modules', pkgName),
    path.join(profileDir, 'plugins', pkgName),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate, 'package.json')).isFile()) return candidate
    } catch {
      /* try next */
    }
  }
  return null
}

function checkInstall(pluginDir, pluginPkg, opts, runtimeVersion, addCheck) {
  const info = { profileDir: opts.profileDir, dir: null, version: null, found: false }
  if (!opts.profileDir) {
    addCheck('install', 'location', 'PASS', 'live-install check skipped (--profile-dir none)')
    return info
  }
  let profileStat = null
  try {
    profileStat = fs.statSync(opts.profileDir)
  } catch {
    /* missing */
  }
  if (!profileStat || !profileStat.isDirectory()) {
    addCheck(
      'install',
      'location',
      'WARN',
      `profile dir not found: ${prettyPath(opts.profileDir)} -- pass --profile-dir to point at the profile your DSH app runs, or "none" to skip`,
    )
    return info
  }
  const pkgName = (pluginPkg && pluginPkg.name) || 'dsh-link-plugin'
  const installDir = findInstalledCopy(opts.profileDir, pkgName)
  if (!installDir) {
    const declared = profileDeclaresBundle(opts.profileDir, pkgName)
    addCheck(
      'install',
      'location',
      declared ? 'FAIL' : 'WARN',
      declared
        ? `profile declares bundle "${pkgName}" but ${prettyPath(path.join(opts.profileDir, 'node_modules', pkgName))} is missing -- the app cannot load the plugin; run "pnpm install" in ${prettyPath(opts.profileDir)} (or reinstall the bundle)`
        : `plugin "${pkgName}" is not installed in this profile (fine if the app uses another profile; override with --profile-dir)`,
    )
    return info
  }
  info.dir = installDir
  info.found = true
  let installedPkg = null
  try {
    installedPkg = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8'))
  } catch (error) {
    addCheck('install', 'location', 'WARN', `installed copy at ${prettyPath(installDir)} has an unreadable package.json: ${error.message}`)
    return info
  }
  info.version = typeof installedPkg.version === 'string' ? installedPkg.version : null
  addCheck(
    'install',
    'location',
    'PASS',
    `${prettyPath(installDir)} (${installedPkg.name || pkgName}@${info.version || '?'})`,
  )

  // 1. lib/client.js hash: stale copy means the running app loads old code.
  const repoClient = path.join(pluginDir, 'lib', 'client.js')
  const installedClient = path.join(installDir, 'lib', 'client.js')
  const repoHash = sha256File(repoClient)
  const installedHash = sha256File(installedClient)
  if (!installedHash) {
    addCheck(
      'install',
      'client-js',
      'WARN',
      `installed copy has no lib/client.js (${prettyPath(installedClient)}) -- reinstall the bundle`,
    )
  } else if (repoHash && repoHash === installedHash) {
    addCheck('install', 'client-js', 'PASS', `lib/client.js matches repo (sha256 ${repoHash.slice(0, 12)}... )`)
  } else {
    addCheck(
      'install',
      'client-js',
      'WARN',
      `installed lib/client.js is STALE (sha256 ${installedHash.slice(0, 12)}... vs repo ${(repoHash || 'missing').slice(0, 12)}...) -- the app keeps loading the old code; run "pnpm install" in ${prettyPath(opts.profileDir)} (or reinstall the bundle)`,
    )
  }

  // 2. package.json metadata: name / version / dsh.client / engines.dsh.
  const diffs = []
  if (installedPkg.name !== pluginPkg?.name) diffs.push(`name ${JSON.stringify(installedPkg.name)} != ${JSON.stringify(pluginPkg?.name)}`)
  if (installedPkg.version !== pluginPkg?.version) diffs.push(`version ${JSON.stringify(installedPkg.version)} != ${JSON.stringify(pluginPkg?.version)}`)
  const installedClientDecl = JSON.stringify(installedPkg.dsh?.client ?? null)
  const repoClientDecl = JSON.stringify(pluginPkg?.dsh?.client ?? null)
  if (installedClientDecl !== repoClientDecl) diffs.push('dsh.client differs')
  if ((installedPkg.engines?.dsh ?? null) !== (pluginPkg?.engines?.dsh ?? null)) {
    diffs.push(`engines.dsh ${JSON.stringify(installedPkg.engines?.dsh)} != ${JSON.stringify(pluginPkg?.engines?.dsh)}`)
  }
  if (diffs.length === 0) {
    addCheck('install', 'manifest', 'PASS', 'package.json name/version/dsh.client/engines.dsh match repo')
  } else {
    addCheck('install', 'manifest', 'WARN', `installed package.json is stale: ${diffs.join('; ')}`)
  }

  // 2b. The installed copy's own engines.dsh is what the NEXT launch preflights.
  if (installedPkg.engines?.dsh && runtimeVersion) {
    const installedEngine = evaluateEnginesDsh(installedPkg.engines.dsh, runtimeVersion)
    if (installedEngine.status === 'FAIL') {
      addCheck(
        'install',
        'engine',
        'WARN',
        `installed copy's engines.dsh is incompatible with runtime ${runtimeVersion}: DSH preflight will SKIP the installed bundle -- reinstall it from the fixed manifest`,
      )
    }
  }

  // 3. Bundle patch file.
  const repoPatchRel = pluginPkg?.dsh?.bundle?.patch
  const installedPatchRel = installedPkg?.dsh?.bundle?.patch
  const repoPatch = repoPatchRel ? path.resolve(pluginDir, repoPatchRel) : null
  const installedPatch = installedPatchRel ? path.resolve(installDir, installedPatchRel) : null
  if (!installedPatch || !sha256File(installedPatch)) {
    addCheck(
      'install',
      'bundle-patch',
      'WARN',
      'installed copy has no readable dsh.bundle.patch -- the bundle loader row will not be inserted',
    )
  } else if (repoPatch && sha256File(repoPatch) === sha256File(installedPatch)) {
    addCheck('install', 'bundle-patch', 'PASS', `${installedPatchRel} matches repo`)
  } else {
    addCheck(
      'install',
      'bundle-patch',
      'WARN',
      `installed bundle patch (${installedPatchRel}) differs from repo (${repoPatchRel || 'missing'}) -- reinstall to sync`,
    )
  }
  return info
}

// ---------------------------------------------------------------------------
// Upgrade-resilience check: runtime imports in lib/client.js
// ---------------------------------------------------------------------------

/** Extract bare module specifiers from require("...") / from "..." / import("..."). */
function extractSpecifiers(source) {
  const specifiers = new Set()
  const re = /(?:require\s*\(\s*|from\s+|import\s*\(\s*)["']([^"'\n]+)["']/g
  let match = re.exec(source)
  while (match) {
    specifiers.add(match[1])
    match = re.exec(source)
  }
  return [...specifiers]
}

function checkResilience(pluginDir, pluginPkg, addCheck) {
  const clientPath = path.join(pluginDir, 'lib', 'client.js')
  let source
  try {
    source = fs.readFileSync(clientPath, 'utf8')
  } catch (error) {
    addCheck('resilience', 'client-js', 'FAIL', `cannot read ${prettyPath(clientPath)}: ${error.message}`)
    return
  }
  const specifiers = extractSpecifiers(source)
  const external = specifiers.filter(
    (specifier) =>
      !specifier.startsWith('.') && !path.isAbsolute(specifier) && !isBuiltin(specifier),
  )
  const hostImports = external.filter((specifier) => specifier.startsWith('@deepseek-ai/'))
  const otherImports = external.filter(
    (specifier) => !specifier.startsWith('@deepseek-ai/') && !SEED_ALLOWED_IMPORTS.has(specifier),
  )
  const seedImports = external.filter(
    (specifier) => !specifier.startsWith('@deepseek-ai/') && SEED_ALLOWED_IMPORTS.has(specifier),
  )
  const inject = Array.isArray(pluginPkg?.dsh?.client?.inject) ? pluginPkg.dsh.client.inject : []

  if (hostImports.length === 0) {
    addCheck(
      'resilience',
      'host-imports',
      'PASS',
      'no @deepseek-ai host-package imports in lib/client.js (bundled/link-only: upgrades cannot orphan them)',
    )
  } else {
    // Anything from DSH is a host dependency. Declared ones are at least
    // warnings (target design is zero); undeclared non-seed ones are failures
    // because a host upgrade can remove them with no manifest signal.
    const declared = hostImports.filter((specifier) => inject.includes(specifier))
    const seedOnly = hostImports.filter(
      (specifier) => !inject.includes(specifier) && SEED_ALLOWED_IMPORTS.has(specifier),
    )
    const dangerous = hostImports.filter(
      (specifier) => !inject.includes(specifier) && !SEED_ALLOWED_IMPORTS.has(specifier),
    )
    if (dangerous.length > 0) {
      addCheck(
        'resilience',
        'host-imports',
        'FAIL',
        `undeclared host imports (${dangerous.join(', ')}): not in dsh.client.inject and not seed-provided, so a DSH upgrade can remove them silently -- eliminate them`,
      )
    }
    if (declared.length > 0) {
      addCheck(
        'resilience',
        'host-imports',
        'WARN',
        `declared host imports (${declared.join(', ')}): target design is ZERO @deepseek-ai imports; each declared host package is an upgrade risk (removed/renamed in a release => bundle breaks or is skipped)`,
      )
    }
    if (seedOnly.length > 0) {
      addCheck(
        'resilience',
        'host-imports',
        'WARN',
        `seed-provided host imports (${seedOnly.join(', ')}): allowed seed words, but still a host dependency -- keep the plugin import-free to survive upgrades`,
      )
    }
  }

  if (otherImports.length > 0) {
    addCheck(
      'resilience',
      'external-imports',
      'FAIL',
      `unexpected external imports (${otherImports.join(', ')}): the plugin host provides only react/react-dom; anything else will fail to resolve`,
    )
  } else if (seedImports.length > 0) {
    addCheck('resilience', 'external-imports', 'PASS', `runtime imports: ${seedImports.join(', ')} (seed-allowed)`)
  } else {
    addCheck('resilience', 'external-imports', 'PASS', 'no external runtime imports')
  }
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    json: false,
    help: false,
    app: DEFAULT_APP,
    hostModules: null,
    plugin: REPO_ROOT,
    profileDir: DEFAULT_PROFILE_DIR,
  }
  const takeValue = (index, flag) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(`${flag} requires a value`)
    }
    return argv[index + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') opts.json = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg.startsWith('--app=')) opts.app = arg.slice('--app='.length)
    else if (arg === '--app') opts.app = takeValue(i++, '--app')
    else if (arg.startsWith('--host-modules=')) opts.hostModules = arg.slice('--host-modules='.length)
    else if (arg === '--host-modules') opts.hostModules = takeValue(i++, '--host-modules')
    else if (arg.startsWith('--plugin=')) opts.plugin = arg.slice('--plugin='.length)
    else if (arg === '--plugin') opts.plugin = takeValue(i++, '--plugin')
    else if (arg.startsWith('--profile-dir=')) opts.profileDir = arg.slice('--profile-dir='.length)
    else if (arg === '--profile-dir') opts.profileDir = takeValue(i++, '--profile-dir')
    else throw new Error(`unknown argument: ${arg} (try --help)`)
  }
  if (opts.profileDir === 'none' || opts.profileDir === '') opts.profileDir = null
  else opts.profileDir = path.resolve(expandHome(opts.profileDir))
  opts.plugin = path.resolve(expandHome(opts.plugin))
  return opts
}

function printHelp() {
  console.log(`dsh-link-plugin -- DSH compatibility checker (post-upgrade verification)

Usage:
  node tools/compat-check.mjs [options]

Options:
  --app <path>          DSH app bundle (or its app.asar). Default: $DSH_APP or
                        "/Applications/DeepSeek Harness.app".
  --host-modules <dir>  Check an npm/source DSH install instead of the installed
                        app: path to that install's dsh/node_modules directory.
  --plugin <dir>        Plugin package root. Default: this repository.
  --profile-dir <dir>   DSH profile whose installed plugin copy is compared with
                        this repo. Default: $DSH_PROFILE_DIR, else
                        $DSH_HOME/profiles/desktop, else ~/.dsh/profiles/desktop.
                        Pass "none" to skip.
  --json                Print one JSON object with the same data.
  -h, --help            Show this help.

Checks:
  host      app.asar / host-modules readable, DSH runtime version, host bundles found
  manifest  engines.dsh admits the runtime (exact pins FAIL), bundle patch file,
            exports["./client"], dsh.client.platform === "web"
  surfaces  required DSH host-bundle strings (composer overlay, user-text node,
            captureInsertion/insertText, composer data attributes, phase literals)
  install   live profile copy vs repo (sha256 of lib/client.js, package.json,
            bundle patch) -- stale copies warn loudly
  imports   lib/client.js must not depend on undeclared @deepseek-ai host packages

Exit codes: 0 = PASS or DEGRADED (warnings only), 1 = FAIL.
`)
}

function buildReport(opts) {
  const checks = { host: [], manifest: [], surfaces: [], install: [], resilience: [] }
  const addCheck = (group, id, status, detail, extra) => {
    const check = { group, id, status, detail }
    if (extra) Object.assign(check, extra)
    checks[group].push(check)
    return check
  }

  // Plugin manifest first (cheap, no host needed).
  let pluginPkg = null
  let pluginPkgError = null
  try {
    pluginPkg = JSON.parse(fs.readFileSync(path.join(opts.plugin, 'package.json'), 'utf8'))
  } catch (error) {
    pluginPkgError = error.message
  }

  // Host: installed app.asar or an npm/source host-modules tree.
  const host = loadHost(opts)
  if (host.error) {
    addCheck('host', 'source', 'FAIL', host.error)
  } else {
    try {
      const size = fs.statSync(host.asarPath || host.hostModules).size
      addCheck(
        'host',
        'source',
        'PASS',
        host.kind === 'asar'
          ? `${prettyPath(host.asarPath)} (${fmtBytes(size)})`
          : `${prettyPath(host.hostModules)} (npm/source install)`,
      )
    } catch {
      addCheck('host', 'source', 'PASS', prettyPath(host.source))
    }
    if (host.runtimeVersion) {
      addCheck(
        'host',
        'runtime',
        'PASS',
        `${host.runtimeVersion} (from ${host.runtimePackage || 'host package manifest'})`,
      )
    } else {
      addCheck(
        'host',
        'runtime',
        'FAIL',
        'could not determine the DSH runtime version (no @deepseek-ai/dsh-app-boot/package.json)',
      )
    }
    const candidateBytes = host.candidates.reduce((sum, candidate) => sum + (candidate.size || 0), 0)
    if (host.candidates.length === 0) {
      addCheck(
        'host',
        'bundles',
        'FAIL',
        'no candidate host client bundles found under @deepseek-ai/*/lib or dsh-web-frontend/dist/assets -- the DSH layout may have changed',
      )
    } else {
      addCheck(
        'host',
        'bundles',
        'PASS',
        `${host.candidates.length} candidate JS files (${fmtBytes(candidateBytes)})`,
      )
    }
  }

  // Manifest checks.
  if (!pluginPkg) {
    addCheck(
      'manifest',
      'package-json',
      'FAIL',
      `cannot read ${prettyPath(path.join(opts.plugin, 'package.json'))}: ${pluginPkgError}`,
    )
  } else {
    const engine = evaluateEnginesDsh(pluginPkg.engines?.dsh, host.runtimeVersion)
    addCheck('manifest', 'engines', engine.status, engine.detail, { value: pluginPkg.engines?.dsh ?? null })

    const patchRel = pluginPkg?.dsh?.bundle?.patch
    if (typeof patchRel !== 'string' || patchRel.trim() === '') {
      addCheck(
        'manifest',
        'bundle-patch',
        'FAIL',
        'dsh.bundle.patch is not set -- the bundle loader row will not be inserted into the DSH composition',
      )
    } else {
      const patchAbs = path.resolve(opts.plugin, patchRel)
      let exists = false
      try {
        exists = fs.statSync(patchAbs).isFile()
      } catch {
        exists = false
      }
      if (exists) addCheck('manifest', 'bundle-patch', 'PASS', `${patchRel} exists`)
      else addCheck('manifest', 'bundle-patch', 'FAIL', `dsh.bundle.patch "${patchRel}" does not exist (resolved ${prettyPath(patchAbs)})`)
    }

    const clientExport = pluginPkg.exports?.['./client']
    const clientTarget = resolveExportTarget(clientExport)
    if (clientExport === undefined) {
      addCheck('manifest', 'client-export', 'FAIL', 'exports["./client"] is missing -- DSH cannot load the browser half')
    } else if (!clientTarget) {
      addCheck('manifest', 'client-export', 'FAIL', 'exports["./client"] has no resolvable file target')
    } else {
      const clientAbs = path.resolve(opts.plugin, clientTarget)
      let exists = false
      try {
        exists = fs.statSync(clientAbs).isFile()
      } catch {
        exists = false
      }
      if (exists) addCheck('manifest', 'client-export', 'PASS', `exports["./client"] -> ${clientTarget} (exists)`)
      else addCheck('manifest', 'client-export', 'FAIL', `exports["./client"] -> ${clientTarget}, but that file is missing`)
    }

    const platform = pluginPkg?.dsh?.client?.platform
    if (platform === 'web') {
      addCheck('manifest', 'client-platform', 'PASS', 'dsh.client.platform = "web"')
    } else {
      addCheck(
        'manifest',
        'client-platform',
        'FAIL',
        `dsh.client.platform = ${JSON.stringify(platform)} (expected "web") -- DSH will not load the browser half`,
      )
    }
  }

  // Host extension surface checks.
  let scan = { scanned: 0, bytes: 0, skipped: 0, candidates: 0 }
  if (!host.error && host.candidates.length > 0) {
    scan = scanSurfaces(host)
    for (const surface of REQUIRED_SURFACES) {
      const foundIn = scan.hits.get(surface.needle) || []
      if (foundIn.length > 0) {
        addCheck('surfaces', surface.needle, 'OK', `${surface.feature} (found in ${foundIn[0]})`, {
          needle: surface.needle,
          feature: surface.feature,
          foundIn: foundIn.slice(0, 5),
          matchCount: foundIn.length,
        })
      } else {
        addCheck('surfaces', surface.needle, 'MISSING', surface.degrade, {
          needle: surface.needle,
          feature: surface.feature,
          foundIn: [],
          matchCount: 0,
        })
      }
    }
  } else {
    const why = host.error ? `host bundle unavailable (${host.error})` : 'no candidate host bundles were found'
    for (const surface of REQUIRED_SURFACES) {
      addCheck('surfaces', surface.needle, 'MISSING', `${surface.degrade} -- ${why}`, {
        needle: surface.needle,
        feature: surface.feature,
        foundIn: [],
        matchCount: 0,
      })
    }
  }

  // Release the asar fd now that all archive reads are done.
  if (host.archive) {
    host.archive.close()
    host.archive = null
  }

  // Live profile install comparison.
  const install = checkInstall(opts.plugin, pluginPkg, opts, host.runtimeVersion, addCheck)

  // Upgrade-resilience check on the repo client bundle.
  if (pluginPkg) checkResilience(opts.plugin, pluginPkg, addCheck)

  // Counts and verdict.
  const all = Object.values(checks).flat()
  const failed = all.filter((check) => check.status === 'FAIL' || check.status === 'MISSING').length
  const warned = all.filter((check) => check.status === 'WARN').length
  const passed = all.filter((check) => check.status === 'PASS' || check.status === 'OK').length
  const verdict = failed > 0 ? 'FAIL' : warned > 0 ? 'DEGRADED' : 'PASS'

  const report = {
    tool: 'dsh-link-plugin/tools/compat-check.mjs',
    generatedAt: new Date().toISOString(),
    host: {
      kind: host.kind,
      app: host.app,
      source: host.source,
      asarPath: host.asarPath,
      hostModules: host.hostModules,
      runtimeVersion: host.runtimeVersion,
      runtimePackage: host.runtimePackage,
      candidateFiles: host.candidates.length,
      candidateBytes: host.candidates.reduce((sum, candidate) => sum + (candidate.size || 0), 0),
      error: host.error,
    },
    plugin: {
      dir: opts.plugin,
      name: pluginPkg?.name ?? null,
      version: pluginPkg?.version ?? null,
      enginesDsh: pluginPkg?.engines?.dsh ?? null,
      clientPlatform: pluginPkg?.dsh?.client?.platform ?? null,
      inject: Array.isArray(pluginPkg?.dsh?.client?.inject) ? pluginPkg.dsh.client.inject : [],
      error: pluginPkgError,
    },
    profile: {
      dir: opts.profileDir,
      found: install.found,
      installDir: install.dir,
      version: install.version,
    },
    scan: {
      capBytes: MAX_SCAN_BYTES,
      scannedFiles: scan.scanned,
      scannedBytes: scan.bytes,
      skippedFiles: scan.skipped,
    },
    checks,
    counts: { passed, warned, failed },
    verdict,
    exitCode: failed > 0 ? 1 : 0,
  }
  report.nextAction = buildNextAction(report)
  return report
}

function buildNextAction(report) {
  const checks = report.checks
  const failing = Object.values(checks)
    .flat()
    .filter((check) => check.status === 'FAIL' || check.status === 'MISSING')
  const warning = Object.values(checks)
    .flat()
    .find((check) => check.status === 'WARN')

  if (report.verdict === 'FAIL') {
    const hostFail = failing.find((check) => check.group === 'host')
    if (hostFail) {
      return `cannot read the DSH install (${hostFail.detail}); pass --app "<path to DeepSeek Harness.app>" or --host-modules "<dsh/node_modules>", then re-run.`
    }
    const engineFail = failing.find((check) => check.id === 'engines')
    if (engineFail) {
      return `fix "engines.dsh" in package.json so it admits DSH ${report.host.runtimeVersion || '<runtime>'}: replace the exact pin with a range (e.g. ">=${report.host.runtimeVersion || '0.2.1-rc.2'}"), then re-run this check and reinstall the profile copy.`
    }
    const missingSurfaces = checks.surfaces.filter((check) => check.status === 'MISSING')
    if (missingSurfaces.length > 0) {
      const features = [...new Set(missingSurfaces.map((check) => check.feature))]
      return `the DSH host extension surface changed in ${report.host.runtimeVersion || 'this DSH build'}: re-port lib/client.js for ${features.join(' + ')} (missing: ${missingSurfaces.map((c) => c.id).join(', ')}), then re-run.`
    }
    const resilienceFail = failing.find((check) => check.group === 'resilience')
    if (resilienceFail) {
      return 'remove or declare the @deepseek-ai host imports in lib/client.js -- host-package imports are the upgrade risk this check exists to catch.'
    }
    const installFail = failing.find((check) => check.group === 'install')
    if (installFail) {
      return `make the live profile match the repo: cd ${prettyPath(report.profile.dir)} && pnpm install (or reinstall the bundle), then re-run.`
    }
    return 'fix the failing checks above, then re-run: node tools/compat-check.mjs'
  }

  if (report.verdict === 'DEGRADED') {
    const stale = warning && (warning.id === 'location' || warning.id === 'client-js' || warning.id === 'manifest' || warning.id === 'bundle-patch' || warning.id === 'engine')
    if (stale && report.profile.dir) {
      return `all hard compatibility checks pass; sync the stale live profile copy: run "pnpm install" in ${prettyPath(report.profile.dir)} (or reinstall the bundle), then relaunch DSH.`
    }
    if (warning && warning.group === 'resilience') {
      return 'all hard compatibility checks pass; remove the declared @deepseek-ai host imports from lib/client.js to make the plugin upgrade-proof.'
    }
    return 'all hard compatibility checks pass; review the warnings above before shipping.'
  }

  return 'nothing to do -- the plugin manifest and the host extension surface match this DSH build.'
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function row(status, label, detail) {
  console.log(`  ${fmtStatus(status)} ${String(label).padEnd(32)} ${detail}`)
}

function section(title) {
  console.log('')
  console.log(title)
}

function printReport(report) {
  const runtime = report.host.runtimeVersion || 'UNKNOWN'
  console.log('dsh-link-plugin -- DSH compatibility check')
  console.log('='.repeat(96))
  console.log(`  DSH runtime   : ${runtime}   (${prettyPath(report.host.source || '?')})`)
  console.log(
    `  Plugin        : ${report.plugin.name || '?'}@${report.plugin.version || '?'}   (${prettyPath(report.plugin.dir)})`,
  )
  if (report.profile.dir) {
    const installed = report.profile.found
      ? `${report.profile.version || '?'} at ${prettyPath(report.profile.installDir)}`
      : 'not installed / not found'
    console.log(`  Profile copy  : ${installed}   (${prettyPath(report.profile.dir)})`)
  } else {
    console.log('  Profile copy  : skipped (--profile-dir none)')
  }

  if (report.checks.host.length) {
    section('Host runtime')
    for (const check of report.checks.host) row(check.status, check.id, check.detail)
  }
  if (report.checks.manifest.length) {
    section('Plugin manifest (package.json)')
    for (const check of report.checks.manifest) row(check.status, check.id, check.detail)
  }
  if (report.checks.surfaces.length) {
    const scan = report.scan
    section(
      `Host extension surfaces  (${scan.scannedFiles} files / ${fmtBytes(scan.scannedBytes)} scanned${scan.skippedFiles ? `, ${scan.skippedFiles} skipped` : ''})`,
    )
    for (const check of report.checks.surfaces) row(check.status, check.id, check.detail)
  }
  if (report.checks.install.length) {
    section('Installed profile copy')
    for (const check of report.checks.install) row(check.status, check.id, check.detail)
  }
  if (report.checks.resilience.length) {
    section('Upgrade resilience (lib/client.js imports)')
    for (const check of report.checks.resilience) row(check.status, check.id, check.detail)
  }

  const { passed, warned, failed } = report.counts
  console.log('')
  const verdictColor = report.verdict === 'PASS' ? 32 : report.verdict === 'FAIL' ? 31 : 33
  console.log(`${paint(verdictColor, report.verdict)}  (${passed} pass, ${warned} warn, ${failed} fail)`)
  console.log(`  What to do next: ${report.nextAction}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`compat-check: ${error.message}`)
    return 2
  }
  if (opts.help) {
    printHelp()
    return 0
  }
  let report
  try {
    report = buildReport(opts)
  } catch (error) {
    if (opts.json) {
      console.log(JSON.stringify({ tool: 'tools/compat-check.mjs', verdict: 'FAIL', exitCode: 1, error: error.message }, null, 2))
    } else {
      console.error(`compat-check: ${error.message}`)
    }
    return 1
  }
  if (opts.json) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
  return report.exitCode
}

process.exitCode = main()
