import { type CSSProperties } from 'react'
import { Quantum } from 'ldrs/react'
import { TextShimmer } from './loading-ui/TextShimmer'

type CrystallizingOrbProps = {
  title: string
  subtitle?: string
  className?: string
  particleCount?: number
}

export function CrystallizingOrb({
  title,
  subtitle,
  className,
  particleCount = 12
}: CrystallizingOrbProps): React.JSX.Element {
  return (
    <div
      className={className ? `crystallizing-orb ${className}` : 'crystallizing-orb'}
      aria-hidden="true"
    >
      <div className="crystallizer-god-rays" />
      <div className="crystallizer-prismatic-aura" />
      <div className="answer-loading-haze" />
      <div className="answer-loading-ring">
        {Array.from({ length: particleCount }).map((_, index) => (
          <span key={index} style={{ '--particle-index': index } as CSSProperties} />
        ))}
      </div>
      <div className="crystallizer-quantum-core">
        <Quantum size={30} speed={1.35} color="currentColor" />
      </div>
      <h2 className="crystallizer-loading-title">
        <TextShimmer className="crystallizer-shimmer-text" duration={2.8} spread={58}>
          {title}
        </TextShimmer>
      </h2>
      {subtitle && <p className="crystallizing-orb-subtitle">{subtitle}</p>}
    </div>
  )
}
