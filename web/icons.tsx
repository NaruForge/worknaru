export function Icon({ name }: { name: 'chat' | 'list' | 'close' | 'plus' | 'arrow' | 'stop' | 'settings' | 'folder' | 'sun' | 'moon' | 'grid' }) {
  const paths = {
    chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3H13a8 8 0 0 1 8 8.5Z',
    list: 'M9 3v18M3 3h18v18H3zM13 8h5M13 12h5', close: 'm6 6 12 12M6 18 18 6', plus: 'M12 5v14M5 12h14',
    arrow: 'M12 19V5m-6 6 6-6 6 6', stop: 'M6 6h12v12H6z', settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
    folder: 'M3 6h6l2 2h10v12H3z', sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    moon: 'M20 15a8 8 0 0 1-11-11 8.5 8.5 0 1 0 11 11Z', grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
