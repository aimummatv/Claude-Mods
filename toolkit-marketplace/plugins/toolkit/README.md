# Toolkit

One Claude Code mod with seven features that save tokens, keep you informed and look polished. Built for Windows (works elsewhere too). No network calls: the only model calls go through Claude Code's own APIs, always on Haiku (Keep Warm's ping uses the chat's own model on purpose).

## Install (Windows)

In a Claude Code terminal session, paste (adjust the path to where this repo lives):

```
/plugin marketplace add C:\path\to\Claude-Mods\toolkit-marketplace
/plugin install toolkit@toolkit-local
/reload-plugins
```

Then type `/toolkit` to open the pane. Installed at user scope, it also loads in the desktop app's Code tab.

## Features

| # | Feature | What it does | Where |
|---|---|---|---|
| 1 | **Voice Prompt Cleaner** | A message of 40+ words that reads as dictation (fillers like "um", "you know", repeats, few line breaks) is held. Haiku turns it into a short numbered list (keeps every fact, name, number, file, link; adds nothing) and asks 0–2 questions only for real gaps. A 10 s countdown then sends it. **Send now / Edit / Send original**. Any key stops the countdown. A question unanswered for 15 s is skipped and its point marked *(unclear)*. Your raw transcript is never written to disk. | Above the prompt |
| 2 | **Helper Desk** | Purple task bar from Claude's own to-do list (TodoWrite / TaskCreate / TaskUpdate): title, Tasks 3/6, %, Now: step, ✕ to hide until the plan changes. One short to-do reminder per task, only after 3+ tool calls. **Agent monitor**: fixed ~30% of the pane, summary strip (Active, Stuck, Top tokens, Fastest, Total), 3–4 compact cards with Research/Design/Code/Browser badge, status colour, model, tokens, tok/s, duration, last activity, **Stop** / **Open result**. Orange above 150k tokens, red above 300k, auto-stop above 400k (note on the card). Stuck = no tool call, model step or output for 2 min (a running command gets its own timeout first); stuck agents pin to the top with **Acknowledge** / **Stop** until they recover or you acknowledge (acknowledged = dashed, muted, *not* recovered). Stable order: stuck > high use > active > waiting > finished; it only reorders when a status or threshold changes. Windows notification when all subagents finish. | Above the prompt + pane (top) |
| 3 | **Keep Warm** | Reads the cache length (5 min or 1 h) from your transcript. 2 minutes before the cache goes cold: Windows notification + bar "Cache goes cold in 1:48", the cost of a ping vs a cold re-read, **Keep warm** (one fork ping "Reply with the single word: ok", never written to the transcript) / **Let it go**. Never pings by itself. | Above the prompt |
| 4 | **Project Map + Chat Meter** | Keeps `PROJECT_MAP.md` in your project (App state by part, Decisions & my rules, Requests, Errors already solved, Key data, Files to open first, Next steps). Changes Claude makes are held *pending*; your next message decides in **one** Haiku call: approve/move on → written, "no / undo / put it back" → dropped, a tweak → stays pending. Haiku sees only the map, the last turn and your reply. Adds `@PROJECT_MAP.md` to `CLAUDE.md` (creates it if missing, leaves the rest alone). Toast "Map updated: Menu, Invoice form". **Chat Meter**: ring of context tokens vs 250k (green < 150k, amber < 220k, red after), "~N messages left", last map update, pending count, **New chat** (saves, then `/clear` and sends "Read PROJECT_MAP.md and continue from Next steps."), **Open map**, **Update map now**, **Copy start message**, **Open folder**. One-line meter above the prompt from 200k. | Pane (lower) + above the prompt |
| 5 | **Plan Usage** | 5-hour window and weekly bars with %, reset countdown / day. Green → amber 70% → red 90%; over the limit a red "Back in mm:ss" card. Notifications at 80%, 95% and "You're back". **LIVE** from Claude Code's own rate-limit data; otherwise **Estimate** from this computer's transcripts (claude.ai / phone use isn't counted), learning your real cap. Zero tokens. | Pane (lower) |
| 6 | **Skill Helper** | Finds your installed skills; "Suggested for this task" (top 1–3), search, full list; click for what it does, its slash command and how-to; **Use it** fills the prompt box. One-line hint above the prompt when a match is strong (once per task, dismissible). Matching is local and free; the skill list is never added to Claude's prompt. | Pane (lower) + above the prompt |
| 7 | **Auto Model** | Picks Haiku (small fixes), Sonnet (normal work) or Opus (big jobs, planning, architecture, repeated failures) from your wording, length, files, errors, screenshots; one tiny Haiku classification only when unsure. Cache-aware: switches freely at chat start; mid-chat only if the chat is small (< 30k), the cache is already cold, or the saving beats the re-read; otherwise keeps the model and suggests a Haiku subagent for small jobs. Escalates a level after a rejection or the same error twice. Leans cheaper above 80% of the 5-hour window. Learns from what you accept (`automodel.json`). Subagents: Research → Haiku, Code → Sonnet, Design → Opus (only when no model was asked for). Never changes effort. Chip in the status line: "Auto: Sonnet · 2 files · −40%". | Status line + pane (bottom) |
| + | **Done notification** | Windows notification when a turn took over 1 minute. | |
| + | **Big-read warning** | Before Claude reads a file of ~20k+ tokens or 2,000+ lines: *Read all* or *Only the needed part*. | Question dialog |

The "−40%" style numbers are relative list prices (Haiku 0.2, Sonnet 0.6, Opus 1.0 of Opus), from the published prices of the previous model generation. They are estimates, labelled as such.

## Commands

```
/toolkit                   open the pane
/toolkit settings          open the pane on its settings (toggle each feature, tune numbers)
/toolkit on <feature>      voice | helper | warm | map | usage | skills | auto | done | bigread
/toolkit off <feature>
/toolkit model <haiku|sonnet|opus|auto>
/toolkit set <setting> <number>   e.g. /toolkit set voiceWordThreshold 50
/toolkit status
/toolkit reset             back to defaults
/toolkit help
```

Settings: `voiceWordThreshold` (40), `voiceCountdownSec` (10), `voiceQuestionSec` (15), `agentTokenWarn` (150000), `agentTokenCritical` (300000), `agentTokenLimit` (400000), `stuckMinutes` (2), `keepWarmLeadSec` (120), `mapWordCap` (1500), `meterWindow` (250000), `meterLineFrom` (200000), `bigReadTokens` (20000), `bigReadLines` (2000), `doneNotifySec` (60).

## Files it writes

- `%USERPROFILE%\.claude\toolkit\settings.json`, `automodel.json`, `usage.json`
- `%USERPROFILE%\.claude\toolkit\logs\<feature>.log` (last 200 lines each)
- `<project>\PROJECT_MAP.md` and one `@PROJECT_MAP.md` line in `<project>\CLAUDE.md`

Secrets (`sk-…`, `ghp_…`, `xox?-…`, `AIza…`, `Bearer …`, Shopify/Stripe/AWS keys, private keys, `password=…`) are masked before anything is written.

## Turn it off / uninstall

- One feature: `/toolkit off <feature>` (or the ⚙ settings in the pane).
- Whole mod for now: `/plugin disable toolkit@toolkit-local`.
- Uninstall: `/plugin uninstall toolkit@toolkit-local`, then optionally `/plugin marketplace remove toolkit-local` and delete `%USERPROFILE%\.claude\toolkit`.

## Development

```
cd toolkit-marketplace\plugins\toolkit
claude plugin validate .
claude plugin test .
```

Type-check (needs the engine's types; a loaded mod gets them in `.claude-plugin/types/`): `tsc -p toolkit-marketplace` with `dev-types/claude-code.d.ts` copied from the plugin-authoring skill.
