import type { CSSProperties, ReactNode } from 'react'

type TextShimmerProps = {
  children: ReactNode
  className?: string
  duration?: number
  spread?: number
}

export function TextShimmer({
  children,
  className,
  duration = 2.4,
  spread = 48
}: TextShimmerProps) {
  return (
    <span
      className={className ? `text-shimmer ${className}` : 'text-shimmer'}
      style={
        {
          '--text-shimmer-duration': `${duration}s`,
          '--text-shimmer-spread': `${spread}px`
        } as CSSProperties
      }
    >
      {children}
    </span>
  )
}
