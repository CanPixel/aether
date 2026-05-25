import type React from 'react'
import { BookIcon, CloudIcon, CubeIcon, GlobeIcon, GridIcon, SparkIcon } from '../components/icons'
import { normalizeCollectionIcon } from './collection-icon-data'

export function CollectionIcon({ icon }: { icon?: string }): React.JSX.Element {
  switch (normalizeCollectionIcon(icon)) {
    case 'cube':
      return <CubeIcon />
    case 'grid':
      return <GridIcon />
    case 'spark':
      return <SparkIcon />
    case 'globe':
      return <GlobeIcon />
    case 'cloud':
      return <CloudIcon />
    case 'code':
      return <CodeIcon />
    case 'lab':
      return <LabIcon />
    case 'briefcase':
      return <BriefcaseIcon />
    case 'pin':
      return <PinIcon />
    case 'star':
      return <StarIcon />
    case 'archive':
      return <ArchiveIcon />
    case 'book':
    default:
      return <BookIcon />
  }
}

function CodeIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="m8.5 7-4.5 5 4.5 5M15.5 7l4.5 5-4.5 5M13.5 5.5l-3 13"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  )
}

function LabIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M9 3.8h6M10 4v5.2l-4.4 7.4A2.4 2.4 0 0 0 7.7 20h8.6a2.4 2.4 0 0 0 2.1-3.4L14 9.2V4M8.2 15h7.6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

function BriefcaseIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M8.2 8V6.2A2.2 2.2 0 0 1 10.4 4h3.2a2.2 2.2 0 0 1 2.2 2.2V8M4.5 9.2h15v9.3h-15V9.2ZM4.5 13.2h15M10 13.2v1.2h4v-1.2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

function PinIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M12 21s6.2-5.6 6.2-11a6.2 6.2 0 1 0-12.4 0C5.8 15.4 12 21 12 21Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <circle cx="12" cy="10" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

function StarIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="m12 3.8 2.5 5.1 5.6.8-4 4 1 5.5-5.1-2.7-5.1 2.7 1-5.5-4-4 5.6-.8L12 3.8Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

function ArchiveIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M5 7.5h14M6.2 7.5v11h11.6v-11M4.6 4.5h14.8v3H4.6v-3ZM9.5 11.2h5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}
