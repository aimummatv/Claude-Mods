import { describe, expect, test } from 'claude-code/testing'

import { basename, dirname, extname, joinPath, projectSlug, relativeTo, resolveHome, samePath, splitPath, toolkitDir } from './features/paths'
import { redactSecrets } from './features/redact'
import { capLines, DEFAULT_SETTINGS, mergeSettings } from './features/settings'
import { blockBar, fmtClock, fmtDuration, fmtRate, fmtTokens } from './features/ui'
import { encodePowerShell, hasCmdMeta, launchArgv, revealArgv } from './features/windows'

describe('Windows path handling', () => {
  test('home comes from USERPROFILE, with fallbacks', () => {
    expect(resolveHome({ USERPROFILE: 'C:\\Users\\aman', HOME: '/home/x' })).toBe('C:\\Users\\aman')
    expect(resolveHome({ HOME: '/home/x' })).toBe('/home/x')
    expect(resolveHome({ HOMEDRIVE: 'D:', HOMEPATH: '\\Users\\a' })).toBe('D:\\Users\\a')
    expect(resolveHome({})).toBe(null)
  })
  test('joins with the separator the base uses, from either separator', () => {
    expect(joinPath('C:\\Users\\aman', '.claude', 'toolkit')).toBe('C:\\Users\\aman\\.claude\\toolkit')
    expect(joinPath('C:\\Users\\aman\\', 'logs/voice.log')).toBe('C:\\Users\\aman\\logs\\voice.log')
    expect(joinPath('/home/a', 'x\\y')).toBe('/home/a/x/y')
    expect(toolkitDir('C:\\Users\\aman')).toBe('C:\\Users\\aman\\.claude\\toolkit')
  })
  test('splits and names on both separators', () => {
    expect(splitPath('C:\\a/b\\c.txt')).toEqual(['C:', 'a', 'b', 'c.txt'])
    expect(basename('C:\\proj\\src/app.TSX')).toBe('app.TSX')
    expect(extname('C:\\proj\\src/app.TSX')).toBe('.tsx')
    expect(dirname('C:\\proj\\PROJECT_MAP.md')).toBe('C:\\proj')
    expect(dirname('C:\\file.txt')).toBe('C:\\')
  })
  test('compares Windows paths case-insensitively and makes relative paths', () => {
    expect(samePath('C:\\Proj\\A.md', 'c:/proj/a.md')).toBe(true)
    expect(relativeTo('C:\\Users\\aman\\shop', 'c:\\users\\aman\\shop\\src\\menu.tsx')).toBe('src\\menu.tsx')
    expect(relativeTo('C:\\other', 'C:\\Users\\x.ts')).toBe('C:\\Users\\x.ts')
  })
  test('project slug matches Claude Code folder names', () => {
    expect(projectSlug('C:\\Users\\aman\\shop')).toBe('C--Users-aman-shop')
  })
})

describe('secret redaction', () => {
  test('masks the common key formats', () => {
    // Fake keys, assembled at run time so no token-shaped literal sits in the source.
    const j = (...parts: string[]) => parts.join('')
    const text = [
      `key ${j('sk-', 'ant-api03-', 'abcdefghijklmnopqrstuvwxyz0123')}`,
      `gh ${j('gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}`,
      `slack ${j('xo', 'xb-', '1234567890-abcdefghij')}`,
      `google ${j('AI', 'za', 'SyA1234567890abcdefghijklmnopqrstu')}`,
      `auth Authorization: Bearer ${j('eyJhbGciOiJIUzI1NiJ9', '.payload.sig')}`,
      `shop ${j('shp', 'at_', '0123456789abcdef'.repeat(2))}`,
      'password = hunter2hunter2',
    ].join('\n')
    const out = redactSecrets(text)
    expect(out).not.toContain('sk-ant-api03')
    expect(out).not.toContain('ghp_ABC')
    expect(out).not.toContain('xoxb-123')
    expect(out).not.toContain('AIzaSy')
    expect(out).not.toContain('eyJhbGci')
    expect(out).not.toContain('shpat_0123')
    expect(out).not.toContain('hunter2hunter2')
    expect(out).toContain('[REDACTED')
  })
  test('leaves ordinary text alone', () => {
    const plain = 'Menu: 4 buttons (was 5). Invoice #1042 total $230.'
    expect(redactSecrets(plain)).toBe(plain)
  })
})

describe('settings and logs', () => {
  test('stored settings merge over defaults; bad values are ignored', () => {
    const s = mergeSettings({ features: { voice: false, nope: true }, voiceWordThreshold: 55, stuckMinutes: -3, modelOverride: 'opus' })
    expect(s.features.voice).toBe(false)
    expect(s.features.helperDesk).toBe(true)
    expect(s.voiceWordThreshold).toBe(55)
    expect(s.stuckMinutes).toBe(DEFAULT_SETTINGS.stuckMinutes)
    expect(s.modelOverride).toBe('opus')
    expect(mergeSettings('garbage')).toEqual(DEFAULT_SETTINGS)
  })
  test('logs keep the last 200 lines', () => {
    const text = Array.from({ length: 260 }, (_, i) => `line ${i}`).join('\n')
    const out = capLines(text).trim().split('\n')
    expect(out.length).toBe(200)
    expect(out[0]).toBe('line 60')
    expect(out.at(-1)).toBe('line 259')
  })
})

describe('Windows commands', () => {
  test('launch uses cmd start, or rundll32 when cmd would misread the target', () => {
    expect(launchArgv('C:\\shop\\PROJECT_MAP.md')).toEqual(['cmd', '/c', 'start', '', 'C:\\shop\\PROJECT_MAP.md'])
    expect(hasCmdMeta('claude://code/new?q=a&b')).toBe(true)
    expect(launchArgv('claude://code/new?q=a&b')[0]).toBe('rundll32')
  })
  test('reveal selects the file in Explorer with backslashes', () => {
    expect(revealArgv('C:/shop/PROJECT_MAP.md')).toEqual(['explorer', '/select,C:\\shop\\PROJECT_MAP.md'])
  })
  test('PowerShell -EncodedCommand is UTF-16LE base64', () => {
    // "ab" -> 61 00 62 00 -> YQBiAA==
    expect(encodePowerShell('ab')).toBe('YQBiAA==')
    expect(encodePowerShell('a')).toBe('YQA=')
  })
})

describe('formatting never invents numbers', () => {
  test('missing values are a dash', () => {
    expect(fmtTokens(null)).toBe('—')
    expect(fmtRate(null)).toBe('—')
    expect(fmtDuration(undefined)).toBe('—')
  })
  test('numbers format compactly', () => {
    expect(fmtTokens(1530)).toBe('1.5k')
    expect(fmtTokens(250_000)).toBe('250k')
    expect(fmtClock(108_000)).toBe('1:48')
    expect(fmtDuration(130_000)).toBe('2m 10s')
    expect(blockBar(0.5, 10)).toBe('█████░░░░░')
  })
})
