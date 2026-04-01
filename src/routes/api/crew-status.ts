import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import yaml from 'yaml'
import { HERMES_API, ensureGatewayProbed } from '../../server/gateway-capabilities'

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

function readGatewayState(hermesHome: string) {
  const path = join(hermesHome, 'gateway_state.json')
  if (!existsSync(path)) return { pid: null, gatewayState: 'unknown', platforms: {}, updatedAt: null }
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
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readDbStats(hermesHome: string) {
  const dbPath = join(hermesHome, 'state.db')
  if (!existsSync(dbPath)) return { sessionCount: 0, messageCount: 0, toolCallCount: 0, totalTokens: 0, estimatedCostUsd: null, lastSessionTitle: null, lastSessionAt: null }
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
    `).get() as { session_count: number; total_messages: number; total_tool_calls: number; total_tokens: number; estimated_cost: number | null; last_session_at: number | null }
    const lastSession = db.prepare(`SELECT title, started_at FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as { title: string | null; started_at: number } | undefined
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
    return { sessionCount: 0, messageCount: 0, toolCallCount: 0, totalTokens: 0, estimatedCostUsd: null, lastSessionTitle: null, lastSessionAt: null }
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
      return { model: m.default ?? 'unknown', provider: m.provider ?? 'unknown' }
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
    const res = await fetch(`${HERMES_API}/api/tasks?include_done=false`, { signal: AbortSignal.timeout(3_000) })
    if (!res.ok) return 0
    const data = await res.json() as { tasks?: Array<{ assignee?: string; column?: string }> }
    return (data.tasks ?? []).filter(t => t.assignee === agentId && t.column !== 'done').length
  } catch {
    return 0
  }
}

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
              return { id: member.id, role: member.role, profileFound: false, gatewayState: 'unknown', processAlive: false, platforms: {}, model: 'unknown', provider: 'unknown', lastSessionTitle: null, lastSessionAt: null, sessionCount: 0, messageCount: 0, toolCallCount: 0, totalTokens: 0, estimatedCostUsd: null, cronJobCount: 0, assignedTaskCount: 0 }
            }
            const gatewayInfo = readGatewayState(hermesHome)
            const processAlive = checkProcessAlive(gatewayInfo.pid)
            const dbStats = readDbStats(hermesHome)
            const config = readConfig(hermesHome)
            const cronJobCount = readCronJobCount(hermesHome)
            const assignedTaskCount = await fetchAssignedTaskCount(member.id)
            return { id: member.id, role: member.role, profileFound: true, gatewayState: gatewayInfo.gatewayState, processAlive, platforms: gatewayInfo.platforms, model: config.model, provider: config.provider, lastSessionTitle: dbStats.lastSessionTitle, lastSessionAt: dbStats.lastSessionAt, sessionCount: dbStats.sessionCount, messageCount: dbStats.messageCount, toolCallCount: dbStats.toolCallCount, totalTokens: dbStats.totalTokens, estimatedCostUsd: dbStats.estimatedCostUsd, cronJobCount, assignedTaskCount }
          })
        )
        return json({ crew, fetchedAt: Date.now() })
      },
    },
  },
})
