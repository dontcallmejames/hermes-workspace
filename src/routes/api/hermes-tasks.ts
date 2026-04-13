/**
 * Tasks API — JSON file persistence layer.
 * Reads/writes ~/.hermes/tasks.json (simple, portable, no native modules needed in SSR).
 */
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import os from 'node:os'

const HERMES_HOME = process.env.HERMES_HOME ?? resolve(os.homedir(), '.hermes')
const TASKS_FILE = resolve(HERMES_HOME, 'tasks.json')

interface Task {
  id: string
  title: string
  description: string
  column: string
  priority: string
  assignee: string | null
  tags: string[]
  due_date: string | null
  position: number
  created_by: string
  created_at: string
  updated_at: string
}

function ensureFile() {
  const dir = HERMES_HOME
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  if (!existsSync(TASKS_FILE)) {
    writeFileSync(TASKS_FILE, JSON.stringify({ tasks: [] }, null, 2))
  }
}

function readTasks(): Task[] {
  ensureFile()
  try {
    const raw = readFileSync(TASKS_FILE, 'utf-8')
    if (!raw.trim()) return []
    const data = JSON.parse(raw) as { tasks: Task[] }
    return data.tasks ?? []
  } catch {
    return []
  }
}

function writeTasks(tasks: Task[]) {
  ensureFile()
  writeFileSync(TASKS_FILE, JSON.stringify({ tasks }, null, 2), 'utf-8')
}

function taskToRecord(task: Task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    column: task.column,
    priority: task.priority,
    assignee: task.assignee,
    tags: task.tags,
    due_date: task.due_date,
    position: task.position,
    created_by: task.created_by,
    created_at: task.created_at,
    updated_at: task.updated_at,
  }
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status)
}

export const Route = createFileRoute('/api/hermes-tasks')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return errorResponse('Unauthorized', 401)
        }
        try {
          const url = new URL(request.url)
          const includeDone = url.searchParams.get('include_done') === 'true'
          const tasks = readTasks()
          const filtered = includeDone ? tasks : tasks.filter((t) => t.column !== 'done')
          return jsonResponse({ tasks: filtered.map(taskToRecord) })
        } catch (err) {
          console.error('[tasks] GET error:', err)
          return errorResponse('Internal error', 500)
        }
      },

      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return errorResponse('Unauthorized', 401)
        }
        try {
          const body = (await request.json()) as Record<string, unknown>
          const {
            title,
            description = '',
            column = 'backlog',
            priority = 'medium',
            assignee = null,
            tags = [],
            due_date = null,
            position = 0,
            created_by = 'user',
          } = body

          if (!title || typeof title !== 'string') {
            return errorResponse('title is required', 400)
          }

          const tasks = readTasks()
          const id = (body.id as string) || crypto.randomUUID()
          const now = new Date().toISOString()

          const newTask: Task = {
            id,
            title,
            description: description as string,
            column: column as string,
            priority: priority as string,
            assignee: assignee as string | null,
            tags: tags as string[],
            due_date: due_date as string | null,
            position: position as number,
            created_by: created_by as string,
            created_at: now,
            updated_at: now,
          }

          tasks.push(newTask)
          writeTasks(tasks)

          return jsonResponse(taskToRecord(newTask), 201)
        } catch (err) {
          console.error('[tasks] POST error:', err)
          return errorResponse('Internal error', 500)
        }
      },

      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return errorResponse('Unauthorized', 401)
        }
        try {
          const body = (await request.json()) as Record<string, unknown>
          const id = body.id as string

          if (!id) {
            return errorResponse('id is required', 400)
          }

          const tasks = readTasks()
          const idx = tasks.findIndex((t) => t.id === id)
          if (idx === -1) {
            return errorResponse('Task not found', 404)
          }

          const allowed = ['title', 'description', 'column', 'priority', 'assignee', 'tags', 'due_date', 'position']
          const updated = { ...tasks[idx] }

          for (const key of allowed) {
            if (body[key] !== undefined) {
              (updated as Record<string, unknown>)[key] = body[key]
            }
          }
          updated.updated_at = new Date().toISOString()

          tasks[idx] = updated
          writeTasks(tasks)

          return jsonResponse(taskToRecord(updated))
        } catch (err) {
          console.error('[tasks] PATCH error:', err)
          return errorResponse('Internal error', 500)
        }
      },

      DELETE: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return errorResponse('Unauthorized', 401)
        }
        try {
          const body = (await request.json()) as Record<string, unknown>
          const id = body.id as string

          if (!id) {
            return errorResponse('id is required', 400)
          }

          const tasks = readTasks()
          const idx = tasks.findIndex((t) => t.id === id)
          if (idx === -1) {
            return errorResponse('Task not found', 404)
          }

          tasks.splice(idx, 1)
          writeTasks(tasks)

          return jsonResponse({ ok: true })
        } catch (err) {
          console.error('[tasks] DELETE error:', err)
          return errorResponse('Internal error', 500)
        }
      },
    },
  },
})
