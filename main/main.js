const { app, BrowserWindow, ipcMain, session, nativeTheme, clipboard, dialog, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');

const { createDeepLinkBridge } = require('./deeplinks');
const { installCspHeaders } = require('./csp');
const { createDesktopBridge } = require('./desktop');

let mainWindow;
const DEV_URL = process.env.EXPO_WEB_URL || 'http://localhost:8081';
const PROD_INDEX = path.join(__dirname, '..', 'app', 'index.html');

const deepLinks = createDeepLinkBridge({ app });
const desktop = createDesktopBridge({ app, ipcMain, nativeTheme, clipboard, dialog, shell, powerMonitor });

desktop.registerIpcHandlers();

function createWindow() {
    const preloadPath = process.env.EXPO_PRELOAD_PATH ? path.resolve(process.env.EXPO_PRELOAD_PATH) : path.join(__dirname, 'preload.js');
    mainWindow = new BrowserWindow({
        width: 480,
        height: 960,
        webPreferences: {
            preload: preloadPath,
            webviewTag: true,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        },
    });
    deepLinks.setMainWindow(mainWindow);
    desktop.setMainWindow(mainWindow);

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
        installCspHeaders({ session });
        createWindow();
        desktop.startEventForwarding();

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

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
