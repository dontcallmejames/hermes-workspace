/**
 * Config API proxy — forwards to Hermes WebAPI /api/config
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { HERMES_API } from '../../server/gateway-capabilities'

export const Route = createFileRoute('/api/config')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const res = await fetch(`${HERMES_API}/api/config`)
          if (!res.ok) {
            return json({ error: `Upstream error: ${res.status}` }, { status: res.status })
          }
          const data = await res.json()
          return json(data)
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
        }
      },
      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck
        try {
          const body = await request.text()
          const res = await fetch(`${HERMES_API}/api/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
          const data = await res.json()
          return json(data, { status: res.status })
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
        }
      },
    },
  },
})
