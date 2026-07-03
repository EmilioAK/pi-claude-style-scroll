<div align="center">

# pi-sticky-input

[![npm version](https://img.shields.io/npm/v/pi-sticky-input?style=for-the-badge)](https://www.npmjs.com/package/pi-sticky-input)
[![License](https://img.shields.io/github/license/MasuRii/pi-sticky-input?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge)]()

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Y8Y01PSSVR)

`pi-sticky-input` is a Pi extension that keeps chat input, status widgets, editor content, and footer controls anchored while session history updates in a bounded viewport above them.
- **npm**: https://www.npmjs.com/package/pi-sticky-input
- **GitHub**: https://github.com/MasuRii/pi-sticky-input

</div>

## Capabilities

- Keeps Pi's status, below-editor widgets, editor, and footer together in a sticky pane.
- Bounds rendered history above the sticky pane so long sessions do not push input off screen.
- Uses an alternate screen by default to avoid terminal scrollback fighting the sticky input layout.
- Supports keyboard history scrolling with `PageUp`, `PageDown`, `Ctrl+PageUp`, `Ctrl+PageDown`, `Ctrl+Home`, and `Ctrl+End`.
- Supports optional terminal mouse-wheel scrolling through alternate-scroll mode or SGR mouse capture.
- Falls back to Pi's original renderer for overlays and structurally unknown layouts.
- Keeps debug logging disabled by default and writes only to the extension-local `debug/` directory when enabled.

## Installation

### npm package

```bash
pi install npm:pi-sticky-input
```

### Git repository

```bash
pi install git:github.com/MasuRii/pi-sticky-input
```

### Local extension folder

Place this folder in one of Pi's extension discovery paths:

| Scope | Path |
|-------|------|
| Global default | `~/.pi/agent/extensions/pi-sticky-input` |
| Project | `.pi/extensions/pi-sticky-input` |

Pi discovers the extension through the root `index.ts` entry listed in `package.json`, which forwards to `src/index.ts`.

## Usage

The sticky renderer is enabled automatically when the extension loads and the TUI is available.

The `/sticky-input` command controls optional mouse-wheel capture at runtime:

```text
/sticky-input status
/sticky-input mouse on
/sticky-input mouse off
/sticky-input mouse toggle
/sticky-input help
```

Keyboard history scrolling is enabled by default. Mouse-wheel capture is disabled by default because full mouse tracking can block native terminal text selection and link clicks.

## Configuration

Runtime configuration is loaded from these locations in order. Later files override earlier files, so project config wins over user/global config.

| Scope | Path |
|-------|------|
| Extension install root | `<extension-root>/config.json` |
| Global user override | `~/.pi/agent/extensions/pi-sticky-input/config.json` |
| Project override | `<project>/.pi/extensions/pi-sticky-input/config.json` |

A starter template is included at `config/config.example.json`. Copy it to the global or project override path for customization, or let the extension use production defaults when no local config exists.

```bash
mkdir -p .pi/extensions/pi-sticky-input
cp config/config.example.json .pi/extensions/pi-sticky-input/config.json
```

The published package intentionally excludes local runtime state: `config.json` and `debug/` stay local to each installation.

### Configuration options

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `debug` | `boolean` | `false` | Enables file-only diagnostics under `debug/debug.log` |
| `enabled` | `boolean` | `true` | Enables the extension |
| `splitFooterRenderer` | `boolean` | `true` | Enables the sticky split-footer renderer patch |
| `alternateScreen` | `boolean` | `true` | Uses an alternate terminal screen while the session is active |
| `alternateScroll` | `boolean` | `false` | Lets compatible terminals translate wheel input into alternate-screen cursor sequences |
| `mouseScroll` | `boolean` | `false` | Enables SGR mouse-wheel capture for terminals without alternate-scroll support |
| `mouseWheelScrollRows` | `number` | `3` | Rows scrolled per wheel event |
| `keyboardScroll` | `boolean` | `true` | Enables page-key and home/end history scrolling |
| `keyboardScrollRows` | `number` | `10` | Rows scrolled per keyboard page event |
| `minimumHistoryRows` | `number` | `3` | Minimum history viewport height before falling back on very small terminals |
| `historyViewportLineLimit` | `number` | `200` | Maximum retained renderer-managed history lines before choosing the visible slice |

### Example config

```json
{
  "debug": false,
  "enabled": true,
  "splitFooterRenderer": true,
  "alternateScreen": true,
  "alternateScroll": false,
  "mouseScroll": false,
  "mouseWheelScrollRows": 3,
  "keyboardScroll": true,
  "keyboardScrollRows": 10,
  "minimumHistoryRows": 3,
  "historyViewportLineLimit": 200
}
```

Invalid or missing values are normalized to bounded defaults when the extension loads configuration.

## Compatibility

- `powerline-footer`: compatible by default because `pi-sticky-input` keeps status, widgets, editor, and footer inside the sticky pane instead of replacing singleton editor/footer hooks.
- `pi-agent-router`: compatible because below-editor widgets remain inside the sticky pane viewport.
- `pi-startup-redraw-fix`: compatible because `pi-sticky-input` patches the live `TUI.doRender` path and uses terminal clear ordering that does not require startup-redraw-fix's full-clear rewrite.
- Overlays and structurally unknown layouts fall back to Pi's original renderer for safety.

## Debug logging

Debug logging is disabled by default through `"debug": false`. When enabled, logs are appended only to:

```text
debug/debug.log
```

The extension does not write debug output to `console`, `stdout`, or `stderr`, and no debug log file is opened when debug logging is disabled.

## Development

```bash
npm run typecheck
npm run test
npm run build
npm run package:dry-run
```

## Related Pi Extensions

- [pi-tool-display](https://github.com/MasuRii/pi-tool-display) — Compact tool rendering and diff visualization
- [pi-startup-redraw-fix](https://github.com/MasuRii/pi-startup-redraw-fix) — Fix terminal redraw glitches on startup
- [pi-hide-messages](https://github.com/MasuRii/pi-hide-messages) — Hide older chat messages without losing context
- [pi-session-dashboard](https://github.com/MasuRii/pi-session-dashboard) — Localhost browser dashboard of session metrics

## License

[MIT](LICENSE) © MasuRii
