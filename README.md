# expo-electron

Dev helper that integrates an Expo web app with Electron for development and deterministic packaging.

Quick commands (run from the project root):

- `npm install` — ensure project dependencies are installed so `expo`, `electron`, and `electron-forge` are available in `node_modules/.bin`.
- `npx expo-electron prebuild` — copy the template `main/` into the project's `electron/` folder for editing (skips overwriting existing files).
- `npx expo-electron start` — run Expo web and launch Electron (development mode).
-- `npx expo-electron package` — build the web app and run packaging steps. By default this runs `electron-forge package` (preparing the packaged app and running packaging hooks) but will only run `electron-forge make` to produce final distributables when you pass `--make` (for example `--make zip,deb`).

How it works (high level)

- Prebuild: copies the bundled template `main/` into the project's `electron/` folder but never overwrites existing files. A `.gitignore` is created in the prebuild folder to avoid checking in generated outputs.
- Dev (`start`): runs `expo start --web`, waits for the dev server, then launches Electron with `main/main.js`. The Electron working directory is the project's `electron/` folder if present, otherwise the bundled template is used.
- Packaging (`package`): exports the web build into `electron/.build/app` and runs `electron-forge make` inside `electron/.build` so artifacts are produced at `electron/.build/out/make`.

Deterministic packaging details

- Web export: the CLI uses the installed Expo CLI's `export` command; if `export` is not available it fails loudly rather than guessing alternatives.
- Post-export transformations: the exported `index.html` is adjusted to be compatible with `file://` URLs:
  - If missing, a `<base href="./">` is injected.
  - Root-absolute `src`/`href` attributes (for example paths starting with `/_expo/`) are rewritten to relative paths (`./_expo/...`).
-- Packaging workspace: a minimal `package.json` and Forge config are created in `electron/.build`. The CLI always runs `electron-forge package` so packaging hooks and the packaged application are produced deterministically. The final step (`electron-forge make`) that creates distributables is only run when you explicitly pass `--make` to `npx expo-electron package` (see examples below).

Package options


  - Run packaging only (no distributables):

    `npx expo-electron package`

  - Run packaging and produce only `zip` and `deb` distributables:

    `npx expo-electron package --make zip,deb`

  - The CLI filters known makers by fuzzy name matching (e.g. `zip` matches `@electron-forge/maker-zip`). If no matching makers are found the `make` step is skipped.

Available makers (tokens)

- `squirrel` — maps to `@electron-forge/maker-squirrel` (Windows/Squirrel)
- `zip` — maps to `@electron-forge/maker-zip` (Zip archive; configured for darwin, linux)
- `deb` — maps to `@electron-forge/maker-deb` (Debian package)
- `rpm` — maps to `@electron-forge/maker-rpm` (RPM package)

Autolinking native/electron modules

This package includes an `autolink` helper that scans the project's top-level dependencies (only those declared in the project's `package.json`) for packages that expose an `electron/` entry.

- Detection: `autolink` looks for packages installed at `projectRoot/node_modules/<name>` and only links packages that contain an `electron/index.js` entry (or a configured `expoBlock.entry`).
-- Preload generation: `autolink` writes a generated preload script (default `src/preload.js`; when run into a prebuild target it will write `electron/main/preload.js`). The generated preload is not intended for manual edits and may be overwritten by subsequent autolink runs. The preload exposes a `native` object via `contextBridge.exposeInMainWorld('native', native)`.
  - For each linked package it attempts to resolve a development path (`require.resolve('<name>/electron')` or configured entry) and a production path inside the packaged app (under `app.asar.unpacked/native/<name>/...` or `native/<name>/...`).
  - If the module is resolvable in dev or present in the packaged resources, the implementation is required and exposed; otherwise a `{ _missing: true }` placeholder is provided so the preload remains robust.
