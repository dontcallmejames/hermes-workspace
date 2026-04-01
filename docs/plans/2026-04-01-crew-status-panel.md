# Crew Status Panel Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a `/crew` full-page tab showing live dossier cards for all 5 Firefly crew agents (Kaylee, Wash, Book, River, Simon) with real-time status, stats, and quick-navigation actions.

**Architecture:** Backend reads per-profile filesystem data (gateway_state.json, state.db, cron/jobs.json, config.yaml) and the existing tasks API to return a unified crew status JSON. Frontend polls every 30s (pausing when tab is hidden) and renders styled dossier cards with copper Firefly theming. After implementation, run through frontend-design skill before committing.

**Spec:** `docs/specs/2026-04-01--crew-status-panel.md`

**Tech Stack:** TanStack Start (server routes), React Query, better-sqlite3 (server-side), yaml (already in package.json), HugeIcons (`UserMultipleIcon`), Tailwind CSS, TypeScript

---

## File Map

```
New files:
  src/routes/api/crew-status.ts          — backend API route
  src/hooks/use-crew-status.ts           — React Query polling hook
  src/screens/crew/crew-screen.tsx       — full page UI component
  src/routes/crew.tsx                    — route definition

Modified files:
  src/components/workspace-shell.tsx     — add /crew to getTabIndex + getPageTitle
  src/components/mobile-tab-bar.tsx      — add Crew tab to TABS array
  src/screens/chat/components/chat-sidebar.tsx  — add Crew nav item
  src/screens/tasks/tasks-screen.tsx     — read ?assignee= URL param on mount
  src/screens/jobs/jobs-screen.tsx       — read ?agent= URL param on mount
```

---

## Task 1: Install better-sqlite3 (server-side SQLite)

**Objective:** Add better-sqlite3 so the API route can read per-profile state.db files.

**Files:**
- Run: `npm install better-sqlite3 @types/better-sqlite3`

**Step 1: Install**

```bash
cd ~/hermes-workspace
npm install better-sqlite3 @types/better-sqlite3
```

Expected output: `added 2 packages` (or similar)

**Step 2: Verify types work**

```bash
cd ~/hermes-workspace
npx tsc --noEmit 2>&1 | head -5
```

Expected: no new errors related to better-sqlite3

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add better-sqlite3 for crew status API"
```

---

## Task 2: Create `/api/crew-status` backend route

**Objective:** Server route that reads all 5 crew profiles from the filesystem and returns unified JSON.

**Files:**
- Create: `src/routes/api/crew-status.ts`

**Step 1: Create the route**

```typescript
// src/routes/api/crew-status.ts
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import yaml from 'yaml'
import { HERMES_API, ensureGatewayProbed, getCapabilities } from '../../server/gateway-capabilities'

// ── Crew config ─────────────────────────────────────────────────────

const CREW = [
  { id: 'kaylee', role: "Ship's Engineer",  profilePath: null },
  { id: 'wash',   role: 'Pilot',            profilePath: 'wash' },
  { id: 'book',   role: 'Shepherd',         profilePath: 'book' },
  { id: 'river',  role: 'Reader',           profilePath: 'river' },
  { id: 'simon',  role: "Ship's Doctor",    profilePath: 'simon' },
] as const

function getHermesHome(profilePath: string | null): string {
  const base = join(homedir(), '.hermes')
  return profilePath ? join(base, 'profiles', profilePath) : base
}

// ── Data readers ────────────────────────────────────────────────────

function readGatewayState(hermesHome: string): {
  pid: number | null
  gatewayState: string
  platforms: Record<string, { state: string; updatedAt: string }>
  updatedAt: string | null
} {
  const path = join(hermesHome, 'gateway_state.json')
  if (!existsSync(path)) {
    return { pid: null, gatewayState: 'unknown', platforms: {}, updatedAt: null }
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return {
      pid: raw.pid ?? null,
      gatewayState: raw.gateway_state ?? 'unknown',
      platforms: raw.platforms ?? {},
      updatedAt: raw.updated_at ?? null,
    }
  } catch {
    return { pid: null, gatewayState: 'unknown', platforms: {}, updatedAt: null }
  }
}

