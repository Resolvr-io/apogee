/// <reference types="vite/client" />
/// <reference types="chrome" />

// Injected by vite.config.ts (define) — see src/version.ts.
declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
// Test-build-only gate used by the local lending regtest browser harness.
declare const __TX_MANIFEST_REGTEST__: boolean;
