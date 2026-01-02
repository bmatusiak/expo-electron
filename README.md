# expo-electron

Dev & packaging helper for the Expo app in the parent folder.

- `npm run dev` — start the Expo web server and Electron (dev)
- `npm run build-web` — build Expo for web into `expo-electron/app` (for packaging)
- `npm run package` — run `electron-forge package`
- `npm run make` — create distributables via `electron-forge make`

Notes:
- This setup requires the local `expo` and `electron` binaries (install dependencies in the project root).
- For packaging, run `npm run build-web` from this folder first so Electron will load the built `index.html`.
 - In this workspace `expo-electron` is referenced from the project root (see parent `package.json`). Running `npm install` at the project root will install the devDependencies for `expo-electron` automatically — you do not need to run `npm install` inside `expo-electron`.

Planned / Future workflow
-------------------------
The following workflow is planned to make initial setup and packaging predictable and editable:

- `prebuild`: `expo-electron` will act as a template package installed into `node_modules`.
	- Running `npm run electron -- prebuild` (from the project root) will copy `node_modules/expo-electron/main` into `<project-root>/electron` when that folder does not exist.
	- The generated `<project-root>/electron` is intended as a user-editable prebuild (main, preload, and packaging helpers) that developers can modify for their app.
	- If the `<project-root>/electron` directory exists, the CLI will prefer it over the packaged template in `node_modules`.

- `package`: `npm run electron -- package` will:
	1. Build the Expo web assets into the prebuild `electron` folder (so the app bundles the static web build).
	2. Run the Electron Forge packaging flow (Squirrel for Windows) from the project root to produce distributables.

Implementation notes:
- No silent fallbacks: the CLI will fail loudly when required binaries are missing and will clearly instruct to run `npm install` at project root.
- The prebuild copy is idempotent and only creates the editable `electron` folder when missing.
- Scripts will prefer binaries installed at the workspace root (`node_modules/.bin`) so `npm install` in the root manages all packages.