function checkProcessAlive(pid: number | null): boolean {
  if (!pid) return false
  try {
    // signal 0 = existence check, does not send a real signal
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readDbStats(hermesHome: string): {
  sessionCount: number
  messageCount: number
  toolCallCount: number
  totalTokens: number
  estimatedCostUsd: number | null
  lastSessionTitle: string | null
  lastSessionAt: number | null
} {
  const dbPath = join(hermesHome, 'state.db')
  if (!existsSync(dbPath)) {
    return {
      sessionCount: 0, messageCount: 0, toolCallCount: 0,
      totalTokens: 0, estimatedCostUsd: null,
      lastSessionTitle: null, lastSessionAt: null,
    }
  }
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })

    const agg = db.prepare(`
      SELECT
        COUNT(*) as session_count,
        COALESCE(SUM(message_count), 0) as total_messages,
        COALESCE(SUM(tool_call_count), 0) as total_tool_calls,
        COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
        SUM(estimated_cost_usd) as estimated_cost,
        MAX(started_at) as last_session_at
      FROM sessions
    `).get() as {
      session_count: number
      total_messages: number
      total_tool_calls: number
      total_tokens: number
      estimated_cost: number | null
      last_session_at: number | null
    }

    const lastSession = db.prepare(`
      SELECT title, started_at FROM sessions ORDER BY started_at DESC LIMIT 1
    `).get() as { title: string | null; started_at: number } | undefined

    db.close()

    return {
      sessionCount: agg.session_count ?? 0,
      messageCount: agg.total_messages ?? 0,
      toolCallCount: agg.total_tool_calls ?? 0,
      totalTokens: agg.total_tokens ?? 0,
      estimatedCostUsd: agg.estimated_cost ?? null,
      lastSessionTitle: lastSession?.title ?? null,
      lastSessionAt: lastSession?.started_at ?? null,
    }
  } catch {
    return {
      sessionCount: 0, messageCount: 0, toolCallCount: 0,
      totalTokens: 0, estimatedCostUsd: null,
      lastSessionTitle: null, lastSessionAt: null,
    }
  }
}

function readConfig(hermesHome: string): { model: string; provider: string } {
  const configPath = join(hermesHome, 'config.yaml')
  if (!existsSync(configPath)) return { model: 'unknown', provider: 'unknown' }
  try {
    const raw = yaml.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    const modelVal = raw.model
    if (typeof modelVal === 'object' && modelVal !== null) {
      const m = modelVal as Record<string, string>
      return {
        model: m.default ?? 'unknown',
        provider: m.provider ?? 'unknown',
      }
    }
    return { model: String(modelVal ?? 'unknown'), provider: 'unknown' }
  } catch {
    return { model: 'unknown', provider: 'unknown' }
  }
}

function readCronJobCount(hermesHome: string): number {
  const cronPath = join(hermesHome, 'cron', 'jobs.json')
  if (!existsSync(cronPath)) return 0
  try {
    const jobs = JSON.parse(readFileSync(cronPath, 'utf-8'))
    return Array.isArray(jobs) ? jobs.length : 0
  } catch {
    return 0
  }
}

async function fetchAssignedTaskCount(agentId: string): Promise<number> {
  try {
    const res = await fetch(`${HERMES_API}/api/tasks?include_done=false`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) return 0
    const data = await res.json() as { tasks?: Array<{ assignee?: string; column?: string }> }
    const tasks = data.tasks ?? []
    return tasks.filter(t => t.assignee === agentId && t.column !== 'done').length
  } catch {
    return 0
  }
}

// ── Route ───────────────────────────────────────────────────────────

