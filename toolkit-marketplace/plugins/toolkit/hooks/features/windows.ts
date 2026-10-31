// Windows helpers: clipboard, launching a file or link, revealing a file, toast notifications.
// The engine's own APIs ($.ui.copy, $.ui.notify) are tried first; Windows commands are the fallback.
import type { EngineInterface, RenderSurface } from 'claude-code'

import { isWindowsPath } from './paths'
import { homeDir, log } from './settings'

export async function isWindows($: EngineInterface): Promise<boolean> {
  if ((await $.env.get('OS')) === 'Windows_NT') return true
  return isWindowsPath(await homeDir($))
}

/** base64 of UTF-16LE text: what `powershell -EncodedCommand` takes. */
export const encodePowerShell = (script: string): string => {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i)
    bytes.push(c & 0xff, c >> 8)
  }
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]!
    out += b === undefined ? '=' : abc[(n >> 6) & 63]!
    out += c === undefined ? '=' : abc[n & 63]!
  }
  return out
}

/** Characters cmd.exe would read as operators when a target is not quoted. */
export const hasCmdMeta = (target: string): boolean => /[&|<>^%"]/.test(target)

/** The argv that launches a file or link with its default app on Windows. */
export const launchArgv = (target: string): string[] =>
  hasCmdMeta(target) ? ['rundll32', 'url.dll,FileProtocolHandler', target] : ['cmd', '/c', 'start', '', target]

export const revealArgv = (path: string): string[] => ['explorer', `/select,${path.replace(/\//g, '\\')}`]

export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
  "$x.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text></text><text></text></binding></visual></toast>')",
  "$n = $x.GetElementsByTagName('text')",
  '$n.Item(0).InnerText = $env:TOOLKIT_TOAST_TITLE',
  '$n.Item(1).InnerText = $env:TOOLKIT_TOAST_BODY',
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
].join('\n')

/** A desktop notification: the engine's channel first, a Windows toast through PowerShell second, an in-app toast last. */
export async function notify($: EngineInterface, title: string, body: string): Promise<string> {
  try {
    const sent = await $.ui.notify(body, { title })
    if (sent.isSent) return `engine:${sent.channel}`
  } catch {
    // fall through
  }
  if (await isWindows($)) {
    try {
      const ran = await $.process.run(
        ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(TOAST_SCRIPT)],
        { env: { TOOLKIT_TOAST_TITLE: title, TOOLKIT_TOAST_BODY: body }, timeoutMs: 15_000 },
      )
      if (ran.exitCode === 0) return 'powershell'
      void log($, 'windows', `toast failed: ${ran.stderr.slice(0, 200)}`)
    } catch (err) {
      void log($, 'windows', `toast failed: ${String(err)}`)
    }
  }
  $.ui.toast(`${title}: ${body}`)
  return 'in-app'
}

export async function copyText($: EngineInterface, text: string, surface?: RenderSurface): Promise<boolean> {
  try {
    const copied = await $.ui.copy(surface === undefined ? { text } : { text, surface })
    if (copied.isCopied) return true
  } catch {
    // fall through
  }
  if (await isWindows($)) {
    try {
      const ran = await $.process.run(['clip'], { stdin: text, timeoutMs: 10_000 })
      return ran.exitCode === 0
    } catch {
      return false
    }
  }
  return false
}

export async function launch($: EngineInterface, target: string): Promise<boolean> {
  if (!(await isWindows($))) return false
  try {
    const ran = await $.process.run(launchArgv(target), { timeoutMs: 15_000 })
    return ran.exitCode === 0
  } catch {
    return false
  }
}

export async function reveal($: EngineInterface, path: string): Promise<boolean> {
  if (!(await isWindows($))) return false
  try {
    // explorer exits 1 even when it worked, so any exit counts.
    await $.process.run(revealArgv(path), { timeoutMs: 15_000 })
    return true
  } catch {
    return false
  }
}
