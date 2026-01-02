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

const DEV_URL = process.env.EXPO_WEB_URL || 'http://localhost:19006';
const POLL_INTERVAL = 500;
const TIMEOUT_MS = 120000;

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
    const child = spawn(EXPO_CMD, ['start', '--web'], { stdio: 'inherit', env, cwd: PROJECT_ROOT });
    child.on('error', (err) => console.error('Expo process error:', err && err.message));
    return child;
}

function spawnElectron(cwd, resolvedUrl) {
    console.log('Launching Electron in', cwd);
    const preloadPath = path.join(cwd, 'main', 'preload.js');
    const env = Object.assign({}, process.env, {
        EXPO_WEB_URL: resolvedUrl || process.env.EXPO_WEB_URL || DEV_URL,
        EXPO_PRELOAD_PATH: preloadPath,
    });
    const electronEntry = path.join(cwd, 'main', 'main.js');
    if (!fs.existsSync(ELECTRON_CMD)) {
        console.error('Missing electron binary. Run `npm install` at project root:', PROJECT_ROOT);
        process.exit(2);
    }
    console.log('Starting Electron via', ELECTRON_CMD, electronEntry);
    // Give Electron an ignored stdin so it does not steal terminal input from
    // the Expo process. Keep stdout/stderr inherited so logs still appear.
    const child = spawn(ELECTRON_CMD, [electronEntry], { stdio: ['ignore', 'inherit', 'inherit'], cwd, env });
    child.on('error', (err) => console.error('Electron process error:', err && err.message));
    return child;
}

async function start() {
    // Start Expo web dev server
    const expoProc = spawnExpoWeb();

    // Wait for one of the likely web endpoints to be ready (check in parallel).
    // FALLBACK/DEV-CONVENIENCE: probe multiple known dev endpoints and use
    // whichever responds first. This is intended for development only.
    const candidates = Array.from(new Set([process.env.EXPO_WEB_URL || DEV_URL, 'http://localhost:8081', 'http://localhost:19006']));
    let resolvedUrl = null;
    try {
        const checks = candidates.map((url) => waitForUrl(url));
        const overall = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for any candidate')), TIMEOUT_MS));
        resolvedUrl = await Promise.race([overall, ...checks]);
    } catch (e) {
        console.error('expo web did not become ready on known ports:', e && e.message);
        process.exit(1);
    }

    console.log('Detected Expo web URL:', resolvedUrl);

    // Prefer a project-level `electron/` (created by `expo-electron prebuild`).
    // FALLBACK: if a project-level `electron/` is not present, use the
    // packaged template from this package. This allows editable prebuilds.
    const projectElectron = path.join(PROJECT_ROOT, 'electron');
    const cwd = fs.existsSync(projectElectron) ? projectElectron : path.join(__dirname);
    console.log('Using Electron working directory:', cwd);
    // pass detected URL to electron env
    process.env.EXPO_WEB_URL = resolvedUrl;
    const electronProc = spawnElectron(cwd, resolvedUrl);

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

function copyRecursive(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dest, entry));
        }
    } else if (stat.isFile()) {
        fs.copyFileSync(src, dest);
    }
}

// Recursive copy that SKIPS existing destination files and logs a warning;
// useful for prebuild and packaging where we must not overwrite developer edits.
// FALLBACK/PROTECT: this intentionally avoids overwriting existing files
// created by a developer; existing files are preserved and skipped.
function copyRecursiveSkipExisting(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            const s = path.join(src, entry);
            const d = path.join(dest, entry);
            if (fs.existsSync(d)) {
                // If destination exists and is a directory, recurse into it to
                // skip any existing children but copy missing ones. If it's a
                // file, skip and warn (do not overwrite).
                const dstStat = fs.statSync(d);
                const srcStat = fs.statSync(s);
                if (dstStat.isDirectory() && srcStat.isDirectory()) {
                    copyRecursiveSkipExisting(s, d);
                } else {
                    console.log('Prebuild: skipping existing', d);
                }
            } else {
                // Destination missing — perform a full copy
                if (fs.statSync(s).isDirectory()) {
                    copyRecursiveSkipExisting(s, d);
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
        copyRecursiveSkipExisting(srcMain, tgtMain);
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

function runCommand(cmdPath, args, options = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmdPath, args, Object.assign({ stdio: 'inherit' }, options));
        p.on('error', (err) => reject(err));
        p.on('exit', (code) => code === 0 ? resolve(0) : reject(new Error('exit ' + code)));
    });
}

async function pack() {
    // Ensure prebuild exists; if not, run prebuild to create it (deterministic).
    const target = path.join(PROJECT_ROOT, 'electron');
    // Always run prebuild step so users get warnings if files would be
    // overwritten. prebuild itself will skip existing files rather than
    // overwriting them.
    try {
        prebuild();
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

        // Read original package.json from the package and adapt it for the
        // packaging workspace.
        if (fs.existsSync(originalPkgPath)) {
            // Read template package.json (from the expo-electron package)
            originalPkg = fs.readFileSync(originalPkgPath, 'utf8');
        }
        let templateCfgForge = null;
        try {
            if (originalPkg) {
                const t = JSON.parse(originalPkg);
                templateCfgForge = ((t.config || {}).forge) || null;
            }
        } catch (e) { /* ignore template parse errors */ }

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
        if (templateCfgForge) {
            workPkg.config = { forge: templateCfgForge };
        }

        // FALLBACK: If rpmbuild is not available on the host PATH, remove
        // any RPM maker entries from the Forge config so `electron-forge` does
        // not attempt an RPM build that would fail. This keeps packaging
        // functional on systems without rpmbuild.
        const makers = (((workPkg || {}).config || {}).forge || {}).makers || [];
        const hasRpm = makers.some((m) => {
            const n = (m && m.name) || (typeof m === 'string' ? m : '');
            return String(n).toLowerCase().includes('rpm');
        });
        if (hasRpm) {
            if (!commandExistsInPath('rpmbuild')) {
                workPkg.config = workPkg.config || {};
                workPkg.config.forge = workPkg.config.forge || {};
                workPkg.config.forge.makers = makers.filter((m) => {
                    const n = (m && m.name) || (typeof m === 'string' ? m : '');
                    return !String(n).toLowerCase().includes('rpm');
                });
                console.log('rpmbuild not found in PATH; removed rpm maker from workspace package.json');
            }
        }

        fs.writeFileSync(workPkgPath, JSON.stringify(workPkg, null, 2), 'utf8');

        // Run electron-forge make with cwd set to the workspace so outputs are
        // placed under appOut/out/make
        await runCommand(ELECTRON_FORGE_CMD, ['make'], { cwd: appOut });
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
    else if (cmd === 'package') pack();
    else console.error('unknown command', cmd);
}
