# expo-electron

Dev & packaging helper for the Expo app in the parent folder. This README documents the current, deterministic workflow and recent fixes for production packaging.

Quick commands (run from the project root):

- **Install:** Run `npm install` in the project root so `expo`, `electron`, and `electron-forge` are available in `node_modules/.bin`.
- **Prebuild (one-time):** `npx expo-electron prebuild` — copies the template `main/` into `<project>/electron` for editing.
- **Dev:** `npx expo-electron start` — starts Expo web and launches Electron (dev mode).
- **Package:** `npx expo-electron package` — builds the web app and runs `electron-forge make` to create distributables.

What `package` does now (deterministic):

- Builds the Expo web export into: `electron/.build/app` (this is important — production `main.js` expects `app/index.html`).
- After export the CLI adjusts `index.html` so it works with `file://` URLs:
  - injects a `<base href="./">` if missing,
  - rewrites root-absolute `src`/`href` attributes (e.g. `/_expo/...`) to relative paths (`./_expo/...`).
- Creates a minimal packaging `package.json` inside `electron/.build` combining your project name/version and the template Forge config, and runs `electron-forge make` with cwd set to `electron/.build`.
- If `rpmbuild` is not present on the machine, the tool removes any RPM maker from the Forge config so packaging does not fail unexpectedly.
- The packaging workspace and outputs are preserved under `electron/.build` (artifacts at `electron/.build/out/make`) for inspection — nothing is deleted automatically.

Production behaviour and troubleshooting

- The packaged Electron `main.js` will require `app/index.html` to be present inside the packaged resources. If it's missing the app will log an error and exit with a non-zero code. This prevents silent fallbacks to a dev server.
- If you see errors like `GET file:///_expo/... net::ERR_FILE_NOT_FOUND` in the devtools console after packaging:
  - Confirm `electron/.build/app/index.html` exists and contains a `<base href="./">` near the top.
  - Confirm assets exist in `electron/.build/app/_expo` or the expected relative paths.
  - Re-run packaging: `rm -rf electron && npx expo-electron package` to regenerate the build and packaging workspace.

Notes and policy

- Deterministic, no-fallback behavior: the CLI checks for required commands and fails loudly with clear instructions (do not expect it to guess alternate CLI forms).
- The `electron` folder created by `prebuild` is intended to be edited by developers; if it exists the CLI will prefer it over the bundled template in `node_modules`.
- This helper prefers binaries installed at the project root (`node_modules/.bin`). Run `npm install` at the root before using packaging or dev commands.

If you want, I can add an explicit `--clean` option to remove `electron/.build` before packaging; otherwise the workspace is preserved for inspection.

