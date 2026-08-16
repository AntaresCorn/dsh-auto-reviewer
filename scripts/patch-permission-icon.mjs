#!/usr/bin/env node
/**
 * Patch the installed DSH web UI so the permission selector shows an
 * auto-review icon (shield + sparkle), matching the built-in presets.
 *
 * Idempotent: safe to run repeatedly; re-run after dsh updates.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'
const ANCHOR = 'd: "M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z",'
const MARK = '"auto-review": (0, react_jsx_runtime.jsxs)("svg", {'

function resolveClientPath() {
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
  return join(root, '@deepseek-ai/dsh/node_modules', PACKAGE, 'lib/client.js')
}

function glyphSource() {
  return [
    '\t\t\t"auto-review": (0, react_jsx_runtime.jsxs)("svg", {',
    '\t\t\t\twidth: "16",',
    '\t\t\t\theight: "16",',
    '\t\t\t\tviewBox: "0 0 16 16",',
    '\t\t\t\tfill: "none",',
    '\t\t\t\t"aria-hidden": true,',
    '\t\t\t\tchildren: [',
    '\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", {',
    '\t\t\t\t\t\td: shieldOutline,',
    '\t\t\t\t\t\tstroke: "currentColor",',
    '\t\t\t\t\t\tstrokeWidth: "1.31831",',
    '\t\t\t\t\t\tstrokeLinejoin: "round"',
    '\t\t\t\t\t}),',
    '\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", {',
    '\t\t\t\t\t\td: "M8 4.4L9.3 6.7L11.6 8L9.3 9.3L8 11.6L6.7 9.3L4.4 8L6.7 6.7Z",',
    '\t\t\t\t\t\tfill: "currentColor"',
    '\t\t\t\t\t})',
    '\t\t\t\t]',
    '\t\t\t})'
  ].join('\n')
}

const file = resolveClientPath()
let source = readFileSync(file, 'utf8')
if (source.includes(MARK)) {
  console.log('already patched: ' + file)
  process.exit(0)
}
const anchorAt = source.indexOf(ANCHOR)
if (anchorAt < 0) throw new Error('anchor not found in ' + file + ' (dsh version changed?)')
const closeAt = source.indexOf('};', anchorAt)
if (closeAt < 0) throw new Error('permissionGlyphs closing brace not found')
const before = source.slice(0, closeAt)
const jsxClose = before.lastIndexOf('})')
if (jsxClose < 0) throw new Error('previous glyph close not found')
const head = before.slice(0, jsxClose + 2) + ',' + before.slice(jsxClose + 2)
const patched = head + '\n\t\t\t' + glyphSource() + '\n\t\t' + source.slice(closeAt)
writeFileSync(file, patched)

// Quick syntax check before reporting success.
const dir = mkdtempSync(join(tmpdir(), 'dsh-icon-check-'))
const check = join(dir, 'client-check.mjs')
copyFileSync(file, check)
try {
  execFileSync(process.execPath, ['--check', check], { stdio: 'pipe' })
} finally {
  unlinkSync(check)
}
console.log('patched: ' + file)
