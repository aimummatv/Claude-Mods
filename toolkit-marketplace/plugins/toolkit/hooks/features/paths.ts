// Path helpers that work for Windows (`C:\Users\me`) and POSIX paths alike.
// Never split on `/` alone: both separators are handled everywhere.

export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

/** The separator a path already uses: `\` for Windows-looking paths. */
export const sepOf = (p: string): string => (isWindowsPath(p) || (p.includes('\\') && !p.includes('/')) ? '\\' : '/')

/** Splits a path into its parts on either separator, dropping empty parts. */
export const splitPath = (p: string): string[] => p.split(/[\\/]+/).filter(part => part.length > 0)

/** Joins parts onto `base` with the separator `base` uses. */
export const joinPath = (base: string, ...parts: string[]): string => {
  const sep = sepOf(base)
  let out = base.replace(/[\\/]+$/, '')
  for (const part of parts) {
    const clean = splitPath(part).join(sep)
    if (clean.length > 0) out = out.length === 0 ? clean : `${out}${sep}${clean}`
  }
  return out
}

export const basename = (p: string): string => splitPath(p).at(-1) ?? ''

export const dirname = (p: string): string => {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (cut < 0) return '.'
  if (cut === 2 && /^[A-Za-z]:/.test(p)) return p.slice(0, 3)
  return cut === 0 ? p.slice(0, 1) : p.slice(0, cut)
}

export const extname = (p: string): string => {
  const name = basename(p)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** Windows paths compare case-insensitively with either separator. */
export const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => splitPath(p).join('/')
  return isWindowsPath(a) || isWindowsPath(b) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

/** The home folder: USERPROFILE first (Windows), then HOME, then HOMEDRIVE+HOMEPATH. */
export const resolveHome = (env: {
  USERPROFILE?: string | undefined
  HOME?: string | undefined
  HOMEDRIVE?: string | undefined
  HOMEPATH?: string | undefined
}): string | null => {
  if (env.USERPROFILE) return env.USERPROFILE
  if (env.HOME) return env.HOME
  if (env.HOMEDRIVE && env.HOMEPATH) return `${env.HOMEDRIVE}${env.HOMEPATH}`
  return null
}

/** `%USERPROFILE%\.claude\toolkit`: the only folder Toolkit writes in (besides PROJECT_MAP.md). */
export const toolkitDir = (home: string): string => joinPath(home, '.claude', 'toolkit')

/** Claude Code's project-folder name for a working directory: every non-alphanumeric becomes `-`. */
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** Path relative to `root` when inside it, else the path itself. */
export const relativeTo = (root: string, p: string): string => {
  const r = splitPath(root)
  const q = splitPath(p)
  const ci = isWindowsPath(root) || isWindowsPath(p)
  const eq = (x: string, y: string) => (ci ? x.toLowerCase() === y.toLowerCase() : x === y)
  if (q.length <= r.length) return p
  for (let i = 0; i < r.length; i++) if (!eq(r[i] ?? '', q[i] ?? '')) return p
  return q.slice(r.length).join(sepOf(p))
}
