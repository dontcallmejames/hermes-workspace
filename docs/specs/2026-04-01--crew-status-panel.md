# Crew Status Panel — Design Spec
**Date:** 2026-04-01
**Feature:** `/crew` route — Serenity Crew Manifest
**Status:** Approved for implementation

---

## Overview

A dedicated full-page tab in hermes-workspace showing live status for all 5 crew agents (Kaylee, Wash, Book, River, Simon). Styled as a crew dossier/manifest — dark workspace foundation with Firefly personality. Copper borders, role subtitles, full telemetry per agent. Auto-refreshes every 30s while the tab is visible, pauses when hidden.

---

## Crew Roster & Firefly Roles

| Agent   | Firefly Role        | Profile Path                        |
|---------|---------------------|-------------------------------------|
| kaylee  | Ship's Engineer     | ~/.hermes/ (default profile)        |
| wash    | Pilot               | ~/.hermes/profiles/wash/            |
| book    | Shepherd            | ~/.hermes/profiles/book/            |
| river   | Reader              | ~/.hermes/profiles/river/           |
| simon   | Ship's Doctor       | ~/.hermes/profiles/simon/           |

---

## Architecture

### Three layers

**1. Backend API — `/api/crew-status`**

New server route in hermes-workspace. Reads directly from the filesystem — no new hermes-agent webapi required. Returns a unified JSON array of crew member objects. Also calls the existing `/api/tasks` proxy to get assigned task counts per agent.

Data sources per agent:
- `gateway_state.json` — gateway running state, platform connections, last updated timestamp
- `/proc/<pid>/status` (or `ps -p <pid>`) — live process liveness check
- `state.db` — SQLite: session count, last session title, last session started_at, total messages, total tool calls, total input+output tokens, estimated cost
- `config.yaml` — model name + provider
- `cron/jobs.json` — number of registered cron jobs
- `/api/tasks` (existing proxy) — count of tasks assigned to this agent (non-Done)

**2. Frontend hook — `src/hooks/use-crew-status.ts`**

React Query hook:
- Polls `/api/crew-status` every 30 seconds
- Pauses via `document.addEventListener('visibilitychange')` when tab is hidden
- Tracks `lastUpdated` timestamp for "Updated Xs ago" display
- Returns `{ crew, lastUpdated, isLoading, isError, refetch }`

**3. UI — `src/screens/crew/crew-screen.tsx` + route + nav entry**

Full page layout. See UI section below.

---

## API Response Schema

```
GET /api/crew-status

Response: {
  crew: CrewMember[]
  fetchedAt: number  // unix ms
}

CrewMember {
  id: string                    // "kaylee" | "wash" | "book" | "river" | "simon"
  role: string                  // "Ship's Engineer" etc.
  gatewayState: "running" | "stopped" | "unknown"
  processAlive: boolean
  platforms: {
    telegram?: { state: "connected" | "disconnected"; updatedAt: string }
  }
  model: string                 // e.g. "claude-sonnet-4-6"
  provider: string              // e.g. "anthropic"
  lastSessionTitle: string | null
  lastSessionAt: number | null  // unix seconds
  sessionCount: number
  messageCount: number
  toolCallCount: number
  totalTokens: number           // input + output combined
  estimatedCostUsd: number | null
  cronJobCount: number
  assignedTaskCount: number     // non-Done tasks assigned to this agent
}
```

**Derived status field (frontend-computed, not in API):**

```
"online"   — gatewayState === "running" AND processAlive === true
"offline"  — gatewayState !== "running" OR processAlive === false
"unknown"  — could not read gateway_state.json or pid check failed
```

---

## UI Design

### Page Header

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SERENITY CREW MANIFEST
  ▸ 5 crew · 4 online · Updated 12s ago   [↻ Refresh]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

