// Feature 6: Skill Helper. Finds installed skills, matches them to the task locally (no model call),
// and never puts the skill list into Claude's prompt.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement } from 'claude-code'

import type { SkillInfo, SkillsState } from '../../types'
import type { ToolInput } from './bus'
import type { AgentSpawnInput, AgentSpawnResult, ToolCallResult, TurnCompleteInput } from 'claude-code'
import { extname, joinPath } from './paths'
import { guard, homeDir, isOn } from './settings'
import { C, inputOf, truncate } from './ui'
import type { Els } from './ui'

export const EMPTY_SKILLS: SkillsState = {
  all: [],
  suggested: [],
  selected: null,
  query: '',
  hint: null,
  hintTask: -1,
  dismissedTask: -1,
  task: 0,
}
export const skillsAtom = atom({ plugin: 'toolkit', key: 'skills' } as const, EMPTY_SKILLS)

// ---------------------------------------------------------------------------
// Pure logic (tested)
// ---------------------------------------------------------------------------

export type Frontmatter = { name: string | null; description: string | null; body: string }

export const parseFrontmatter = (md: string): Frontmatter => {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md)
  if (!m) return { name: null, description: null, body: md }
  const head = m[1]!
  const get = (key: string): string | null => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(head)
    if (!line) return null
    let v = line[1]!.trim()
    if (v === '|' || v === '>' || v === '>-' || v === '|-') {
      // a block scalar: the indented lines after it
      const after = head.slice(head.indexOf(line[0]) + line[0].length).split(/\r?\n/)
      const block: string[] = []
      for (const l of after.slice(1)) {
        if (/^\s+\S/.test(l)) block.push(l.trim())
        else if (l.trim() === '') continue
        else break
      }
      v = block.join(' ')
    }
    return v.replace(/^["']|["']$/g, '') || null
  }
  return { name: get('name'), description: get('description'), body: m[2] ?? '' }
}

/** First plain lines of a SKILL.md body: a short how-to. */
export const howToOf = (body: string, max = 3): string =>
  body
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('---'))
    .slice(0, max)
    .join(' ')

const STOP = new Set(
  'an is to of in on it at be by or as so do if my me we up no go us am the and for with that this from into your you are was were have has had can will would should could about make made using use need want like just also then than them they there their what when where which while who why how not but all any each our out get got its into more most some such only very please help thing things stuff really okay yeah'.split(
    ' ',
  ),
)

export const stem = (w: string): string => {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

export const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/g) ?? [])
    .map(w => w.replace(/[.-]+$/, ''))
    .filter(w => w.length >= 2 && !STOP.has(w))
    .map(stem)

const EXT_WORDS: Record<string, string[]> = {
  '.html': ['web', 'page', 'design', 'html', 'frontend', 'landing'],
  '.css': ['design', 'style', 'css', 'frontend'],
  '.tsx': ['react', 'component', 'frontend'],
  '.jsx': ['react', 'component', 'frontend'],
  '.liquid': ['shopify', 'theme', 'store'],
  '.pdf': ['pdf', 'document'],
  '.docx': ['word', 'document', 'docx'],
  '.xlsx': ['spreadsheet', 'excel', 'xlsx'],
  '.pptx': ['presentation', 'slide', 'pptx'],
}

export const scoreSkill = (query: readonly string[], skill: Pick<SkillInfo, 'name' | 'description'>): number => {
  const q = new Set(query)
  const nameT = new Set(tokenize(skill.name.replace(/[:_-]/g, ' ')))
  const descT = new Set(tokenize(skill.description))
  let score = 0
  for (const t of q) {
    if (nameT.has(t)) score += 3
    else if (descT.has(t)) score += 1
  }
  return score
}

export const matchSkills = (
  text: string,
  files: readonly string[],
  skills: readonly SkillInfo[],
): { name: string; score: number }[] => {
  const query = tokenize(text)
  for (const f of files) for (const w of EXT_WORDS[extname(f)] ?? []) query.push(stem(w))
  return skills
    .map(s => ({ name: s.name, score: scoreSkill(query, s) }))
    .filter(x => x.score >= 2)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 3)
}

