#!/usr/bin/env node
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

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

    // Require local expo binary; do not fall back to npx
    const localExpo = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'expo.cmd' : 'expo');
    if (!fs.existsSync(localExpo)) {
        console.error('Local expo binary not found at', localExpo, '\nPlease run `npm install` in the project root to install dependencies.');
        process.exit(1);
    }
    console.log('Using local expo binary at', localExpo);
    return spawn(localExpo, ['start', '--web'], { stdio: 'inherit', env });
}

function spawnElectron(cwd, resolvedUrl) {
    console.log('Launching Electron in', cwd);
    const preloadPath = path.join(cwd, 'main', 'preload.js');
    const env = Object.assign({}, process.env, {
        EXPO_WEB_URL: resolvedUrl || process.env.EXPO_WEB_URL || DEV_URL,
        EXPO_PRELOAD_PATH: preloadPath,
    });
    const electronEntry = path.join(cwd, 'main', 'main.js');
    // Require local electron binary; do not fall back to npx
    const localElectron = path.join(cwd, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    if (!fs.existsSync(localElectron)) {
        console.error('Local electron binary not found at', localElectron, '\nPlease run `npm install` in the project root to install dependencies.');
        process.exit(1);
    }
    console.log('Using local electron binary at', localElectron);
    const proc = spawn(localElectron, [electronEntry], { stdio: 'inherit', cwd, env });
    proc.on('error', (err) => console.error('Electron process error:', err && err.message));
    proc.on('exit', (code) => { if (code && code !== 0) process.exit(code); });
    return proc;
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

    // Launch electron pointing at the local expo-electron folder
    const cwd = path.join(__dirname);
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

if (require.main === module) {
    const cmd = process.argv[2] || 'start';
    if (cmd === 'start') start(); else console.error('unknown command');
}
