function getDefaultCsp({ isDev }) {
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

    return isDev ? DEFAULT_CSP_DEV : DEFAULT_CSP_PROD;
}

function installCspHeaders({ session }) {
    const disabled = ['1', 'true', 'yes'].includes(String(process.env.EXPO_ELECTRON_NO_CSP || '').toLowerCase());
    if (disabled) return;

    const isDev = process.env.NODE_ENV === 'development';
    const csp = process.env.EXPO_ELECTRON_CSP || getDefaultCsp({ isDev });
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

module.exports = {
    getDefaultCsp,
    installCspHeaders,
};
