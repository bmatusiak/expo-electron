const path = require('path');
const fs = require('fs');

function _truthyEnv(name) {
    return ['1', 'true', 'yes'].includes(String(process.env[name] || '').toLowerCase());
}

function _sanitizeProtocol(raw) {
    if (!raw) return null;
    let s = String(raw).trim().toLowerCase();
    // Only characters allowed by RFC 3986 scheme production.
    s = s.replace(/[^a-z0-9+.-]/g, '');
    if (!/^[a-z][a-z0-9+.-]*$/.test(s)) return null;
    return s;
}

function _unique(arr) {
    const out = [];
    const seen = new Set();
    for (const v of arr || []) {
        const s = String(v || '').trim();
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}

function _readJsonSafe(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return null;
    }
}

function _readProtocolsFromPackageJson(app) {
    try {
        const pkgPath = path.join(app.getAppPath(), 'package.json');
        const pkg = _readJsonSafe(pkgPath);
        const proto = (((pkg || {}).expoElectron || {}).protocols || []);
        if (Array.isArray(proto)) return proto;
        if (typeof proto === 'string') return [proto];
        return [];
    } catch (e) {
        return [];
    }
}

function _readProtocolsFromAppJson(app) {
    const candidates = [
        path.join(process.cwd(), 'app.json'),
        path.join(process.cwd(), '..', 'app.json'),
        (() => {
            try { return path.join(app.getAppPath(), 'app.json'); } catch (e) { return null; }
        })(),
    ].filter(Boolean);

    for (const p of candidates) {
        const cfg = _readJsonSafe(p);
        const expo = (cfg || {}).expo;
        if (!expo) continue;
        const scheme = expo.scheme;
        const schemes = expo.schemes;
        if (typeof scheme === 'string' && scheme.trim()) return [scheme.trim()];
        if (Array.isArray(schemes)) return schemes;
    }
    return [];
}

function getConfiguredProtocols(app) {
    const envRaw = process.env.EXPO_ELECTRON_PROTOCOLS || process.env.EXPO_ELECTRON_PROTOCOL;
    const fromEnv = String(envRaw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const fromPkg = _readProtocolsFromPackageJson(app);
    const fromApp = _readProtocolsFromAppJson(app);

    const merged = _unique([...fromEnv, ...fromPkg, ...fromApp])
        .map(_sanitizeProtocol)
        .filter((p) => typeof p === 'string');

    if (merged.length > 0) return merged;

    // Last resort: derive a scheme from the Electron app name.
    const fallback = _sanitizeProtocol(String(app.getName ? app.getName() : 'app'));
    return fallback ? [fallback] : [];
}

function createDeepLinkBridge({ app }) {
    const PROTOCOLS = getConfiguredProtocols(app);

    let mainWindow = null;
    let pendingDeepLinkUrl = null;

    function extractDeepLinkFromArgv(argv) {
        if (!Array.isArray(argv) || PROTOCOLS.length === 0) return null;
        for (const arg of argv) {
            if (typeof arg !== 'string') continue;
            for (const protocol of PROTOCOLS) {
                if (arg.toLowerCase().startsWith(`${protocol}://`)) return arg;
            }
        }
        return null;
    }

    function focusWindow() {
        if (!mainWindow) return;
        try {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        } catch (e) { }
    }

    function flushPendingDeepLink() {
        if (!pendingDeepLinkUrl) return;
        if (!mainWindow || !mainWindow.webContents) return;
        try {
            mainWindow.webContents.send('on-deep-link', pendingDeepLinkUrl);
            pendingDeepLinkUrl = null;
        } catch (e) { }
    }

    function sendUrlToRenderer(url) {
        if (!url) return;
        pendingDeepLinkUrl = url;
        if (!mainWindow || !mainWindow.webContents) return;

        try {
            // If the renderer isn't ready yet, keep it pending and flush on did-finish-load.
            if (mainWindow.webContents.isLoadingMainFrame && mainWindow.webContents.isLoadingMainFrame()) return;
            mainWindow.webContents.send('on-deep-link', url);
            pendingDeepLinkUrl = null;
        } catch (e) {
            // keep pending
        }
    }

    function registerProtocols() {
        if (!PROTOCOLS || PROTOCOLS.length === 0) return;
        for (const protocol of PROTOCOLS) {
            try {
                if (process.defaultApp) {
                    if (process.argv.length >= 2) {
                        app.setAsDefaultProtocolClient(protocol, process.execPath, [path.resolve(process.argv[1])]);
                    }
                } else {
                    app.setAsDefaultProtocolClient(protocol);
                }
            } catch (e) {
                console.warn('Failed to register protocol', protocol + ':', e && e.message);
            }
        }
    }

    // Capture cold-start deep link (Windows/Linux pass it via argv)
    pendingDeepLinkUrl = extractDeepLinkFromArgv(process.argv) || pendingDeepLinkUrl;

    // macOS deep linking
    app.on('open-url', (event, url) => {
        try { event.preventDefault(); } catch (e) { }
        sendUrlToRenderer(url);
        focusWindow();
    });

    // Windows/Linux deep linking via single-instance handoff
    const disableSingleInstance = _truthyEnv('EXPO_ELECTRON_NO_SINGLE_INSTANCE');
    let gotTheLock = true;
    if (!disableSingleInstance) {
        gotTheLock = app.requestSingleInstanceLock();
        if (!gotTheLock) {
            app.quit();
        } else {
            app.on('second-instance', (event, argv) => {
                const url = extractDeepLinkFromArgv(argv);
                if (url) sendUrlToRenderer(url);
                focusWindow();
            });
        }
    }

    function setMainWindow(win) {
        mainWindow = win;
        try {
            if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.on('did-finish-load', () => {
                    flushPendingDeepLink();
                });
            }
        } catch (e) { }
        flushPendingDeepLink();
    }

    return {
        protocols: PROTOCOLS,
        gotTheLock,
        registerProtocols,
        setMainWindow,
    };
}

module.exports = {
    getConfiguredProtocols,
    createDeepLinkBridge,
};
