import { createFileRoute } from '@tanstack/react-router'
import BackendUnavailableState from '@/components/backend-unavailable-state'
import { usePageTitle } from '@/hooks/use-page-title'
import { getUnavailableReason } from '@/lib/feature-gates'
import { useIsFeatureAvailable } from '@/hooks/use-gateway-caps'
import { MemoryBrowserScreen } from '@/screens/memory/memory-browser-screen'

export const Route = createFileRoute('/memory')({
  ssr: false,
  component: function MemoryRoute() {
    usePageTitle('Memory')
    const available = useIsFeatureAvailable('memory')
    if (available === null) return null
    if (!available) {
      return (
        <BackendUnavailableState
          feature="Memory"
          description={getUnavailableReason('Memory')}
        />
      )
    }
    return <MemoryBrowserScreen />
  },
})