export const Route = createFileRoute('/api/crew-status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        await ensureGatewayProbed()

        const crew = await Promise.all(
          CREW.map(async (member) => {
            const hermesHome = getHermesHome(member.profilePath)
            const profileExists = existsSync(hermesHome)

            if (!profileExists) {
              return {
                id: member.id,
                role: member.role,
                profileFound: false,
                gatewayState: 'unknown',
                processAlive: false,
                platforms: {},
                model: 'unknown',
                provider: 'unknown',
                lastSessionTitle: null,
                lastSessionAt: null,
                sessionCount: 0,
                messageCount: 0,
                toolCallCount: 0,
                totalTokens: 0,
                estimatedCostUsd: null,
                cronJobCount: 0,
                assignedTaskCount: 0,
              }
            }

            const gatewayInfo = readGatewayState(hermesHome)
            const processAlive = checkProcessAlive(gatewayInfo.pid)
            const dbStats = readDbStats(hermesHome)
            const config = readConfig(hermesHome)
            const cronJobCount = readCronJobCount(hermesHome)
            const assignedTaskCount = await fetchAssignedTaskCount(member.id)

            return {
              id: member.id,
              role: member.role,
              profileFound: true,
              gatewayState: gatewayInfo.gatewayState,
              processAlive,
              platforms: gatewayInfo.platforms,
              model: config.model,
              provider: config.provider,
              lastSessionTitle: dbStats.lastSessionTitle,
              lastSessionAt: dbStats.lastSessionAt,
              sessionCount: dbStats.sessionCount,
              messageCount: dbStats.messageCount,
              toolCallCount: dbStats.toolCallCount,
              totalTokens: dbStats.totalTokens,
              estimatedCostUsd: dbStats.estimatedCostUsd,
              cronJobCount,
              assignedTaskCount,
            }
          })
        )

        return json({ crew, fetchedAt: Date.now() })
      },
    },
  },
})
```

**Step 2: Verify TypeScript compiles**

```bash
cd ~/hermes-workspace
npx tsc --noEmit 2>&1 | grep crew-status
```

Expected: no output (no errors)

**Step 3: Start dev server and test**

```bash
# In a separate terminal (already running), or:
curl -s http://localhost:3000/api/crew-status | python3 -m json.tool | head -40
```

Expected: JSON with `crew` array of 5 members, `fetchedAt` timestamp.
If getting 401, add a cookie or test via the browser while logged in.

**Step 4: Commit**

```bash
git add src/routes/api/crew-status.ts
git commit -m "feat: add /api/crew-status backend route"
```

---

## Task 3: Create `use-crew-status.ts` polling hook

**Objective:** React Query hook that polls crew status every 30s, pauses when tab is hidden, exposes last-updated timestamp.

**Files:**
- Create: `src/hooks/use-crew-status.ts`

**Step 1: Create the hook**

```typescript
// src/hooks/use-crew-status.ts
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

export type CrewPlatformInfo = {
  state: 'connected' | 'disconnected' | string
  updatedAt: string
}

export type CrewMember = {
  id: string
  role: string
  profileFound: boolean
  gatewayState: 'running' | 'stopped' | 'unknown' | string
  processAlive: boolean
  platforms: Record<string, CrewPlatformInfo>
  model: string
  provider: string
  lastSessionTitle: string | null
  lastSessionAt: number | null  // unix seconds
  sessionCount: number
  messageCount: number
  toolCallCount: number
  totalTokens: number
  estimatedCostUsd: number | null
  cronJobCount: number
  assignedTaskCount: number
}

export type CrewStatus = {
  crew: CrewMember[]
  fetchedAt: number  // unix ms
}

// Derived: compute online/offline/unknown from raw API data
export type CrewOnlineStatus = 'online' | 'offline' | 'unknown'

export function getOnlineStatus(member: CrewMember): CrewOnlineStatus {
  if (!member.profileFound) return 'unknown'
  if (member.gatewayState === 'unknown') return 'unknown'
  if (member.gatewayState === 'running' && member.processAlive) return 'online'
  return 'offline'
}

const QUERY_KEY = ['crew', 'status'] as const
const POLL_INTERVAL_MS = 30_000

async function fetchCrewStatus(): Promise<CrewStatus> {
  const res = await fetch('/api/crew-status')
  if (!res.ok) {
    throw new Error(`Failed to fetch crew status: ${res.status}`)
  }
  return res.json() as Promise<CrewStatus>
}

export function useCrewStatus() {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchCrewStatus,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,  // pauses polling when tab is hidden
    staleTime: 20_000,
  })

  // Immediately refetch when user returns to the tab
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [queryClient])

  // Compute "X seconds ago" label from fetchedAt
  const lastUpdated = query.data?.fetchedAt ?? null

  return {
    crew: query.data?.crew ?? [],
    lastUpdated,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  }
}
```

**Step 2: Verify TypeScript**

```bash
cd ~/hermes-workspace
npx tsc --noEmit 2>&1 | grep use-crew-status
```

Expected: no output

**Step 3: Commit**

```bash
git add src/hooks/use-crew-status.ts
git commit -m "feat: add useCrewStatus polling hook"
```

---

## Task 4: Create `crew-screen.tsx` UI component

**Objective:** Full-page crew manifest screen with dossier cards, copper/Firefly theming, auto-refreshing header, and skeleton loading.

**Files:**
- Create: `src/screens/crew/crew-screen.tsx`

**Step 1: Create the screen**

```tsx
// src/screens/crew/crew-screen.tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  CheckListIcon,
  Clock01Icon,
  RefreshIcon,
  Wifi01Icon,
  WifiOffIcon,
} from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'
import {
  useCrewStatus,
  getOnlineStatus,
  type CrewMember,
  type CrewOnlineStatus,
} from '@/hooks/use-crew-status'

