const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
const DEV_URL = process.env.EXPO_WEB_URL || 'http://localhost:8081';
const PROD_INDEX = path.join(__dirname, '..', 'app', 'index.html');

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

    // Prefer a running dev server during development. In production require
    // the local built `index.html` so production builds never try to reach Metro.
    const isDev = process.env.NODE_ENV === 'development';

    if (isDev && DEV_URL) {
        mainWindow.loadURL(DEV_URL).catch((err) => {
            console.error('Failed to load dev URL', DEV_URL, err);
            app.exit(1);
        });
    } else {
        if (!fs.existsSync(PROD_INDEX)) {
            console.error('Production index not found at', PROD_INDEX);
            app.exit(1);
        }
        mainWindow.loadFile(PROD_INDEX).catch((err) => {
            console.error('Failed to load production index', PROD_INDEX, err);
            app.exit(1);
        });
    }
}

app.whenReady().then(() => {
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
