import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { usePageTitle } from '@/hooks/use-page-title'
import { JobsScreen } from '@/screens/jobs/jobs-screen'

const searchSchema = z.object({
  agent: z.string().optional(),
})

export const Route = createFileRoute('/jobs')({
  validateSearch: searchSchema,
  component: function JobsRoute() {
    usePageTitle('Jobs')
    return <JobsScreen />
  },
})
