#!/usr/bin/env node
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Determine project root: walk upwards until we find a package.json whose
// `name` differs from this package (expo-electron). This allows the package
// to be installed under `node_modules` or `sub_modules` during development.
function findProjectRoot() {
    const selfPkgPath = path.join(__dirname, 'package.json');
    let selfName = null;
    try { selfName = JSON.parse(fs.readFileSync(selfPkgPath, 'utf8')).name; } catch (e) { /* ignore */ }
    let cur = path.resolve(__dirname);
    for (let i = 0; i < 6; i++) {
        cur = path.dirname(cur);
        const p = path.join(cur, 'package.json');
        if (fs.existsSync(p)) {
            try {
                const name = JSON.parse(fs.readFileSync(p, 'utf8')).name;
                if (name && name !== selfName) return cur;
            } catch (e) { /* ignore parse errors */ }
        }
    }
    // FALLBACK: two levels up (common when installed in node_modules)
    // If the package root isn't found within the upward walk, fall back
    // to a conservative two-levels-up default.
    return path.resolve(__dirname, '..', '..');
}

const PROJECT_ROOT = findProjectRoot();
const ROOT_NODE_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin');

const EXPO_CMD = path.join(ROOT_NODE_BIN, process.platform === 'win32' ? 'expo.cmd' : 'expo');
const ELECTRON_CMD = path.join(ROOT_NODE_BIN, process.platform === 'win32' ? 'electron.cmd' : 'electron');

const DEV_URL = process.env.EXPO_WEB_URL || 'http://localhost:8081';
const POLL_INTERVAL = 500;
const TIMEOUT_MS = 120000;

function parseMakeArg() {
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--make=')) {
            const val = a.split('=')[1] || '';
            return val.split(',').map((s) => s.trim()).filter(Boolean);
        }
        if (a === '--make') {
            const v = argv[i + 1];
            if (v && !v.startsWith('--')) return v.split(',').map((s) => s.trim()).filter(Boolean);
        }
    }
    return null;
}

function waitForUrl(url, timeoutMs = TIMEOUT_MS) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        (function poll() {
            const req = http.get(url, (res) => {
                res.resume();
                resolve(url);
            });
            req.on('error', () => {
                if (Date.now() - start > timeoutMs) {
                    reject(new Error('timeout waiting for ' + url));
                } else {
                    setTimeout(poll, POLL_INTERVAL);
                }
            });
            req.setTimeout(2000, () => req.abort());
        })();
    });
}

function copyRecursiveSkipExisting(src, dest, skipFiles = []) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            const s = path.join(src, entry);
            const d = path.join(dest, entry);
            if (skipFiles.includes(entry)) {
                console.log('Prebuild: skipping', entry, 'per skip list');
                continue;
            }
            if (fs.existsSync(d)) {
                // If destination exists and is a directory, recurse into it to
                // skip any existing children but copy missing ones. If it's a
                // file, skip and warn (do not overwrite).
                const dstStat = fs.statSync(d);
                const srcStat = fs.statSync(s);
                if (dstStat.isDirectory() && srcStat.isDirectory()) {
                    copyRecursiveSkipExisting(s, d, skipFiles);
                } else {
                    console.log('Prebuild: skipping existing', d);
                }
            } else {
                // Destination missing — perform a full copy
                if (fs.statSync(s).isDirectory()) {
                    copyRecursiveSkipExisting(s, d, skipFiles);
                } else {
                    fs.copyFileSync(s, d);
                    console.log('Prebuild: copied', d);
                }
            }
        }
    } else if (stat.isFile()) {
        if (fs.existsSync(dest)) {
            console.log('Prebuild: skipping existing', dest);
        } else {
            fs.copyFileSync(src, dest);
            console.log('Prebuild: copied', dest);
        }
    }
}

