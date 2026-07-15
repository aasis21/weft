/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Weft's version, injected at build time from the repo-root VERSION file (see vite.config.ts).
   *  Undefined only in test runs that bypass the define — call sites should fall back. */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