// ── Helpers ─────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function formatCost(n: number | null): string {
  if (n === null) return '—'
  return `$${n.toFixed(2)}`
}

function formatRelativeTime(unixSeconds: number | null): string {
  if (!unixSeconds) return 'Never'
  const diffMs = Date.now() - unixSeconds * 1000
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

function formatUpdatedAgo(fetchedAt: number | null): string {
  if (!fetchedAt) return ''
  const diffSec = Math.floor((Date.now() - fetchedAt) / 1000)
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  return `${Math.floor(diffSec / 60)}m ago`
}

// ── Status dot ──────────────────────────────────────────────────────

function StatusDot({ status }: { status: CrewOnlineStatus }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          'inline-block size-2 rounded-full',
          status === 'online'  && 'bg-green-500',
          status === 'offline' && 'bg-red-500',
          status === 'unknown' && 'bg-gray-500',
        )}
      />
      <span
        className={cn(
          'text-[10px] font-semibold uppercase tracking-widest',
          status === 'online'  && 'text-green-400',
          status === 'offline' && 'text-red-400',
          status === 'unknown' && 'text-gray-500',
        )}
      >
        {status}
      </span>
    </div>
  )
}

// ── Skeleton card ───────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] overflow-hidden animate-pulse">
      <div className="border-l-[3px] border-l-[#B87333] p-4 h-full">
        <div className="flex justify-between mb-3">
          <div className="h-2.5 bg-[var(--theme-hover)] rounded w-16" />
          <div className="h-2.5 bg-[var(--theme-hover)] rounded w-24" />
        </div>
        <div className="h-6 bg-[var(--theme-hover)] rounded w-28 mb-1" />
        <div className="h-3 bg-[var(--theme-hover)] rounded w-36 mb-4" />
        <div className="grid grid-cols-3 gap-2 mb-3">
          {[0,1,2].map(i => (
            <div key={i} className="rounded bg-[var(--theme-hover)] h-12" />
          ))}
        </div>
        <div className="flex justify-between">
          <div className="h-3 bg-[var(--theme-hover)] rounded w-20" />
          <div className="h-3 bg-[var(--theme-hover)] rounded w-20" />
        </div>
      </div>
    </div>
  )
}

// ── Agent card ──────────────────────────────────────────────────────

function AgentCard({ member }: { member: CrewMember }) {
  const navigate = useNavigate()
  const status = getOnlineStatus(member)
  const telegramPlatform = member.platforms.telegram

  const borderColor =
    status === 'online'  ? '#B87333' :
    status === 'offline' ? '#ef4444' :
    '#6b7280'

  const handleViewTasks = () => {
    void navigate({ to: '/tasks', search: { assignee: member.id } })
  }

  const handleViewJobs = () => {
    void navigate({ to: '/jobs', search: { agent: member.id } })
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] overflow-hidden',
        'transition-all duration-200',
        status === 'offline' && 'opacity-70',
      )}
    >
      <div
        className="border-l-[3px] p-4 h-full flex flex-col gap-3"
        style={{ borderLeftColor: borderColor }}
      >
        {/* Top row: status dot + role */}
        <div className="flex items-start justify-between gap-2">
          <StatusDot status={status} />
          <span className="text-[10px] text-[var(--theme-muted)] uppercase tracking-wider text-right">
            {member.role}
          </span>
        </div>

        {/* Agent name + model */}
        <div>
          <h3 className="text-lg font-semibold capitalize" style={{ color: '#f59e0b' }}>
            {member.id}
          </h3>
          <p className="text-xs text-[var(--theme-muted)] mt-0.5">
            {member.model} · {member.provider}
          </p>
          {telegramPlatform && (
            <div className="flex items-center gap-1 mt-1">
              <HugeiconsIcon
                icon={telegramPlatform.state === 'connected' ? Wifi01Icon : WifiOffIcon}
                size={10}
                className={cn(
                  telegramPlatform.state === 'connected' ? 'text-green-400' : 'text-gray-500',
                )}
              />
              <span className="text-[10px] text-[var(--theme-muted)]">
                Telegram: {telegramPlatform.state}
              </span>
            </div>
          )}
        </div>

        {/* Last active */}
        <div>
          <p className="text-[11px] text-[var(--theme-muted)]">
            Last active: <span className="text-[var(--theme-text)]">{formatRelativeTime(member.lastSessionAt)}</span>
          </p>
          {member.lastSessionTitle && (
            <p className="text-[11px] text-[var(--theme-muted)] italic truncate mt-0.5">
              "{member.lastSessionTitle}"
            </p>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Sessions', value: formatNumber(member.sessionCount) },
            { label: 'Messages', value: formatNumber(member.messageCount) },
            { label: 'Tools',    value: formatNumber(member.toolCallCount) },
          ].map(({ label, value }) => (
            <div
              key={label}
              className="rounded bg-[var(--theme-hover)] px-2 py-1.5 text-center"
            >
              <div className="text-sm font-semibold text-[var(--theme-text)]">{value}</div>
              <div className="text-[9px] text-[var(--theme-muted)] uppercase tracking-wide">{label}</div>
            </div>
          ))}
        </div>

        {/* Tokens + cost */}
        <div className="flex justify-between text-[11px]">
          <span className="text-[var(--theme-muted)]">
            Tokens: <span className="text-[var(--theme-text)]">{formatTokens(member.totalTokens)}</span>
          </span>
          <span className="text-[var(--theme-muted)]">
            Est. cost: <span className="text-[var(--theme-text)]">{formatCost(member.estimatedCostUsd)}</span>
          </span>
        </div>

        {/* Cron + tasks */}
        <div className="flex justify-between text-[11px]">
          <span className="text-[var(--theme-muted)]">
            Crons: <span className="text-[var(--theme-text)]">{member.cronJobCount}</span>
          </span>
          <span className="text-[var(--theme-muted)]">
            Tasks: <span className="text-[var(--theme-text)]">{member.assignedTaskCount} assigned</span>
          </span>
        </div>

        {/* Divider */}
        <div className="border-t border-[var(--theme-border)]" />

        {/* Footer actions */}
        <div className="flex justify-between">
          <button
            type="button"
            onClick={handleViewTasks}
            className="flex items-center gap-1 text-[11px] text-[var(--theme-muted)] hover:text-[#B87333] transition-colors"
          >
            <HugeiconsIcon icon={CheckListIcon} size={12} />
            Tasks
          </button>
          <button
            type="button"
            onClick={handleViewJobs}
            className="flex items-center gap-1 text-[11px] text-[var(--theme-muted)] hover:text-[#B87333] transition-colors"
          >
            <HugeiconsIcon icon={Clock01Icon} size={12} />
            Cron Jobs
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Ticker for "Updated X ago" ───────────────────────────────────────