- Resource list: `autolink` also writes an `electron-resources.json` describing files to copy into the packaged app under `native/<package>/...`, including the package's `electron/` folder, its `main` entry, and compiled add-on outputs in `build/Release` or `build/Debug` when present.

Production runtime behavior

- `main/main.js` prefers loading a production `app/index.html` (packaged web export). If that file is present the app will load locally; if not, and `NODE_ENV` is `development`, it will attempt to load the dev server URL from `EXPO_WEB_URL`.
- If neither a production index nor a dev server is available the process exits with a non-zero code — this prevents silent fallbacks.

Troubleshooting

- Missing binaries: the CLI checks for `expo`, `electron`, and `electron-forge` in `node_modules/.bin` and fails with actionable messages if they are missing. Run `npm install` at the project root first.
- File not found errors after packaging: verify `electron/.build/app/index.html` exists and contains a `<base href="./">`, and confirm static assets exist under `electron/.build/app/_expo` (or the expected relative paths).
- Autolink issues: the autolinker only considers packages installed at the project's top-level `node_modules`. If a package is nested or not declared in `package.json`, it will be skipped.

Developer notes

- The tool intentionally favors deterministic, fail-fast behavior: it validates the environment and fails loudly if an expected command or file is unavailable.
-- The `electron/` prebuild folder is intended to be edited by developers; once created the CLI will not overwrite your edits — with one exception: generated artifacts created by the autolinker (for example `electron/main/preload.js`) may be regenerated and should not be edited directly.

Where to look in the code

- Autolink logic: [modules/expo-electron/lib/autolink.js](modules/expo-electron/lib/autolink.js#L1)
- CLI entry and packaging flow: [modules/expo-electron/cli.js](modules/expo-electron/cli.js#L1)
- Electron template main: [modules/expo-electron/main/main.js](modules/expo-electron/main/main.js#L1)

If you'd like, I can add a `--clean` option to remove `electron/.build` prior to packaging, or add more diagnostic logging to the autolinker for tricky modules.

Project snapshot (this repository)

-- Generated prebuild: `electron/` — created by `npx expo-electron prebuild` and intended for developer edits. It contains:
  - `electron/main/main.js` (template main process).
  - Note: `electron/main/preload.js` is typically generated by the autolinker when it targets the prebuild; it is not intended for manual edits and may be overwritten.
  - `.gitignore` to avoid checking in generated packaging outputs.
- Packaging output: `electron/.build/` — created by `npx expo-electron package`. Typical contents in this project include:
  - `electron/.build/app/index.html` and static assets under `electron/.build/app/_expo/` (the exported web build).
  - `electron/.build/main/main.js` and `electron/.build/main/preload.js` (autolink-generated preload when `autolink` ran into the prebuild target).
  - `electron/.build/native/<package>/...` — copied native resources (example: `native/example-native-module/index.js` and compiled addon under `native/example-native-module/build/Release`).
  - `electron/.build/out/` or `electron/.build/out/make` — packaging artifacts produced by `electron-forge make`.
- Autolink resources index: `electron/electron-resources.json` — generated resource mapping for packaging. Example from this repo:

```json
[
  { "from": "node_modules/example-native-module/electron", "to": "native/example-native-module/electron" },
  { "from": "node_modules/example-native-module/index.js", "to": "native/example-native-module/index.js" },
  { "from": "node_modules/example-native-module/build/Release", "to": "native/example-native-module/build/Release" }
]
```


Convenience script

- `run.sh` in the project root demonstrates the workflow used here: it runs `npm install`, deletes any previous `electron/`, runs `npx expo-electron prebuild`, then `npx expo-electron package`, and finally runs the built app from `electron/.build/out/...`.
  - Note: `run.sh` calls `npx expo-electron package` without `--make`, so by default it prepares the packaged application but does not create distributables. To make distributables with the convenience script edit it to pass `--make` (for example `npx expo-electron package --make zip,deb`).

These concrete examples reflect the files present in this workspace and should make it easier to troubleshoot packaging and native module inclusion.