// Check for an executable in PATH using Node APIs only (cross-platform).
function commandExistsInPath(cmd) {
    const PATH = process.env.PATH || '';
    const parts = PATH.split(path.delimiter).filter(Boolean);
    if (process.platform === 'win32') {
        const pathext = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';');
        for (const dir of parts) {
            for (const ext of pathext) {
                const candidate = path.join(dir, cmd + ext);
                try { if (fs.existsSync(candidate)) return true; } catch (e) { }
            }
        }
        return false;
    }
    for (const dir of parts) {
        const candidate = path.join(dir, cmd);
        try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch (e) { }
    }
    return false;
}

function runCommand(cmdPath, args, options = {}) {
    return new Promise((resolve, reject) => {
        const spawnOptions = { stdio: ['inherit', 'inherit', 'inherit'], ...options };
        if (spawnOptions.shell === undefined && process.platform === 'win32') spawnOptions.shell = true;
        const p = spawn(cmdPath, args, spawnOptions);
        p.on('error', (err) => reject(err));
        p.on('exit', (code) => code === 0 ? resolve(0) : reject(new Error('exit ' + code)));
    });
}

function spawnExpoWeb() {
    // Build env without CI so Metro hot-reload remains enabled
    const env = Object.assign({}, process.env);
    delete env.CI;
    env.BROWSER = 'none';

    if (!fs.existsSync(EXPO_CMD)) {
        console.error('Missing expo binary. Run `npm install` at project root:', PROJECT_ROOT);
        process.exit(2);
    }
    console.log('Starting Expo (web) via', EXPO_CMD, 'start --web');
    const expoSpawnOpts = { stdio: 'inherit', env, cwd: PROJECT_ROOT };
    if (expoSpawnOpts.shell === undefined && process.platform === 'win32') expoSpawnOpts.shell = true;
    const child = spawn(EXPO_CMD, ['start', '--web'], expoSpawnOpts);
    child.on('error', (err) => console.error('Expo process error:', err && err.message));
    return child;
}

function spawnElectron(cwd, resolvedUrl) {
    console.log('Launching Electron in', cwd);
    const preloadPath = path.join(cwd, 'main', 'preload.js');
    const env = Object.assign({}, process.env, {
        EXPO_WEB_URL: resolvedUrl || DEV_URL,
        EXPO_PRELOAD_PATH: preloadPath,
        NODE_ENV: 'development',
    });
    const electronEntry = path.join(cwd, 'main', 'main.js');
    if (!fs.existsSync(ELECTRON_CMD)) {
        console.error('Missing electron binary. Run `npm install` at project root:', PROJECT_ROOT);
        process.exit(2);
    }
    console.log('Starting Electron via', ELECTRON_CMD, electronEntry);
    // Give Electron an ignored stdin so it does not steal terminal input from
    // the Expo process. Keep stdout/stderr inherited so logs still appear.
    const electronSpawnOpts = { stdio: ['ignore', 'inherit', 'inherit'], cwd, env };
    if (electronSpawnOpts.shell === undefined && process.platform === 'win32') electronSpawnOpts.shell = true;
    const child = spawn(ELECTRON_CMD, [electronEntry, '--no-sandbox'], electronSpawnOpts);
    child.on('error', (err) => console.error('Electron process error:', err && err.message));
    return child;
}

