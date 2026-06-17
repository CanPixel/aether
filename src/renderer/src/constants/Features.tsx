import { ReactNode } from "react"

interface Feature {
  kicker: string
  title: string
  body: string
  halo: string
  ink: string
  icon: ReactNode
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export const portals: Feature = {
  kicker: 'Portals',
  title: 'Saved doorways',
  body: 'Pin the places you return to. Portals sit on the dashboard like standing stones. Drag them into order, step through them into a tab.',
  halo: 'rgba(126, 215, 237, 0.24)',
  ink: '#247fa7',
  icon: (
    <svg width="100%" height="100%" viewBox="0 0 24 24" {...stroke}>
      <path d="M6 20V11a6 6 0 0 1 12 0v9" />
      <path d="M4 20h16" />
      <path d="M9.5 20v-8.5a2.5 2.5 0 0 1 5 0V20" />
    </svg>
  )
}

export const knowledgeHubs: Feature = {
  kicker: 'Knowledge hubs',
  title: 'Rooms for what you keep',
  body: 'Give each line of inquiry its own hub. Captures file themselves inside, and can be carried between rooms with a drag.',
  halo: 'rgba(143, 114, 207, 0.2)',
  ink: '#6d55a8',
  icon: (
    <svg width="26" height="26" viewBox="0 0 24 24" {...stroke}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  )
}

export const capture: Feature = {
  kicker: 'Capture',
  title: 'Press once, keep forever',
  body: 'One press lifts the readable text out of a page, embeds it locally, and lays it to rest in your hub: metadata, vectors and all.',
  halo: 'rgba(98, 216, 198, 0.22)',
  ink: '#1f7a64',
  icon: (
    <svg width="26" height="26" viewBox="0 0 24 24" {...stroke}>
      <path d="M12 4v10" />
      <path d="M8 10l4 4 4-4" />
      <path d="M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

export const aion: Feature = {
  kicker: 'AiON',
  title: 'Ask the library',
  body: 'Question a hub, the page you are on, or both. AiON answers from what you actually kept, and every claim carries its citation home.',
  halo: 'rgba(241, 198, 107, 0.26)',
  ink: '#8a6515',
  icon: (
    <svg width="26" height="26" viewBox="0 0 24 24" {...stroke}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M21 21l-4.8-4.8" />
      <path d="M11 8.2a2.8 2.8 0 1 1 0 5.6" />
    </svg>
  )
}

export const FEATURES: Record<string, Feature> = {
  portals,
  knowledgeHubs,
  capture,
  aion
}

export const FEATURES_ARRAY = Object.values(FEATURES)