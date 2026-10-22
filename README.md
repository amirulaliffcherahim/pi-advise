# pi-advice

A second opinion for [Pi](https://pi.dev). Two commands, both usable by you **and** by the session agent.

## `/advise`
Reads the live session (your task, the agent's steps, tool results, compaction summary) and gives an honest review: is the approach right, what is wrong, what to do next. It is built **not** to be a yes-man: it separates what the transcript *proves* from what the agent merely *claimed*, and ends with a verdict.

```
VERDICT: SOUND | NEEDS CHANGES | WRONG DIRECTION
## Assessment   ## Problems   ## Do next   ## Keep
```

| Command | Effect |
|---|---|
| `/advise` | Review the whole session |
| `/advise is the root cause right?` | Review with a specific question |
| `/advise --act` | Review, then let the session agent act on it immediately |
| `/advise model` | Pick the advisor model + effort (picker) |
| `/advise model provider/id [effort]` | Set it directly (`session` = follow the session model) |
| `/advise caveman on\|off` | Terse caveman replies from advisor and discussion models (default on, saves tokens) |

## `/discuss`
A group discussion between up to 6 archetypes, each on its **own model**:
Contrarian, Confidant, Analyst, Visionary, Pragmatist, Open-Minded Explorer. Agents answer in turn and see what the others said, for 1-4 rounds, then a neutral wrap-up (agreed / disagreed / recommendation).

| Command | Effect |
|---|---|
| `/discuss <topic>` | Run with the enabled agents (default: Contrarian, Analyst, Pragmatist) |
| `/discuss` (no topic) or `--session` | Give the agents the current session as background |
| `--with contrarian,pragmatist` | Use only these agents for this run |
| `--rounds N` | Rounds for this run |
| `/discuss model` | Menu: toggle agents, set each agent's model, wrap-up, rounds |
| `/discuss model <agent\|all\|wrapup> <provider/id\|session> [effort]` | Set directly |
| `/discuss agents contrarian,analyst` / `/discuss rounds 3` | Quick config |

## Pi can trigger them too
The agent gets `advise` and `discuss` tools and guidance to use `advise` before risky steps, after repeated failures, and before declaring work done. Its output is labelled so the agent weighs it instead of obeying it. Limited by `maxAgentCalls` (default 10 per session); your own commands are never limited.

## Config: `~/.pi/agent/pi-advice.json`
Written by the model commands. Unset model = follow the session model. Fields: `advise`, `discuss.{rounds,wrapUp,synth,agents[]}`, `agentTools`, `maxAgentCalls`, `maxContextChars`. Invalid values fall back to defaults.

## Robust by default
- **Retries** transient errors (429/5xx/overload/network) twice with backoff. Permanent errors (bad key, bad model) fail at once.
- **Timeout** 180s per call (`timeoutSec`). Reported as a timeout, not a hang.
- **Fallback**: if your chosen model fails, the session model answers instead and the result says so (`fallback: false` to disable). Cancelling never falls back.
- **One run at a time**: a second `/advise`, `/discuss` or agent call while one runs is refused instead of doubling cost. Esc cancels; quitting Pi aborts any run.
- **Nudge**: after 2 tool failures in a row, the agent is told once to call `advise` (no model call spent; `nudge: false` to disable).
- The footer shows the last verdict (`advice: needs changes`). Agent-called `advise`/`discuss` render with the same box as the commands and stream live while running.

## Rules and style
The advisor and discussion agents receive the session's own system prompt (Pi rules, house rules) as `<session_rules>`, redacted and size-capped. They follow its constraints and report when the session broke them. Manual `/advise` never starts an agent turn unless you pass `--act`; if the agent is busy, the advice is queued for its next model call.

## Safety
The transcript is sent to whichever model you pick, so obvious secrets (API keys, tokens, JWTs, private keys, `password=…`) are redacted first. Pattern-based, not a guarantee. Esc cancels a running call.

## Install
`pi install git:github.com/amirulaliffcherahim/pi-advice`, or `pi -e ./src/index.ts` to try it.

`npm test` runs the tests (Node ≥ 22.15, needs Pi's packages resolvable).

