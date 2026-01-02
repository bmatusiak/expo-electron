const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
const DEV_URL = process.env.EXPO_WEB_URL || 'http://localhost:19006';
const PROD_INDEX = path.join(__dirname, '..', 'app', 'index.html');

function createWindow() {
    const preloadPath = process.env.EXPO_PRELOAD_PATH ? path.resolve(process.env.EXPO_PRELOAD_PATH) : path.join(__dirname, 'preload.js');
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    var ok;

    if (process.env.NODE_ENV === 'development') {
        mainWindow.loadURL(DEV_URL).catch(() => { });
    } else {
        mainWindow.loadFile(PROD_INDEX).catch(() => { });
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
