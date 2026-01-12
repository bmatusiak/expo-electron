function getElectronBridge() {
    try {
        if (typeof window !== 'undefined' && window && window.electron) return window.electron;
        if (typeof globalThis !== 'undefined' && globalThis && globalThis.electron) return globalThis.electron;
    } catch (e) {
        // ignore
    }
    return null;
}

function isElectron() {
    const electron = getElectronBridge();
    return !!(electron && typeof electron.invoke === 'function');
}

function requireNativeModule(name) {
    const moduleName = String(name || '').trim();
    if (!moduleName) return null;

    try {
        const nativeRoot = (typeof globalThis !== 'undefined' && globalThis && globalThis.ElectronNative) ? globalThis.ElectronNative : null;
        if (!nativeRoot) return null;
        const mod = nativeRoot[moduleName];
        if (!mod || mod._missing) return null;
        return mod;
    } catch (e) {
        return null;
    }
}

function createDesktopApi(electron = getElectronBridge()) {
    function notAvailable(name) {
        const err = new Error(`${name} not available (not running under Electron)`);
        // Helps with some logging UIs
        err.code = 'EXPO_ELECTRON_NOT_AVAILABLE';
        throw err;
    }

    function optMethod(name) {
        const fn = electron && electron[name];
        if (typeof fn !== 'function') {
            return async () => notAvailable(name);
        }
        return (...args) => fn(...args);
    }

    function optSubscribe(name) {
        const fn = electron && electron[name];
        if (typeof fn !== 'function') {
            return () => () => { };
        }
        return (cb) => fn(cb);
    }

    return {
        // Dialogs
        openFileDialog: optMethod('openFileDialog'),
        saveFileDialog: optMethod('saveFileDialog'),

        // Clipboard
        readClipboardText: optMethod('readClipboardText'),
        writeClipboardText: optMethod('writeClipboardText'),

        // Theme
        getTheme: optMethod('getTheme'),
        setThemeSource: optMethod('setThemeSource'),
        onThemeChanged: optSubscribe('onThemeChanged'),

        // Power
        onPowerEvent: optSubscribe('onPowerEvent'),

        // Shell
        openExternal: optMethod('openExternal'),
        showItemInFolder: optMethod('showItemInFolder'),

        // App
        getPath: optMethod('getPath'),
        relaunch: optMethod('relaunch'),
        invoke: optMethod('invoke'),
    };
}

module.exports = {
    getElectronBridge,
    isElectron,
    requireNativeModule,
    createDesktopApi,
};
