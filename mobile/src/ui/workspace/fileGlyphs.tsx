import type { JSX } from 'react';

export function FolderGlyph({ open = false }: { open?: boolean }): JSX.Element {
  return <svg className="workspace-folder-icon" viewBox="0 0 24 24" width="18" height="18"
    aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {open ? <>
      <path d="M3 10V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2" />
      <path d="M3 11h19l-3 9H5l-2-9Z" />
    </> : <path d="M3 7V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />}
  </svg>;
}

export function FileGlyph(): JSX.Element {
  return <svg className="workspace-file-icon" viewBox="0 0 24 24" width="18" height="18"
    aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
    <path d="M14 3v6h6M8 13h8M8 17h6" />
  </svg>;
}

export function ChangesGlyph(): JSX.Element {
  return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
    <path d="M14 3v6h6M8 13h8M12 11v4M8 18h8" />
  </svg>;
}

export function FolderChevron(): JSX.Element {
  return <svg className="workspace-tree-chevron" viewBox="0 0 16 16" width="14" height="18"
    aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 4 4 4-4 4" />
  </svg>;
}
