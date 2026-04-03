import { createFileRoute } from '@tanstack/react-router'
import BackendUnavailableState from '@/components/backend-unavailable-state'
import { usePageTitle } from '@/hooks/use-page-title'
import { getUnavailableReason } from '@/lib/feature-gates'
import { useIsFeatureAvailable } from '@/hooks/use-gateway-caps'
import { SkillsScreen } from '@/screens/skills/skills-screen'

export const Route = createFileRoute('/skills')({
  component: SkillsRoute,
})

function SkillsRoute() {
  usePageTitle('Skills')
  const available = useIsFeatureAvailable('skills')
  if (available === null) return null
  if (!available) {
    return (
      <BackendUnavailableState
        feature="Skills"
        description={getUnavailableReason('Skills')}
      />
    )
  }
  return <SkillsScreen />
}
