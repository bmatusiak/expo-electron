const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function truthyEnv(name) {
    return ['1', 'true', 'yes'].includes(String(process.env[name] || '').toLowerCase());
}

function readExpoProtocols(projectRoot) {
    try {
        const appJson = path.join(projectRoot, 'app.json');
        if (!fs.existsSync(appJson)) return [];
        const cfg = JSON.parse(fs.readFileSync(appJson, 'utf8'));
        const expo = (cfg || {}).expo || {};
        if (typeof expo.scheme === 'string' && expo.scheme.trim()) return [expo.scheme.trim()];
        if (Array.isArray(expo.schemes)) return expo.schemes;
        return [];
    } catch (e) {
        return [];
    }
}

function sanitizeDesktopToken(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

function commandExistsInPath(cmd) {
    const PATH = process.env.PATH || '';
    const parts = PATH.split(path.delimiter).filter(Boolean);
    for (const dir of parts) {
        const candidate = path.join(dir, cmd);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return true;
        } catch (e) { }
    }
    return false;
}

function getLinuxApplicationsDir() {
    const home = process.env.HOME;
    if (!home) return null;
    const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    return path.join(dataHome, 'applications');
}

function getLinuxMimeappsListPath() {
    const home = process.env.HOME;
    if (!home) return null;
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(configHome, 'mimeapps.list');
}

function removeMimeappsDefaultsForSchemes(schemes) {
    const mimeapps = getLinuxMimeappsListPath();
    if (!mimeapps) return;
    if (!fs.existsSync(mimeapps)) return;

    try {
        const content = fs.readFileSync(mimeapps, 'utf8');
        const schemeKeys = new Set((schemes || []).map((s) => `x-scheme-handler/${s}`));
        const outLines = [];
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) {
                outLines.push(line);
                continue;
            }
            const eq = trimmed.indexOf('=');
            if (eq === -1) {
                outLines.push(line);
                continue;
            }
            const key = trimmed.slice(0, eq).trim();
            if (schemeKeys.has(key)) {
                continue;
            }
            outLines.push(line);
        }
        fs.writeFileSync(mimeapps, outLines.join('\n'), 'utf8');
    } catch (e) {
        console.warn('Failed to edit mimeapps.list for cleanup:', e && e.message);
    }
}

function setupLinuxTempDesktopProtocolHandlers({ projectRoot, electronCmd, electronEntry, electronCwd, protocols }) {
    if (process.platform !== 'linux') return { cleanup: () => { }, enabled: false };
    if (truthyEnv('EXPO_ELECTRON_LINUX_NO_TEMP_DESKTOP')) return { cleanup: () => { }, enabled: false };

    const schemes = (protocols || [])
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .map((s) => s.toLowerCase());
    if (schemes.length === 0) return { cleanup: () => { }, enabled: false };

    const appsDir = getLinuxApplicationsDir();
    if (!appsDir) return { cleanup: () => { }, enabled: false };
    if (!fs.existsSync(appsDir)) {
        try {
            fs.mkdirSync(appsDir, { recursive: true });
        } catch (e) {
            return { cleanup: () => { }, enabled: false };
        }
    }

    let projectName = null;
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
        projectName = pkg.productName || pkg.name || null;
    } catch (e) { }
    projectName = projectName || path.basename(projectRoot);

    const token = sanitizeDesktopToken(projectName) || 'expo-electron';
    const desktopFileName = `expo-electron-dev-${token}-${process.pid}.desktop`;
    const desktopFilePath = path.join(appsDir, desktopFileName);

    const execLine = `\"${electronCmd}\" \"${electronEntry}\" --no-sandbox %u`;
    const mimeTypes = schemes.map((s) => `x-scheme-handler/${s};`).join('');

    const desktopContents = [
        '[Desktop Entry]',
        'Type=Application',
        `Name=${projectName} (Dev)`,
        'NoDisplay=true',
        'Terminal=false',
        `Exec=${execLine}`,
        `Path=${electronCwd}`,
        `MimeType=${mimeTypes}`,
    ].join('\n') + '\n';

    const hasXdgMime = commandExistsInPath('xdg-mime');
    const prevDefaults = {};

    function safeSpawnSync(cmd, args) {
        try {
            const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            return r;
        } catch (e) {
            return { status: 1, error: e };
        }
    }

    try {
        fs.writeFileSync(desktopFilePath, desktopContents, 'utf8');
        console.log('Linux dev deep links: wrote temp desktop file at', desktopFilePath);
    } catch (e) {
        console.warn('Linux dev deep links: failed to write desktop file:', e && e.message);
        return { cleanup: () => { }, enabled: false };
    }

    if (hasXdgMime) {
        for (const scheme of schemes) {
            const query = safeSpawnSync('xdg-mime', ['query', 'default', `x-scheme-handler/${scheme}`]);
            const prev = String((query && query.stdout) || '').trim();
            prevDefaults[scheme] = prev;
        }
        for (const scheme of schemes) {
            const set = safeSpawnSync('xdg-mime', ['default', desktopFileName, `x-scheme-handler/${scheme}`]);
            if (set && set.status !== 0) {
                console.warn('Linux dev deep links: xdg-mime default failed for', scheme);
            }
        }

        if (commandExistsInPath('update-desktop-database')) {
            safeSpawnSync('update-desktop-database', [appsDir]);
        }
    } else {
        console.warn('Linux dev deep links: xdg-mime not found; created .desktop but did not set defaults.');
    }

    let cleaned = false;
    function cleanup() {
        if (cleaned) return;
        cleaned = true;

        if (hasXdgMime) {
            for (const scheme of schemes) {
                const prev = String(prevDefaults[scheme] || '').trim();
                if (prev) {
                    safeSpawnSync('xdg-mime', ['default', prev, `x-scheme-handler/${scheme}`]);
                } else {
                    removeMimeappsDefaultsForSchemes([scheme]);
                }
            }
        }

        try {
            if (fs.existsSync(desktopFilePath)) fs.unlinkSync(desktopFilePath);
        } catch (e) {
            console.warn('Linux dev deep links: failed to remove temp desktop file:', e && e.message);
        }
    }

    return { cleanup, enabled: true, desktopFileName, desktopFilePath };
}

module.exports = {
    readExpoProtocols,
    setupLinuxTempDesktopProtocolHandlers,
};
