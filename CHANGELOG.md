# Changelog

## [0.3.0] - 2026-07-08

### Changed

- Forked from [`MasuRii/pi-sticky-input`](https://github.com/MasuRii/pi-sticky-input) and renamed to `pi-claude-style-scroll`.
- Made Claude Code-style alternate-scroll the default: sticky input stays pinned and the message viewport can scroll while composing.
- Added `scrollWhileTyping` config to control whether alternate-scroll cursor sequences are handled while prompt text is present.
- Added `/claude-style-scroll` as the primary command and kept `/sticky-input` as a compatibility alias.
- Added config path migration support from legacy `pi-sticky-input` config directories.

## Upstream history

This project is forked from `pi-sticky-input` 0.2.0. For upstream release history before the fork, see <https://github.com/MasuRii/pi-sticky-input/blob/main/CHANGELOG.md>.
