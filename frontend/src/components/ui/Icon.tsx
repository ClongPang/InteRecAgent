import type { ReactNode } from 'react'

export type IconName =
  | 'back'
  | 'arrow'
  | 'bell'
  | 'check'
  | 'chevron'
  | 'close'
  | 'download'
  | 'edit'
  | 'external'
  | 'eye'
  | 'eye-off'
  | 'filter'
  | 'grid'
  | 'headphones'
  | 'heart'
  | 'info'
  | 'logout'
  | 'monitor'
  | 'plus'
  | 'search'
  | 'settings'
  | 'shoe'
  | 'spark'
  | 'star'
  | 'target'
  | 'trash'
  | 'user'

const paths: Record<IconName, ReactNode> = {
  back: <><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></>,
  arrow: <><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
  external: <><path d="M14 5h5v5" /><path d="M10 14 19 5" /><path d="M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" /></>,
  eye: <><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
  'eye-off': <><path d="m4 4 16 16" /><path d="M10.6 5.4A9.8 9.8 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17.8 17.8 0 0 1-2.8 3.4" /><path d="M6 6.5A17 17 0 0 0 2 12s3.5 6.5 10 6.5a9 9 0 0 0 4-.9" /><path d="M9.5 9.5a3 3 0 0 0 4 4.5" /></>,
  filter: <><path d="M4 6h16" /><path d="M7 12h10" /><path d="M10 18h4" /></>,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
  headphones: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="13" width="4" height="6" rx="1.5" /><rect x="17" y="13" width="4" height="6" rx="1.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
  shoe: <><path d="M3 16.5C3 15 4 14 5.5 13l5-2c2-.8 4-1.2 6-1.2h1.8L21 12c.7.4 1 1 1 1.6 0 1.4-1.2 2.4-3 2.4H5c-1.2 0-2-.7-2-1.5Z" /><path d="M14 10l1.5-3" /></>,
  spark: <path d="m12 3-1.5 5.5L5 10l5.5 1.5L12 17l1.5-5.5L19 10l-5.5-1.5L12 3Z" />,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />,
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9" /><path d="M10.3 21a2 2 0 0 0 3.4 0" /></>,
  download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  heart: <path d="M12 20s-7-4.4-9.2-9A5.3 5.3 0 0 1 12 6.7 5.3 5.3 0 0 1 21.2 11C19 15.6 12 20 12 20Z" />,
  logout: <><path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  settings: <><path d="M4 7h10" /><path d="M18 7h2" /><circle cx="16" cy="7" r="2" /><path d="M4 17h4" /><path d="M12 17h8" /><circle cx="10" cy="17" r="2" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v5" /><path d="M14 11v5" /></>,
  user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.6-3.4 3.5-5 7-5s6.4 1.6 7 5" /></>,
}

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[name]}
    </svg>
  )
}
