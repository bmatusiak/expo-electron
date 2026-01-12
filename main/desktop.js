const path = require('path');
const fs = require('fs');

function _isFilePathString(p) {
    return typeof p === 'string' && p.length > 0;
}

function _fileExists(p) {
    try { return !!(p && fs.existsSync(p)); } catch (e) { return false; }
}

function _sanitizeOpenExternalUrl(url) {
    if (typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    // Only allow a small set of schemes to reduce abuse.
    if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return trimmed;
    return null;
}

function _sanitizeSaveDialogOptions(options) {
    if (!options || typeof options !== 'object') return {};
    /** @type {any} */
    const out = {};

    if (typeof options.title === 'string' && options.title.trim()) out.title = options.title;
    if (typeof options.buttonLabel === 'string' && options.buttonLabel.trim()) out.buttonLabel = options.buttonLabel;

    // `defaultPath` must be a string if provided. Passing undefined/null across IPC
    // can cause Electron to reject the options object on some platforms.
    if (typeof options.defaultPath === 'string' && options.defaultPath.trim()) out.defaultPath = options.defaultPath;

    if (typeof options.nameFieldLabel === 'string' && options.nameFieldLabel.trim()) out.nameFieldLabel = options.nameFieldLabel;
    if (typeof options.message === 'string' && options.message.trim()) out.message = options.message;
    if (typeof options.filters === 'object' && Array.isArray(options.filters)) out.filters = options.filters;

    // Common boolean flags
    if (typeof options.showsTagField === 'boolean') out.showsTagField = options.showsTagField;
    if (typeof options.showOverwriteConfirmation === 'boolean') out.showOverwriteConfirmation = options.showOverwriteConfirmation;

    return out;
}

function createDesktopBridge({ app, ipcMain, nativeTheme, clipboard, dialog, shell, powerMonitor }) {
    let mainWindow = null;

    function setMainWindow(win) {
        mainWindow = win;
    }

    function _send(channel, payload) {
        if (!mainWindow || !mainWindow.webContents) return;
        try { mainWindow.webContents.send(channel, payload); } catch (e) { }
    }

    function startEventForwarding() {
        try {
            if (nativeTheme && typeof nativeTheme.on === 'function') {
                nativeTheme.on('updated', () => {
                    _send('electron-native-theme-updated', {
                        shouldUseDarkColors: !!nativeTheme.shouldUseDarkColors,
                        themeSource: nativeTheme.themeSource,
                    });
                });
            }
        } catch (e) { }

        try {
            if (powerMonitor && typeof powerMonitor.on === 'function') {
                const forward = (type) => {
                    powerMonitor.on(type, () => _send('electron-power-event', { type }));
                };
                // Common powerMonitor events (varies by platform)
                ['suspend', 'resume', 'on-ac', 'on-battery', 'shutdown', 'lock-screen', 'unlock-screen'].forEach(forward);
            }
        } catch (e) { }
    }

    function registerIpcHandlers() {
        // Dialogs
        ipcMain.handle('dialog:open', async (event, options) => {
            try {
                const res = await dialog.showOpenDialog(mainWindow || null, options || {});
                return res;
            } catch (e) {
                return { canceled: true, filePaths: [], error: e && e.message };
            }
        });

        ipcMain.handle('dialog:save', async (event, options) => {
            try {
                const safeOptions = _sanitizeSaveDialogOptions(options);
                const res = mainWindow
                    ? await dialog.showSaveDialog(mainWindow, safeOptions)
                    : await dialog.showSaveDialog(safeOptions);
                return res;
            } catch (e) {
                return { canceled: true, filePath: undefined, error: e && e.message };
            }
        });

        // Clipboard
        ipcMain.handle('clipboard:readText', async () => {
            try { return clipboard.readText(); } catch (e) { return ''; }
        });

        ipcMain.handle('clipboard:writeText', async (event, text) => {
            try {
                clipboard.writeText(String(text ?? ''));
                return true;
            } catch (e) {
                return false;
            }
        });

        // Theme
        ipcMain.handle('nativeTheme:get', async () => {
            try {
                return {
                    shouldUseDarkColors: !!nativeTheme.shouldUseDarkColors,
                    themeSource: nativeTheme.themeSource,
                };
            } catch (e) {
                return { shouldUseDarkColors: false, themeSource: 'system' };
            }
        });

        ipcMain.handle('nativeTheme:setThemeSource', async (event, themeSource) => {
            try {
                const v = String(themeSource || 'system');
                if (!['system', 'light', 'dark'].includes(v)) return false;
                nativeTheme.themeSource = v;
                return true;
            } catch (e) {
                return false;
            }
        });

        // Shell helpers
        ipcMain.handle('shell:openExternal', async (event, url) => {
            try {
                const safe = _sanitizeOpenExternalUrl(url);
                if (!safe) return false;
                await shell.openExternal(safe);
                return true;
            } catch (e) {
                return false;
            }
        });

        ipcMain.handle('shell:showItemInFolder', async (event, filePath) => {
            try {
                if (!_isFilePathString(filePath)) return false;
                const resolved = path.resolve(String(filePath));
                if (!_fileExists(resolved)) return false;
                shell.showItemInFolder(resolved);
                return true;
            } catch (e) {
                return false;
            }
        });

        // App paths (useful for logs/data dirs)
        ipcMain.handle('app:getPath', async (event, name) => {
            try {
                const n = String(name || 'userData');
                // Allow a conservative subset; expand as needed.
                const allowed = ['userData', 'documents', 'downloads', 'desktop', 'music', 'pictures', 'videos', 'logs', 'temp'];
                if (!allowed.includes(n)) return null;
                return app.getPath(n);
            } catch (e) {
                return null;
            }
        });

        // Relaunch (useful for quick dev refresh flows)
        ipcMain.handle('app:relaunch', async () => {
            try {
                app.relaunch();
                app.exit(0);
                return true;
            } catch (e) {
                return false;
            }
        });
    }

    return {
        setMainWindow,
        registerIpcHandlers,
        startEventForwarding,
    };
}

module.exports = {
    createDesktopBridge,
};
