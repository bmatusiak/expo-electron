const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

const { createDeepLinkBridge } = require('./deeplinks');

let mainWindow;
const DEV_URL = process.env.EXPO_WEB_URL || 'http://localhost:8081';
const PROD_INDEX = path.join(__dirname, '..', 'app', 'index.html');

const deepLinks = createDeepLinkBridge({ app });

const DEFAULT_CSP_PROD = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    // Script inline is disabled by default; if your exported HTML needs it,
    // set EXPO_ELECTRON_CSP to override.
    "script-src 'self'",
    "connect-src 'self' https: wss:",
].join('; ');

const DEFAULT_CSP_DEV = [
    // Dev server + HMR need localhost + websockets and often eval.
    "default-src 'self' http://localhost:* ws://localhost:*",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-eval' 'unsafe-inline' http://localhost:*",
    "connect-src 'self' http://localhost:* ws://localhost:* https: wss:",
].join('; ');

function installCspHeaders() {
    const disabled = ['1', 'true', 'yes'].includes(String(process.env.EXPO_ELECTRON_NO_CSP || '').toLowerCase());
    if (disabled) return;

    const isDev = process.env.NODE_ENV === 'development';
    const csp = process.env.EXPO_ELECTRON_CSP || (isDev ? DEFAULT_CSP_DEV : DEFAULT_CSP_PROD);
    if (!csp) return;

    try {
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
            const responseHeaders = details.responseHeaders || {};
            const existingKey = Object.keys(responseHeaders).find((k) => k.toLowerCase() === 'content-security-policy');
            responseHeaders[existingKey || 'Content-Security-Policy'] = [csp];
            callback({ responseHeaders });
        });
    } catch (e) {
        console.warn('Failed to install CSP headers:', e && e.message);
    }
}

function createWindow() {
    const preloadPath = process.env.EXPO_PRELOAD_PATH ? path.resolve(process.env.EXPO_PRELOAD_PATH) : path.join(__dirname, 'preload.js');
    mainWindow = new BrowserWindow({
        width: 480,
        height: 960,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        },
    });
    deepLinks.setMainWindow(mainWindow);

    // Determine whether a production index exists in the packaged app.
    // If the production index is present we prefer it (packaged apps should
    // always load local files). Only fall back to the dev server when a
    // production build is not available and NODE_ENV indicates development.
    const isDev = process.env.NODE_ENV === 'development';
    const hasProdIndex = fs.existsSync(PROD_INDEX);

    if (hasProdIndex) {
        mainWindow.loadFile(PROD_INDEX).catch((err) => {
            console.error('Failed to load production index', PROD_INDEX, err);
            app.exit(1);
        });
    } else if (isDev && DEV_URL) {
        mainWindow.loadURL(DEV_URL).catch((err) => {
            console.error('Failed to load dev URL', DEV_URL, err);
            app.exit(1);
        });
    } else {
        console.error('No production index found and dev server not available at', DEV_URL);
        app.exit(1);
    }
}

// electron-squirrel-startup is only needed for Squirrel.Windows install/uninstall events.
let isSquirrelStartup = !!require('electron-squirrel-startup');
if (isSquirrelStartup) {
    app.quit();
} else if (deepLinks.gotTheLock) {
    app.whenReady().then(() => {
        deepLinks.registerProtocols();
        installCspHeaders();
        createWindow();

        if (process.env.NODE_ENV === 'development') {
            try {
                const watchDir = path.join(__dirname);
                fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
                    if (!filename) return;
                    if (mainWindow && mainWindow.webContents) {
                        mainWindow.webContents.send('main-changed', { event: eventType, file: filename });
                    }
                });
            } catch (e) {
                console.warn('watcher failed', e && e.message);
            }
        }
    });
}

ipcMain.handle('restart-main', async () => {
    try {
        app.relaunch();
        app.exit(0);
    } catch (e) {
        console.error('failed to relaunch', e);
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
