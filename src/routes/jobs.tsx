import { createFileRoute } from '@tanstack/react-router'
import BackendUnavailableState from '@/components/backend-unavailable-state'
import { usePageTitle } from '@/hooks/use-page-title'
import { getUnavailableReason } from '@/lib/feature-gates'
import { useIsFeatureAvailable } from '@/hooks/use-gateway-caps'
import { JobsScreen } from '@/screens/jobs/jobs-screen'

export const Route = createFileRoute('/jobs')({
  component: function JobsRoute() {
    usePageTitle('Jobs')
    const available = useIsFeatureAvailable('jobs')
    // null = still loading — don't flash unavailable
    if (available === null) return null
    if (!available) {
      return (
        <BackendUnavailableState
          feature="Jobs"
          description={getUnavailableReason('Jobs')}
        />
      )
    }
    return <JobsScreen />
  },
})
