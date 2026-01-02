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
    // fallback: two levels up (common when installed in node_modules)
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
    const child = spawn(EXPO_CMD, ['start', '--web'], { stdio: 'inherit', env });
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
    const child = spawn(ELECTRON_CMD, [electronEntry], { stdio: 'inherit', cwd, env });
    child.on('error', (err) => console.error('Electron process error:', err && err.message));
    return child;
}

async function start() {
    // Start Expo web dev server
    const expoProc = spawnExpoWeb();

    // Wait for one of the likely web endpoints to be ready (check in parallel).
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

function prebuild() {
    const target = path.join(PROJECT_ROOT, 'electron');
    if (fs.existsSync(target)) {
        console.log('Prebuild: target already exists at', target);
        process.exit(0);
    }
    console.log('Prebuild: creating', target);
    fs.mkdirSync(target, { recursive: true });
    const srcMain = path.join(__dirname, 'main');
    const tgtMain = path.join(target, 'main');
    copyRecursive(srcMain, tgtMain);
    // Add a .gitignore in the prebuild folder to avoid checking in build outputs
    try {
        const gi = path.join(target, '.gitignore');
        if (!fs.existsSync(gi)) {
            fs.writeFileSync(gi, '.build\n');
            console.log('Prebuild: wrote', gi);
        }
    } catch (e) {
        console.error('Prebuild: failed to write .gitignore', e && e.message);
    }
    console.log('Prebuild: copied template main to', tgtMain);
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
    if (!fs.existsSync(target)) {
        console.log('Package: project electron/ not found, running prebuild to generate it.');
        prebuild();
        if (!fs.existsSync(target)) {
            console.error('Package: prebuild failed to create', target);
            process.exit(3);
        }
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
        console.log('Cleaning existing build at', appOut);
        const rmrf = (p) => {
            if (!fs.existsSync(p)) return;
            for (const entry of fs.readdirSync(p)) {
                const ePath = path.join(p, entry);
                try {
                    const st = fs.lstatSync(ePath);
                    if (st.isDirectory()) rmrf(ePath); else fs.unlinkSync(ePath);
                } catch (err) {
                    // best-effort: report and continue
                    console.error('Failed to remove', ePath, err && err.message);
                }
            }
            try { fs.rmdirSync(p); } catch (err) { /* ignore */ }
        };
        rmrf(appOut);
    }
    fs.mkdirSync(appOut, { recursive: true });
    console.log('Packaging: building Expo web into', appOut);
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
        const args = ['export', '.', '--output-dir', appOut, '-p', 'web'];
        console.log('Running:', EXPO_CMD, args.join(' '));
        try {
            await runCommand(EXPO_CMD, args, { cwd: PROJECT_ROOT });
        } catch (e) {
            console.error('Expo export failed:', e && e.message);
            process.exit(4);
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
        if (fs.existsSync(workMain)) {
            // remove existing workMain to ensure fresh copy
            const rmrf = (p) => {
                if (!fs.existsSync(p)) return;
                for (const entry of fs.readdirSync(p)) {
                    const ePath = path.join(p, entry);
                    if (fs.lstatSync(ePath).isDirectory()) rmrf(ePath); else fs.unlinkSync(ePath);
                }
                fs.rmdirSync(p);
            };
            rmrf(workMain);
        }
        if (fs.existsSync(projectMain)) copyRecursive(projectMain, workMain);

        // Read original package.json from the package and adapt it for the
        // packaging workspace.
        if (fs.existsSync(originalPkgPath)) {
            originalPkg = fs.readFileSync(originalPkgPath, 'utf8');
            const pkgJson = JSON.parse(originalPkg);
            // Create a workspace-specific package.json that points main to
            // the copied main entry inside the workspace.
            const workPkg = Object.assign({}, pkgJson);
            workPkg.name = workPkg.name || (pkgJson.productName || 'expo-electron-workspace');
            workPkg.main = 'main/main.js';
            // Ensure description exists for deb maker
            if (!workPkg.description && !workPkg.productDescription) workPkg.description = workPkg.productName || workPkg.name || 'Expo Electron App';

            // If rpmbuild is missing, remove rpm makers from the copy so make
            // doesn't fail (we avoid modifying the package's package.json).
            const makers = (((workPkg || {}).config || {}).forge || {}).makers || [];
            const hasRpm = makers.some((m) => {
                const n = (m && m.name) || (typeof m === 'string' ? m : '');
                return String(n).toLowerCase().includes('rpm');
            });
            if (hasRpm) {
                const which = require('child_process').spawnSync('which', ['rpmbuild']);
                if (which.status !== 0) {
                    workPkg.config = workPkg.config || {};
                    workPkg.config.forge = workPkg.config.forge || {};
                    workPkg.config.forge.makers = makers.filter((m) => {
                        const n = (m && m.name) || (typeof m === 'string' ? m : '');
                        return !String(n).toLowerCase().includes('rpm');
                    });
                    console.log('rpmbuild not found; removed rpm maker from workspace package.json');
                }
            }

            fs.writeFileSync(workPkgPath, JSON.stringify(workPkg, null, 2), 'utf8');
        }

        // Run electron-forge make with cwd set to the workspace so outputs are
        // placed under appOut/out/make
        await runCommand(ELECTRON_FORGE_CMD, ['make'], { cwd: appOut });
    } catch (e) {
        console.error('electron-forge make failed:', e && e.message);
        // cleanup workspace package.json if we created one
        try { if (fs.existsSync(workPkgPath)) fs.unlinkSync(workPkgPath); } catch (_) { }
        process.exit(5);
    }
    // cleanup workspace package.json (leave workMain and outputs intact)
    try { if (fs.existsSync(workPkgPath)) fs.unlinkSync(workPkgPath); } catch (err) { console.error('Failed to remove workspace package.json:', err && err.message); }
    console.log('Packaging: complete — check the out/ folder under', __dirname);
}

if (require.main === module) {
    const cmd = process.argv[2] || 'start';
    if (cmd === 'start') start();
    else if (cmd === 'prebuild') prebuild();
    else if (cmd === 'package') pack();
    else console.error('unknown command', cmd);
}
