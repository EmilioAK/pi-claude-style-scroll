# Changelog

All notable changes to this extension will be documented in this file.

## [Unreleased]

## [0.1.1] - 2026-06-01

### Changed
- Deferred submodule loading and runtime state initialization until first use to reduce startup work.
- Widened peer dependency ranges to `^0.74.0 || ^0.75.0 || ^0.77.0 || ^0.78.0`.

## [0.1.0] - 2026-05-27

### Added
- Added sticky split-footer rendering that keeps Pi status, widgets, editor, and footer anchored below a bounded history viewport.
- Added alternate-screen support, optional alternate-scroll and mouse-wheel history scrolling, and keyboard history scrolling controls.
- Added extension-local configuration loading, validation warnings, and file-only debug logging under `debug/` when enabled.