async function start() {
    // Ensure prebuild exists and generate autolink files into it
    try {
        prebuild();
        const projectElectron = path.join(PROJECT_ROOT, 'electron');
        const autolink = require(path.join(__dirname, 'lib', 'autolink'));
        autolink.run(PROJECT_ROOT, projectElectron);
    } catch (e) {
        console.warn('Autolink/prebuild failed:', e && e.message);
    }

    // Start Expo web dev server
    const expoProc = spawnExpoWeb();
    await waitForUrl(DEV_URL);

    const projectElectron = path.join(PROJECT_ROOT, 'electron');
    const cwd = fs.existsSync(projectElectron) ? projectElectron : path.join(__dirname);
    console.log('Using Electron working directory:', cwd);
    const electronProc = spawnElectron(cwd);

    // Centralized shutdown handling
    let isShuttingDown = false;
    let finalized = false;
    let livenessInterval = null;

    function alive(p) {
        if (!p || !p.pid) return false;
        try { process.kill(p.pid, 0); return true; } catch (e) { return false; }
    }

    function bothGone() {
        return !alive(expoProc) && !alive(electronProc);
    }

    function finalizeExit(code) {
        if (finalized) return;
        finalized = true;
        if (livenessInterval) { clearInterval(livenessInterval); livenessInterval = null; }
        process.exit(typeof code === 'number' ? code : 0);
    }

    function sendSigint(p) {
        if (!p || !p.pid) return;
        try { p.kill('SIGINT'); } catch (e) { }
    }

    function initiateShutdown(code) {
        if (isShuttingDown) return;
        isShuttingDown = true;
        sendSigint(expoProc);
        sendSigint(electronProc);
        if (bothGone()) return finalizeExit(code);
        // fall through and wait for exit events or liveness poll
    }

    // Handle expo exit: if electron still running, signal it; finalize when both gone
    expoProc.on('exit', (code) => {
        console.log('Expo exited', code);
        if (!isShuttingDown) sendSigint(electronProc);
        if (bothGone()) finalizeExit(code);
    });

    // Handle electron exit: if expo still running, signal it; finalize when both gone
    electronProc.on('exit', (code) => {
        console.log('Electron exited', code);
        if (!isShuttingDown) sendSigint(expoProc);
        if (bothGone()) finalizeExit(code);
    });

    // Periodic liveness check to cover edge cases where 'exit' isn't emitted
    livenessInterval = setInterval(() => {
        if (bothGone()) finalizeExit(0);
    }, 250);

    process.on('SIGINT', () => initiateShutdown(0));
    process.on('SIGTERM', () => initiateShutdown(0));
    process.on('SIGHUP', () => initiateShutdown(0));
}

function prebuild() {
    const target = path.join(PROJECT_ROOT, 'electron');
    const srcMain = path.join(__dirname, 'main');
    const tgtMain = path.join(target, 'main');

    if (!fs.existsSync(target)) {
        console.log('Prebuild: creating', target);
        fs.mkdirSync(target, { recursive: true });
    } else {
        // FALLBACK/PROTECT: target already exists — do not overwrite files.
        console.log('Prebuild: target already exists at', target, '- will not overwrite existing files.');
    }

    // Copy template main into target but DO NOT overwrite existing files.
    if (fs.existsSync(srcMain)) {
        // Do not copy the template preload into the project's prebuild.
        // The preload is generated by the autolinker and should not be
        // overwritten by the template. Skip `preload.js` during copy.
        copyRecursiveSkipExisting(srcMain, tgtMain, ['preload.js']);
    } else {
        console.warn('Prebuild: template main missing at', srcMain);
    }
    // Add a .gitignore in the prebuild folder to avoid checking in build outputs
    try {
        const gi = path.join(target, '.gitignore');
        if (!fs.existsSync(gi)) {
            fs.writeFileSync(gi, '.build\n');
            console.log('Prebuild: wrote', gi);
        } else {
            console.log('Prebuild: .gitignore already exists; leaving in place');
        }
    } catch (e) {
        console.error('Prebuild: failed to write .gitignore', e && e.message);
    }
    console.log('Prebuild: done. You can now edit the electron files at', target);
}