export const isStrong = (m: { score: number } | undefined): boolean => m !== undefined && m.score >= 5

export const filterSkills = (skills: readonly SkillInfo[], query: string): SkillInfo[] => {
  const q = query.trim().toLowerCase()
  if (!q) return [...skills]
  return skills.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
}

const ACRONYMS = new Set(['ui', 'ux', 'api', 'pdf', 'css', 'html', 'seo', 'ai', 'mcp', 'sql', 'pr', 'qa', 'cli', 'sdk'])

export const prettyName = (name: string): string =>
  name
    .split(':')
    .at(-1)!
    .split(/[-_]/)
    .map(w => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ')

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function findSkillFiles($: EngineInterface, dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0 || out.length > 400) return
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  for (const e of entries) {
    if (e.kind === 'file' && e.name === 'SKILL.md') out.push(joinPath(dir, e.name))
    else if (e.kind === 'dir' && !e.name.startsWith('.') && e.name !== 'node_modules') await findSkillFiles($, joinPath(dir, e.name), depth - 1, out)
  }
}

/** Skills from the command list (names and descriptions) joined with SKILL.md files on disk (how-to). */
export async function discoverSkills($: EngineInterface): Promise<SkillInfo[]> {
  const home = await homeDir($)
  const byName = new Map<string, SkillInfo>()
  const files: string[] = []
  await findSkillFiles($, joinPath(home, '.claude', 'skills'), 3, files)
  await findSkillFiles($, joinPath(home, '.claude', 'plugins'), 7, files)
  await findSkillFiles($, joinPath(await $.session.cwd(), '.claude', 'skills'), 3, files)
  for (const path of files) {
    try {
      const fm = parseFrontmatter(String(await $.fs.read(path)))
      const folder = path.split(/[\\/]/).at(-2) ?? 'skill'
      const name = fm.name ?? folder
      if (byName.has(name)) continue
      byName.set(name, {
        name,
        command: `/${name}`,
        description: fm.description ?? '',
        howTo: howToOf(fm.body),
        source: /[\\/]plugins[\\/]/.test(path) ? 'plugin' : 'user',
        path,
      })
    } catch {
      // unreadable: skipped
    }
  }
  try {
    for (const c of await $.command.list()) {
      if (c.source === 'builtin' || c.source === 'mcp') continue
      const short = c.name.split(':').at(-1)!
      const known = byName.get(c.name) ?? byName.get(short)
      if (known) {
        byName.delete(known.name)
        byName.set(c.name, { ...known, name: c.name, command: `/${c.name}`, description: known.description || c.description })
      } else if (c.plugin !== 'toolkit') {
        byName.set(c.name, { name: c.name, command: `/${c.name}`, description: c.description, howTo: '', source: c.source, path: null })
      }
    }
  } catch {
    // command list unavailable: disk skills only
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function refreshSkills($: EngineInterface): Promise<void> {
  const all = await discoverSkills($)
  await update($, skillsAtom, s => ({ ...s, all }))
}

let recentFiles: string[] = []

export async function onUserMessageSkills($: EngineInterface, text: string): Promise<void> {
  if (!(await isOn($, 'skills'))) return
  const st = await read($, skillsAtom)
  const suggested = matchSkills(text, recentFiles, st.all)
  const task = st.task + 1
  const top = suggested[0]
  await update($, skillsAtom, s => ({
    ...s,
    task,
    suggested,
    hint: isStrong(top) && s.dismissedTask !== task ? top!.name : null,
    hintTask: task,
  }))
}

export async function useSkill($: EngineInterface, name: string): Promise<void> {
  const st = await read($, skillsAtom)
  const s = st.all.find(x => x.name === name)
  if (!s) return
  await $.prompt.fill({ text: `${s.command} `, mode: 'replace' })
  await update($, skillsAtom, x => ({ ...x, hint: null, dismissedTask: x.task }))
}

export async function skillsSessionStart($: EngineInterface): Promise<void> {
  $.clock.after(1500, () => void guard($, 'skills', () => refreshSkills($)))
}

export async function skillsToolPre(_$: EngineInterface, _tool: string, input: ToolInput): Promise<void> {
  const f = input.file_path
  if (typeof f === 'string') recentFiles = [f, ...recentFiles.filter(x => x !== f)].slice(0, 10)
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export async function renderSkillHint($: EngineInterface, E: Els): Promise<RenderElement | null> {
  if (!(await isOn($, 'skills'))) return null
  const st = await read($, skillsAtom)
  if (st.hint === null || st.dismissedTask === st.task) return null
  const { Box, Text, Button } = E
  const name = st.hint
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={C.cyan}>✦</Text>
      <Text color={C.text}>{prettyName(name)} can help with this. Use it?</Text>
      <Button key="skill-hint-use" label="Use it" onPress={() => void useSkill($, name)} />
      <Button key="skill-hint-no" plain label="✕" onPress={() => void update($, skillsAtom, x => ({ ...x, hint: null, dismissedTask: x.task }))} />
    </Box>
  )
}

export async function renderSkillsSection($: EngineInterface, E: Els): Promise<RenderElement[]> {
  const { Box, Text, Button } = E
  const Input = inputOf(E)
  const st = await read($, skillsAtom)
  const list = filterSkills(st.all, st.query)
  const selected = st.all.find(s => s.name === st.selected) ?? null
  const rows: RenderElement[] = [
    <Box flexDirection="row" justifyContent="space-between">
      <Text bold color={C.cyan}>
        Skills
      </Text>
      <Text color={C.muted}>{st.all.length} installed</Text>
    </Box>,
    <Text color={C.muted}>Suggested for this task</Text>,
  ]
  if (st.suggested.length === 0) rows.push(<Text color={C.grey}>  No strong match yet.</Text>)
  for (const s of st.suggested) {
    rows.push(
      <Button key={`skill-sug-${s.name}`} plain onPress={() => void update($, skillsAtom, x => ({ ...x, selected: s.name }))}>
        ✦ {prettyName(s.name)} <Text dimColor>/{s.name}</Text>
      </Button>,
    )
  }
  if (selected) {
    rows.push(
      <Box flexDirection="column" borderStyle="round" borderColor={C.cyan} paddingX={1}>
        <Text bold color={C.text}>
          {prettyName(selected.name)} <Text color={C.muted}>{selected.command}</Text>
        </Text>
        <Text color={C.muted} wrap="wrap">
          {truncate(selected.description || '—', 220)}
        </Text>
        {selected.howTo ? (
          <Text color={C.muted} wrap="wrap">
            How: {truncate(selected.howTo, 200)}
          </Text>
        ) : null}
        <Box flexDirection="row" gap={1}>
          <Button key="skill-use" variant="primary" label="Use it" onPress={() => void useSkill($, selected.name)} />
          <Button key="skill-close" label="Close" onPress={() => void update($, skillsAtom, x => ({ ...x, selected: null }))} />
        </Box>
      </Box>,
    )
  }
  if (Input) {
    rows.push(
      <Input
        key="skill-search"
        placeholder="Search skills"
        value={st.query}
        onInput={v => void update($, skillsAtom, x => ({ ...x, query: v }))}
        onSubmit={v => void update($, skillsAtom, x => ({ ...x, query: v }))}
      />,
    )
  }
  const shown = list.slice(0, 12)
  for (const s of shown) {
    rows.push(
      <Button key={`skill-${s.name}`} plain onPress={() => void update($, skillsAtom, x => ({ ...x, selected: s.name }))}>
        {truncate(s.name, 30)} <Text dimColor>{truncate(s.description, 48)}</Text>
      </Button>,
    )
  }
  if (list.length > shown.length) rows.push(<Text color={C.muted}>+{list.length - shown.length} more · search to narrow</Text>)
  return rows
}