function useUpdatedAgo(fetchedAt: number | null): string {
  const [label, setLabel] = useState(formatUpdatedAgo(fetchedAt))

  useEffect(() => {
    setLabel(formatUpdatedAgo(fetchedAt))
    const interval = setInterval(() => {
      setLabel(formatUpdatedAgo(fetchedAt))
    }, 5_000)
    return () => clearInterval(interval)
  }, [fetchedAt])

  return label
}

// ── Main screen ─────────────────────────────────────────────────────

export function CrewScreen() {
  const { crew, lastUpdated, isLoading, isError, refetch } = useCrewStatus()
  const updatedAgo = useUpdatedAgo(lastUpdated)

  const onlineCount = crew.filter(m => getOnlineStatus(m) === 'online').length

  const handleRefresh = useCallback(() => {
    void refetch()
  }, [refetch])

  return (
    <div className="flex flex-col h-full overflow-auto p-4 md:p-6 gap-6">
      {/* ── Header ── */}
      <div>
        {/* Copper divider line above title */}
        <div className="h-px mb-3" style={{ background: 'linear-gradient(to right, #B87333, transparent)' }} />

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1
              className="text-xl font-bold tracking-widest uppercase"
              style={{ color: '#f59e0b' }}
            >
              Serenity Crew Manifest
            </h1>
            <p className="text-xs text-[var(--theme-muted)] mt-1">
              {crew.length} crew · {onlineCount} online
              {updatedAgo && ` · Updated ${updatedAgo}`}
            </p>
          </div>

          <button
            type="button"
            onClick={handleRefresh}
            disabled={isLoading}
            className={cn(
              'flex items-center gap-1.5 text-xs text-[var(--theme-muted)]',
              'hover:text-[#B87333] transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <HugeiconsIcon
              icon={RefreshIcon}
              size={13}
              className={isLoading ? 'animate-spin' : ''}
            />
            Refresh
          </button>
        </div>

        {/* Copper divider below header */}
        <div className="h-px mt-3" style={{ background: 'linear-gradient(to right, #B87333, transparent)' }} />
      </div>

      {/* ── Error state ── */}
      {isError && !isLoading && (
        <div className="rounded-lg border border-red-800/40 bg-red-900/10 p-4 text-sm text-red-400">
          Failed to load crew status.{' '}
          <button
            type="button"
            onClick={handleRefresh}
            className="underline hover:text-red-300"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Card grid ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading
          ? Array.from({ length: 5 }, (_, i) => <SkeletonCard key={i} />)
          : crew.map(member => <AgentCard key={member.id} member={member} />)
        }
      </div>
    </div>
  )
}
```

**Step 2: Verify TypeScript**

```bash
cd ~/hermes-workspace
npx tsc --noEmit 2>&1 | grep crew-screen
```

Expected: no output

**Step 3: Commit**

```bash
git add src/screens/crew/crew-screen.tsx
git commit -m "feat: add CrewScreen dossier UI component"
```

---

## Task 5: Create `/crew` route

**Objective:** Wire the crew screen to a TanStack Router route.

**Files:**
- Create: `src/routes/crew.tsx`

**Step 1: Create route file**

```typescript
// src/routes/crew.tsx
import { createFileRoute } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'
import { CrewScreen } from '@/screens/crew/crew-screen'

export const Route = createFileRoute('/crew')({
  component: CrewRoute,
})

function CrewRoute() {
  usePageTitle('Crew')
  return <CrewScreen />
}
```

**Step 2: Regenerate route tree**

TanStack Router auto-generates `src/routeTree.gen.ts` — the dev server does this automatically. If running dev server, save the file and the route tree regenerates. If not, run:

```bash
cd ~/hermes-workspace
npx tsr generate
```

**Step 3: Verify the route is in the tree**

```bash
grep "crew" src/routeTree.gen.ts
```

Expected: lines referencing `/crew`

**Step 4: Commit**

```bash
git add src/routes/crew.tsx src/routeTree.gen.ts
git commit -m "feat: add /crew route"
```

---

## Task 6: Add Crew to desktop sidebar nav

**Objective:** Add "Crew" as a nav item in the desktop chat sidebar between Tasks and Memory (or after Tasks).

**Files:**
- Modify: `src/screens/chat/components/chat-sidebar.tsx`

**Step 1: Find the nav items section**

Look for the block that defines `mainItems` or the nav items array containing Jobs and Tasks. The pattern is:

```typescript
// Find this section that has Jobs:
{
  kind: 'link',
  to: '/jobs',
  icon: Clock01Icon,
  label: 'Jobs',
  active: isJobsActive,
},
```

**Step 2: Add the Crew import**

In the imports at the top of chat-sidebar.tsx, add `UserMultipleIcon` to the hugeicons import:

```typescript
import {
  // ... existing imports ...
  UserMultipleIcon,
} from '@hugeicons/core-free-icons'
```

**Step 3: Add active state variable**

Find where `isJobsActive` etc. are defined and add:

```typescript
const isCrewActive = pathname === '/crew'
```

**Step 4: Add the nav item**

Add after the Tasks nav item (or after Jobs, whichever makes more sense visually):

```typescript
{
  kind: 'link',
  to: '/crew',
  icon: UserMultipleIcon,
  label: 'Crew',
  active: isCrewActive,
},
```

**Step 5: Verify it renders**

Visit http://localhost:3000 in browser — "Crew" should appear in the sidebar nav.

**Step 6: Commit**

```bash
git add src/screens/chat/components/chat-sidebar.tsx
git commit -m "feat: add Crew nav item to desktop sidebar"
```

---

## Task 7: Add Crew to mobile tab bar

**Objective:** Add a Crew tab to the mobile pill nav.

**Files:**
- Modify: `src/components/mobile-tab-bar.tsx`

**Step 1: Add UserMultipleIcon import**

```typescript
import {
  // ... existing imports ...
  UserMultipleIcon,
} from '@hugeicons/core-free-icons'
```

**Step 2: Add to TABS array**

Add after the Tasks tab (or after Jobs):

```typescript
{
  id: 'crew',
  label: 'Crew',
  icon: UserMultipleIcon,
  to: '/crew',
  match: (p) => p.startsWith('/crew'),
},
```

**Step 3: Verify mobile nav**

On mobile (or DevTools mobile emulation), the Crew tab should appear in the pill nav.

**Step 4: Commit**

```bash
git add src/components/mobile-tab-bar.tsx
git commit -m "feat: add Crew tab to mobile tab bar"
```

---

## Task 8: Update workspace-shell.tsx for /crew route

**Objective:** Add `/crew` to the tab index and page title mappings in workspace-shell.tsx.

**Files:**
- Modify: `src/components/workspace-shell.tsx`

**Step 1: Find getTabIndex function**

Look for the block that maps paths to tab indices:

```typescript
if (path.startsWith('/jobs')) return 4
if (path.startsWith('/tasks')) return 5
```

**Step 2: Add /crew**

Insert after tasks (adjust the number to fit):

```typescript
if (path.startsWith('/crew')) return 6   // shift memory/skills/settings up by 1
if (path.startsWith('/memory')) return 7
if (path.startsWith('/skills')) return 8
if (path.startsWith('/settings')) return 9
```

**Step 3: Find getPageTitle function**

Look for the block mapping paths to page titles:

```typescript
if (pathname.startsWith('/tasks')) return 'Tasks'
if (pathname.startsWith('/memory')) return 'Memory'
```

**Step 4: Add Crew**

```typescript
if (pathname.startsWith('/crew')) return 'Crew'
```

**Step 5: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep workspace-shell
```

Expected: no output

**Step 6: Commit**

```bash
git add src/components/workspace-shell.tsx
git commit -m "feat: add /crew to workspace-shell tab index and page title"
```

---

## Task 9: Add ?assignee= filter to tasks-screen.tsx

**Objective:** When navigating to /tasks?assignee=kaylee from a crew card, the board pre-filters to show only that agent's tasks.

**Files:**
- Modify: `src/screens/tasks/tasks-screen.tsx`

**Step 1: Add useSearch import**

At the top of the file, add:

```typescript
import { useSearch } from '@tanstack/react-router'
```

**Step 2: Read the search param inside TasksScreen**

Inside the `TasksScreen` component function, add:

```typescript
// Read ?assignee= param — set by crew card "View Tasks" action
const search = useSearch({ from: '/tasks' })
const initialAssignee = typeof search.assignee === 'string' ? search.assignee : null
```

**Step 3: Add assignee filter state**

Add a state variable for assignee filter (after the existing state variables):

```typescript
const [assigneeFilter, setAssigneeFilter] = useState<string | null>(initialAssignee)
```

**Step 4: Apply filter in tasksByColumn memo**

In the `useMemo` that builds `tasksByColumn`, add a filter after the column population:

```typescript
const tasksByColumn = useMemo(() => {
  const map: Record<TaskColumn, Array<HermesTask>> = {
    backlog: [], todo: [], in_progress: [], review: [], done: [],
  }
  for (const t of tasks) {
    // Apply assignee filter if set
    if (assigneeFilter && t.assignee !== assigneeFilter) continue
    if (map[t.column]) map[t.column].push(t)
  }
  for (const col of COLUMN_ORDER) {
    map[col].sort((a, b) => a.position - b.position)
  }
  return map
}, [tasks, assigneeFilter])
```

**Step 5: Add a filter indicator in the UI**

Find the stats bar or header area and add a small indicator when filtered:

```tsx
{assigneeFilter && (
  <div className="flex items-center gap-2 text-xs text-[var(--theme-muted)]">
    <span>Filtered: <span className="text-[#f59e0b] capitalize">{assigneeFilter}</span></span>
    <button
      type="button"
      onClick={() => setAssigneeFilter(null)}
      className="text-[var(--theme-muted)] hover:text-[var(--theme-text)]"
    >
      ✕ Clear
    </button>
  </div>
)}
```

**Step 6: Update Route definition to accept search params**

In `src/routes/tasks.tsx`, update to validate search params:

```typescript
// src/routes/tasks.tsx
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { usePageTitle } from '@/hooks/use-page-title'
import { TasksScreen } from '@/screens/tasks/tasks-screen'

const searchSchema = z.object({
  assignee: z.string().optional(),
})

export const Route = createFileRoute('/tasks')({
  validateSearch: searchSchema,
  component: TasksRoute,
})

function TasksRoute() {
  usePageTitle('Tasks')
  return <TasksScreen />
}
```

**Step 7: Verify**

Navigate to http://localhost:3000/tasks?assignee=kaylee — board should only show Kaylee's tasks. "Clear" button removes the filter.

**Step 8: Commit**

```bash
git add src/screens/tasks/tasks-screen.tsx src/routes/tasks.tsx
git commit -m "feat: add ?assignee filter to tasks screen"
```

---

## Task 10: Add ?agent= filter to jobs-screen.tsx

**Objective:** When navigating to /jobs?agent=kaylee from a crew card, the jobs list pre-filters to that agent's crons.

**Files:**
- Modify: `src/screens/jobs/jobs-screen.tsx`
- Modify: `src/routes/jobs.tsx`

**Step 1: Add useSearch import to jobs-screen.tsx**

```typescript
import { useSearch } from '@tanstack/react-router'
```

**Step 2: Read ?agent= param and add filter state**

Inside `JobsScreen` component:

```typescript
const search = useSearch({ from: '/jobs' })
const initialAgent = typeof search.agent === 'string' ? search.agent : null
const [agentFilter, setAgentFilter] = useState<string | null>(initialAgent)
```

**Step 3: Apply filter to jobs list**

Find where `jobs` data is rendered/filtered and add:

```typescript
const filteredJobs = useMemo(() => {
  if (!agentFilter) return jobs
  return jobs.filter(job => {
    // Jobs don't have an explicit agent field, but job IDs or names
    // may contain the agent name. Match on job name containing the agent id.
    const name = (job.name ?? '').toLowerCase()
    const prompt = (job.prompt ?? '').toLowerCase()
    return name.includes(agentFilter) || prompt.includes(agentFilter)
  })
}, [jobs, agentFilter])
```

Note: Use `filteredJobs` instead of `jobs` when rendering the jobs list.

**Step 4: Add filter indicator**

In the jobs screen header/toolbar area:

```tsx
{agentFilter && (
  <div className="flex items-center gap-2 text-xs text-[var(--theme-muted)]">
    <span>Agent: <span className="text-[#f59e0b] capitalize">{agentFilter}</span></span>
    <button
      type="button"
      onClick={() => setAgentFilter(null)}
      className="text-[var(--theme-muted)] hover:text-[var(--theme-text)]"
    >
      ✕ Clear
    </button>
  </div>
)}
```

**Step 5: Update jobs route to accept search params**

```typescript
// src/routes/jobs.tsx
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
```

**Step 6: Verify**

Navigate to http://localhost:3000/jobs?agent=kaylee — only jobs mentioning kaylee show. Clear button removes filter.

**Step 7: Commit**

```bash
git add src/screens/jobs/jobs-screen.tsx src/routes/jobs.tsx
git commit -m "feat: add ?agent filter to jobs screen"
```

---

## Task 11: Frontend-design skill pass

**Objective:** Run the crew screen through the frontend-design skill to audit design consistency, polish, and Firefly theming before finalizing.

**Step 1: Load the frontend-design skill**

```
Load skill: frontend-design
```

Apply the skill's review process to:
- `src/screens/crew/crew-screen.tsx`
- Card layout vs Tasks/Dashboard card styles
- Copper/amber color usage consistency
- Typography sizing hierarchy (agent name > stats labels > muted)
- Mobile responsiveness (single column, cards still readable)
- Hover/focus states on footer action buttons
- Skeleton animation matches workspace shimmer style

**Step 2: Apply any design fixes**

Fix issues identified by the frontend-design skill inline in `crew-screen.tsx`.

**Step 3: Commit final design pass**

```bash
git add src/screens/crew/crew-screen.tsx
git commit -m "design: frontend-design skill pass for crew screen"
```

---

## Task 12: Final verification and integration test

**Objective:** Verify the complete feature works end-to-end.

**Step 1: Manual smoke test checklist**

- [ ] `/crew` route loads without errors
- [ ] All 5 crew members appear with correct names and Firefly roles
- [ ] Status dots show correct online/offline/unknown state
- [ ] Telegram connection state shows for each connected agent
- [ ] Model and provider display correctly
- [ ] Stats (sessions, messages, tools, tokens, cost) are non-zero for active agents
- [ ] Cron job count is non-zero for agents with crons
- [ ] "Updated Xs ago" ticks up every 5 seconds
- [ ] Refresh button triggers reload and spins during load
- [ ] Leaving the tab (switching to another browser tab) stops polling
- [ ] Returning to the tab triggers immediate refresh
- [ ] "Tasks" footer button navigates to /tasks?assignee=<agent>
- [ ] "Cron Jobs" footer button navigates to /jobs?agent=<agent>
- [ ] /tasks?assignee=kaylee shows only Kaylee's tasks
- [ ] /jobs?agent=kaylee filters jobs
- [ ] Clear button on both screens removes filter
- [ ] Skeleton shows on initial load
- [ ] Error state shows if API fails
- [ ] Mobile: cards stack to single column
- [ ] Crew nav item appears in desktop sidebar
- [ ] Crew tab appears in mobile pill nav

**Step 2: TypeScript final check**

```bash
cd ~/hermes-workspace
npx tsc --noEmit
```

Expected: 0 errors

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: crew status panel — complete implementation"
```

---

## Out of Scope

- Gateway restart / agent control actions
- Direct message to agent from panel
- Historical uptime charts
- Token usage over time graphs
- Ship's Log feed