async function pack(makeMakers) {
    // Ensure prebuild exists; if not, run prebuild to create it (deterministic).
    const target = path.join(PROJECT_ROOT, 'electron');
    // Always run prebuild step so users get warnings if files would be
    // overwritten. prebuild itself will skip existing files rather than
    // overwriting them.
    try {
        // Run prebuild first to create the editable electron folder, then autolink into it
        prebuild();
        const projectElectron = path.join(PROJECT_ROOT, 'electron');
        try {
            const autolink = require(path.join(__dirname, 'lib', 'autolink'));
            autolink.run(PROJECT_ROOT, projectElectron);
        } catch (e) {
            console.warn('Autolink (package) failed:', e && e.message);
        }
    } catch (e) {
        console.error('Package: prebuild failed:', e && e.message);
        process.exit(3);
    }

    // Ensure binaries
    const ELECTRON_FORGE_CMD = path.join(ROOT_NODE_BIN, process.platform === 'win32' ? 'electron-forge.cmd' : 'electron-forge');
    if (!fs.existsSync(EXPO_CMD)) {
        console.error('Missing expo binary. Run `npm install` at project root:', PROJECT_ROOT);
        process.exit(2);
    }
    if (!fs.existsSync(ELECTRON_FORGE_CMD)) {
        console.error('Missing electron-forge binary. Run `npm install` at project root:', PROJECT_ROOT);
        process.exit(2);
    }

    // Build web into the project's prebuild `electron/.build` folder so
    // packaging uses the editable prebuilt electron folder but keeps the
    // static build separate from editable sources.
    const appOut = path.join(target, '.build');
    if (fs.existsSync(appOut)) {
        console.log('Removing existing build workspace at', appOut);
        try {
            // Node 14.14+ supports rmSync
            if (typeof fs.rmSync === 'function') {
                fs.rmSync(appOut, { recursive: true, force: true });
            } else {
                // rmdirSync recursive for older Node
                fs.rmdirSync(appOut, { recursive: true });
            }
        } catch (e) {
            console.error('Failed to remove existing build workspace at', appOut + ':', e && e.message);
            console.error('Per no-fallback policy this tool will not attempt alternative removal; please remove the folder manually and re-run packaging.');
            process.exit(1);
        }
    }
    // recreate empty packaging workspace
    fs.mkdirSync(appOut, { recursive: true });
    // Export web into an `app` subdirectory so packaged apps will find
    // `app/index.html` under the ASAR resources (expected by main.js).
    const webOut = path.join(appOut, 'app');
    console.log('Packaging: building Expo web into', webOut);
    // Deterministic behavior: detect whether the installed Expo CLI supports
    // the `export` command and run exactly that form. Do NOT attempt multiple
    // fallbacks — fail loudly if the expected command is not available.
    const helpCheck = require('child_process').spawnSync(EXPO_CMD, ['--help'], { encoding: 'utf8' });
    if (helpCheck.error) {
        console.error('Failed to execute expo --help:', helpCheck.error && helpCheck.error.message);
        process.exit(2);
    }
    const helpOut = String(helpCheck.stdout || '') + String(helpCheck.stderr || '');
    if (helpOut.includes('export')) {
        const args = ['export', '.', '--output-dir', webOut, '-p', 'web'];
        console.log('Running:', EXPO_CMD, args.join(' '));
        try {
            // Ensure output dir exists
            if (!fs.existsSync(webOut)) fs.mkdirSync(webOut, { recursive: true });
            await runCommand(EXPO_CMD, args, { cwd: PROJECT_ROOT });
        } catch (e) {
            console.error('Expo export failed:', e && e.message);
            process.exit(4);
        }
        // FALLBACK/ADAPT: Ensure index.html uses relative asset paths when opened via file://
        // This transforms export output so the packaged app can load static
        // assets from file:// locations. It's a deterministic post-export
        // transformation to adapt web export output for packaging.
        try {
            const indexPath = path.join(webOut, 'index.html');
            if (fs.existsSync(indexPath)) {
                let html = fs.readFileSync(indexPath, 'utf8');
                // Inject a base href if missing
                if (!/\<base[^>]*href=/.test(html)) {
                    const headIndex = html.indexOf('<head>');
                    if (headIndex !== -1) {
                        const insertAt = headIndex + '<head>'.length;
                        html = html.slice(0, insertAt) + '\n  <base href="./">' + html.slice(insertAt);
                    }
                }
                // Convert root-absolute asset references like src="/_expo/..." or href="/static/..."
                // to relative references so file:// loads work. Only targets attribute patterns
                // to avoid touching protocol URLs.
                html = html.replace(/(\b(?:src|href)\s*=\s*['"])\//gi, '$1./');
                fs.writeFileSync(indexPath, html, 'utf8');
                console.log('Post-export: fixed asset paths and ensured base href in', indexPath);
            }
        } catch (e) {
            console.warn('Post-export: failed to adjust index.html for file:// usage:', e && e.message);
        }
    } else {
        console.error('Installed expo CLI does not advertise an `export` command.');
        console.error('Per project policy this tool will not try fallback commands.');
        console.error('Please run the appropriate web build/export for your Expo CLI manually from the project root, e.g. `expo export . --output-dir <dir> -p web`, then re-run this command.');
        process.exit(4);
    }

    // Run electron-forge make from a temporary packaging workspace inside the
    // project's `electron/.build` directory so all outputs live under that
    // folder. Create a minimal packaging workspace there and run `make`.
    console.log('Packaging: running electron-forge make in packaging workspace');
    const originalPkgPath = path.join(__dirname, 'package.json');
    let originalPkg = null;
    const workPkgPath = path.join(appOut, 'package.json');
    try {
        if (!fs.existsSync(appOut)) fs.mkdirSync(appOut, { recursive: true });

        // Copy electron main files into the workspace so packaging is self-contained
        const projectMain = path.join(target, 'main');
        const workMain = path.join(appOut, 'main');
        // Copy into the workspace but SKIP existing files so developer edits
        // are preserved and not clobbered.
        if (fs.existsSync(projectMain)) {
            copyRecursiveSkipExisting(projectMain, workMain);
        }

        // Copy any autolink-generated electron resources into the packaging
        // workspace so native files (and electron/ folders from modules) are
        // available to the packager. The autolinker writes an
        // `electron-resources.json` file into the project's `electron/`
        // folder describing {from,to} entries relative to the project root.
        try {
            const resourcesPath = path.join(target, 'electron-resources.json');
            if (fs.existsSync(resourcesPath)) {
                const resources = JSON.parse(fs.readFileSync(resourcesPath, 'utf8')) || [];
                for (const r of resources) {
                    try {
                        // source is project-root relative
                        const src = path.join(PROJECT_ROOT, r.from || '');
                        const dest = path.join(appOut, r.to || '');
                        if (!fs.existsSync(src)) {
                            console.warn('Packaging: autolink resource missing, skipping', src);
                            continue;
                        }
                        // Ensure destination parent exists
                        const dpar = path.dirname(dest);
                        if (!fs.existsSync(dpar)) fs.mkdirSync(dpar, { recursive: true });
                        // Copy resource (preserve directories)
                        copyRecursiveSkipExisting(src, dest);
                        console.log('Packaging: copied autolink resource', src, '->', dest);
                    } catch (e) {
                        console.warn('Packaging: failed to copy autolink resource', e && e.message);
                    }
                }
            } else {
                console.log('Packaging: no autolink resources file at', resourcesPath);
            }
        } catch (e) {
            console.warn('Packaging: failed to apply autolink resources:', e && e.message);
        }

        // Do not inherit any Forge config from the template package.json.
        // The CLI controls the Forge configuration for the packaging workspace
        // to ensure predictable makers and packager settings for every project.

        // Read project package.json to pull name/version/description
        const projectPkgPath = path.join(PROJECT_ROOT, 'package.json');
        let projectPkg = {};
        try {
            if (fs.existsSync(projectPkgPath)) projectPkg = JSON.parse(fs.readFileSync(projectPkgPath, 'utf8'));
        } catch (e) { /* ignore */ }

        // Build a minimal, deterministic workspace package.json using project values
        const workPkg = {
            name: projectPkg.name ? `${projectPkg.name}-electron` : 'expo-electron-workspace',
            version: projectPkg.version || '1.0.0',
            description: projectPkg.description || projectPkg.productName || projectPkg.name || 'Expo Electron App',
            main: 'main/main.js',
            devDependencies: projectPkg.devDependencies || { "electron": "*" },
        };
        // Inject a sensible default Forge config so `electron-forge make` has
        // makers and packager settings to run deterministically.
        const defaultForgeConfig = {
            packagerConfig: {
                asar: true,
                asarUnpack: ['**/*.node'],
                // Ensure native folders copied outside the ASAR so `.node`
                // binaries can be loaded directly at runtime. We copy
                // autolink resources into `native/` in the workspace, so
                // include that folder as an extra resource.
                extraResource: ['native']
            },
            makers: [
                { name: '@electron-forge/maker-squirrel', config: {} },
                { name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux'] },
                { name: '@electron-forge/maker-deb', config: {} },
                { name: '@electron-forge/maker-rpm', config: {} }
            ]
        };
        // Only run `make` when the user explicitly requested makers via
        // `--make`. If no `--make` was provided, skip the making step and
        // keep the packaging workspace suitable for inspection.
        let skipMake = false;
        if (Array.isArray(makeMakers) && makeMakers.length > 0) {
            const tokens = makeMakers.map((t) => String(t).toLowerCase());
            defaultForgeConfig.makers = (defaultForgeConfig.makers || []).filter((m) => {
                const n = (m && m.name) || (typeof m === 'string' ? m : '');
                const lower = String(n).toLowerCase();
                return tokens.some((tok) => lower.includes(tok));
            });
            if (!defaultForgeConfig.makers || defaultForgeConfig.makers.length === 0) {
                console.log('Packaging: --make provided but no matching makers found; will skip `make`.');
                skipMake = true;
            } else {
                console.log('Packaging: filtered makers to', defaultForgeConfig.makers.map((m) => (m && m.name) || m));
            }
        } else {
            // No --make provided: skip the make step entirely by clearing makers.
            skipMake = true;
            defaultForgeConfig.makers = [];
            console.log('Packaging: no --make provided; skipping distributable creation (electron-forge make).');
        }
        workPkg.config = { forge: defaultForgeConfig };

        // Note: makers are filtered only when `--make` is provided; no
        // automatic removal of makers is performed here.

        fs.writeFileSync(workPkgPath, JSON.stringify(workPkg, null, 2), 'utf8');

        // Always run `electron-forge package` so packaging hooks and the
        // packaging step run (this produces the packaged application but
        // not the final distributables). Only run `electron-forge make`
        // when the user explicitly requested makers via `--make`.
        try {
            console.log('Packaging: running electron-forge package');
            await runCommand(ELECTRON_FORGE_CMD, ['package'], { cwd: appOut });
        } catch (e) {
            console.error('electron-forge package failed:', e && e.message);
            process.exit(5);
        }

        const makersInWorkspace = (((workPkg || {}).config || {}).forge || {}).makers || [];
        if (!skipMake && Array.isArray(makersInWorkspace) && makersInWorkspace.length > 0) {
            console.log('Packaging: running electron-forge make');
            await runCommand(ELECTRON_FORGE_CMD, ['make'], { cwd: appOut });
        } else {
            console.log('Packaging: skipping electron-forge make');
        }
    } catch (e) {
        console.error('electron-forge make failed:', e && e.message);
        // preserve workspace for inspection
        process.exit(5);
    }
    // preserve workspace package.json and outputs for inspection
    const artifactsPath = path.join(appOut, 'out', 'make');
    console.log('Packaging: complete — artifacts available at:', artifactsPath);
}

if (require.main === module) {
    const cmd = process.argv[2] || 'start';
    if (cmd === 'start') start();
    else if (cmd === 'prebuild') { prebuild(); process.exit(0); }
    else if (cmd === 'package') {
        const makeMakers = parseMakeArg();
        pack(makeMakers);
    }
    else if (cmd === 'autolink') {
        try {
            // ensure prebuild folder exists so generated files can be placed there
            prebuild();
            const projectElectron = path.join(PROJECT_ROOT, 'electron');
            const autolink = require(path.join(__dirname, 'lib', 'autolink'));
            autolink.run(PROJECT_ROOT, projectElectron);
            process.exit(0);
        } catch (e) {
            console.error('autolink failed:', e && e.message);
            process.exit(1);
        }
    } else console.error('unknown command', cmd);
}