- Title in copper/amber (#B87333 / amber-400)
- Thin copper horizontal rule as divider (not a full box, just a line)
- Subtitle shows crew count, online count, last updated age, manual refresh button
- Faint opacity Serenity silhouette SVG watermark behind the title (very subtle, ~5% opacity)

### Card Grid

5 cards in a responsive grid:
- Desktop: 3 across top row + 2 centered on bottom (or 2+3 depending on screen width)
- Tablet: 2 columns
- Mobile: 1 column, scrollable

### Agent Card Design

```
┌─ [copper left border 3px] ───────────────────┐
│  ● ONLINE          [role: Ship's Engineer]   │
│                                               │
│  KAYLEE                                       │
│  claude-sonnet-4-6 · anthropic                │
│  Telegram: connected                          │
│                                               │
│  Last active: 2h ago                          │
│  "Crew Status Panel brainstorm"               │
│                                               │
│  ┌──────────┬──────────┬──────────┐           │
│  │ Sessions │ Messages │  Tools   │           │
│  │   1,247  │  18,432  │  4,821   │           │
│  └──────────┴──────────┴──────────┘           │
│                                               │
│  Tokens: 4.2M    Est. Cost: $12.40            │
│  Cron Jobs: 8    Tasks: 3 assigned            │
│                                               │
│  ─────────────────────────────────────────   │
│  [≡ Tasks]                    [⏱ Cron Jobs]  │
└───────────────────────────────────────────────┘
```

**Card anatomy:**
- Copper left border (3px solid #B87333) — always present
- Top-right: Firefly role in small muted text
- Status dot: green (online), red (offline), gray (unknown) — with label
- Agent name: large, prominent, copper tint on hover
- Model + provider in muted small text
- Telegram connection state
- Last active: relative time ("2h ago", "just now", "never")
- Last session title in italic muted text (truncated)
- Stats grid: Sessions / Messages / Tools in a 3-column mini-table
- Token count (formatted: "4.2M") + estimated cost (if available)
- Cron job count + assigned task count
- Thin divider
- Footer: two subtle ghost/text buttons — "Tasks" and "Cron Jobs" — clicking navigates to /tasks?assignee=kaylee and /jobs?agent=kaylee respectively

**Card states:**
- Online: copper left border, normal opacity
- Offline: red left border, card dimmed to ~70% opacity, "OFFLINE" badge
- Unknown: gray left border, muted

**Color palette (consistent with workspace dark theme):**
- Background: same card bg as tasks/dashboard (~#1a1a2e or workspace default)
- Online status dot: #22c55e (green-500)
- Offline status dot: #ef4444 (red-500)
- Unknown: #6b7280 (gray-500)
- Copper accent: #B87333
- Amber text: #f59e0b (amber-400)
- Stats values: white/near-white
- Stats labels: muted gray
- Footer actions: ghost style, copper on hover

### Loading State

Skeleton cards — same layout as real cards, shimmer animation. 5 skeleton cards on initial load.

### Error State

If `/api/crew-status` fails: a single error panel with a retry button. Doesn't crash the page.

### Empty / Unreachable Agent

If a profile directory doesn't exist or can't be read: card still renders but shows "Profile not found" with gray border.

---

## Navigation

- Add "Crew" entry to the main nav (sidebar + mobile tab bar)
- Icon: Users or Ship icon (or a custom crew emoji ⚓)
- Route: `/crew`
- Position: after Dashboard, before Tasks (or after Tasks — TBD during implementation)

### Filtered navigation from card actions

- "Tasks" button → navigates to `/tasks` with `?assignee=<id>` query param
  - tasks-screen.tsx should read this param and pre-filter the board to that assignee
- "Cron Jobs" button → navigates to `/jobs` with `?agent=<id>` query param
  - jobs-screen.tsx should read this param and pre-filter to that agent's jobs

Note: If the Tasks/Jobs screens don't currently support query-param filtering, a simple client-side filter on load is sufficient. Does not require a full filter UI to be built — just reads the param on mount and sets the local filter state.

---

## Data Notes

### Profile path resolution

```
kaylee  →  ~/.hermes/
wash    →  ~/.hermes/profiles/wash/
book    →  ~/.hermes/profiles/book/
river   →  ~/.hermes/profiles/river/
simon   →  ~/.hermes/profiles/simon/
```

### SQLite query for stats

```sql
SELECT
  COUNT(*) as session_count,
  SUM(message_count) as total_messages,
  SUM(tool_call_count) as total_tool_calls,
  SUM(input_tokens + output_tokens) as total_tokens,
  SUM(estimated_cost_usd) as estimated_cost,
  MAX(started_at) as last_session_at
FROM sessions;

-- Separate query for last session title:
SELECT title, started_at FROM sessions ORDER BY started_at DESC LIMIT 1;
```

### Cron job count

Read `~/.hermes/[profiles/<name>/]cron/jobs.json` — count entries in the array.

### Assigned task count

Call existing `/api/tasks` endpoint, filter by `assignee === agent.id` AND `status !== 'done'`. Count results.

### Process liveness

```python
import os
pid = gateway_state["pid"]
try:
    os.kill(pid, 0)   # signal 0 = existence check, no actual signal
    alive = True
except (ProcessLookupError, PermissionError):
    alive = False
```

---

## Polling & Visibility Behavior

```typescript
// Pause polling when tab is hidden (Page Visibility API)
useEffect(() => {
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') {
      refetch()          // immediate refresh on tab focus
    }
  }
  document.addEventListener('visibilitychange', handleVisibility)
  return () => document.removeEventListener('visibilitychange', handleVisibility)
}, [refetch])

// React Query config
useQuery({
  queryKey: ['crew-status'],
  queryFn: fetchCrewStatus,
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,  // pauses when tab hidden
})
```

`refetchIntervalInBackground: false` is the React Query native way to pause polling when the document is hidden. The visibilitychange listener handles the immediate refetch on return.

---

## Frontend Design Skill Pass

After implementation is complete and rendering correctly, run the frontend-design skill review pass before committing. Focus areas:

1. Card layout consistency with existing Tasks/Dashboard card styles
2. Copper/amber color usage — should feel like an extension of the Kaylee skin, not a standalone theme
3. Typography sizing and weight hierarchy (agent name > stats labels > muted text)
4. Mobile responsiveness — single column, cards still readable
5. Hover/focus states on the footer action buttons
6. Skeleton loading animation matches workspace shimmer style

---

## Files to Create/Modify

**New files:**
- `src/routes/api/crew-status.ts` — backend API route
- `src/hooks/use-crew-status.ts` — polling hook
- `src/screens/crew/crew-screen.tsx` — main page component
- `src/routes/crew.tsx` — route definition

**Modified files:**
- `src/router.tsx` — add /crew route
- `src/routeTree.gen.ts` — regenerated by TanStack Router
- `src/components/workspace-shell.tsx` (or nav file) — add Crew nav entry
- `src/routes/tasks.tsx` (or tasks-screen.tsx) — read ?assignee= param on mount
- `src/routes/jobs.tsx` (or jobs-screen.tsx) — read ?agent= param on mount

---

## Out of Scope (future)

- Restart gateway / start/stop agent actions
- Direct message to agent from panel
- Historical uptime charts per agent
- Token usage over time graphs
- Ship's Log feed (separate feature)
