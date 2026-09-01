# dsh-log-capture-xg

[简体中文](README.md) · **English**

> [!NOTE] Maintenance status
> This plugin is an internal XG-series tool, **provided for learning and reference only, with no maintenance commitment** (issues are not guaranteed a response).
> The latest development version is maintained in the internal GitLab repository XGDSHPlugins; this repository is a source snapshot.

A plugin that captures DSH runtime key logs: it filters the structured logs from `ctx.logger` (the log channels of all plugins and services) according to rules and appends them to a disk file; it also captures `agent/error` events and session lifecycle markers.

## Why it's needed

DSH's Cordis logger by default only has an **in-memory buffer exporter** (keeping the most recent 1000 entries), and no stdout exporter:

- Logs from `ctx.logger.*` do not appear in the terminal, and the buffer is lost after a process restart
- To investigate "what happened in the last session", you could only rely on terminal scrollback or extracting session.jsonl.zstd

This plugin registers a file exporter so that key logs are **persisted to disk continuously, filterable on demand, and rotated daily**.

## How it works

Cordis `LoggerService` allows any number of exporters to be registered via `ctx.logger.exporter()`. Each log call delivers the structured `Message` (timestamp / level / logger name / arguments) to all exporters. Inside the exporter callback, this plugin:

1. Renders a text line using `Logger.format()`
2. Filters according to rules (level / logger name prefix list / keywords)
3. Appends to `<dir>/dsh-capture-<YYYY-MM-DD>.log`

All disk operations inside the exporter callback are wrapped with try/catch as a fallback — a write failure does not affect the log caller.

## Capture scope

| Source | Description |
|--------|-------------|
| All `ctx.logger` channels | Structured logs from all plugins and services (`log-capture`, `llm-deepseek`, `sandbox-local`, etc.) |
| `agent/error` events | Turn/step runtime errors (transcribed even when they do not go through the logger) |
| Session lifecycle | `agent/session-start` / `agent/disposed` marker lines (`== session start: <id> ==`) |

## Configuration (cordis.patch.yml)

```yaml
- id: log-capture
  name: 'dsh-log-capture-xg'
  config:
    dir: 'C:\Users\<user>\.dsh\logs'   # output directory, default ~/.dsh/logs
    level: 'warn'                      # minimum level (error > warn > info > debug), default warn
    include: ['llm-deepseek', 'sandbox-']  # logger name prefix whitelist; empty = all
    exclude: []                        # logger name prefix blacklist (takes priority over include)
    keywords: []                       # message keywords; record if any matches; empty = disabled
    maxAgeDays: 7                      # retention days; files older than this are cleaned up automatically
    console: false                     # also write to the server terminal (off by default, to avoid polluting stdout)
    markSessions: true                 # write session markers and agent/error transcriptions (on by default)
```

Level semantics are judged by severity `error > warn > info > debug`, which is independent of the numeric order of cordis's internal `LoggerLevel` (ERROR=0 < INFO=1 < WARN=2 < DEBUG=3).

## Typical usage

To investigate a plugin's behavior (for example, the capture results of dsh-log-capture-xg itself):

```yaml
config:
  level: 'info'
  include: ['log-capture']
```

To focus only on model request failures:

```yaml
config:
  level: 'error'
  keywords: ['failed', 'timeout', 'error']
```

## Deployment

1. Build: `node node_modules/typescript/bin/tsc -p tsconfig.json` (output `lib/`)
2. Copy `lib/` and `package.json` to `~/.dsh/profiles/web/node_modules/dsh-log-capture-xg/`
3. Add the above entry to `cordis.patch.yml`
4. Restart DSH (`pnpm dsh web`) — after startup, the `== log capture started: ... ==` marker line appears in the log file once it takes effect

## Development

- Source code in `src/` (the logic layer `logic.ts` is separated from the plugin entry `index.ts`, so it can be unit-tested independently)
- Unit tests: `node --test tests/logic.spec.mjs`
- All filtering rules and file rotation logic live in `logic.ts`, which does not depend on cordis
