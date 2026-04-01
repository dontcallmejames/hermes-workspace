# Kanban Task Board — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a full Kanban task board into hermes-workspace — SQLite-backed REST API in the webapi, proxy routes in the workspace, and a drag-and-drop UI screen.

**Architecture:** SQLite storage in hermes-webapi-fork at `~/.hermes/tasks.db`. FastAPI routes at `/api/tasks` following the exact same pattern as `/api/jobs`. Workspace proxies via `/api/hermes-tasks` and renders the board at `/tasks`. Sidebar nav entry added between Jobs and Memory.

**Tech Stack:** Python/FastAPI/SQLite (webapi), TypeScript/React/TanStack Router/motion (workspace), HugeIcons, existing workspace UI components (Button, dialog, toast, cn).

**Note on drag-and-drop:** No dnd library is installed. Use CSS-based drag with HTML5 `draggable` attribute and `onDragOver`/`onDrop` events — no new dependencies needed.

**Spec:** `docs/specs/2026-04-01--kanban-task-board.md`

---

## File Map

```
hermes-webapi-fork/
  webapi/routes/tasks.py          (new — SQLite CRUD + REST API)
  webapi/app.py                   (modify — register tasks router)

hermes-workspace/
  src/lib/tasks-api.ts            (new — API client functions)
  src/routes/api/hermes-tasks.ts  (new — collection proxy)
  src/routes/api/hermes-tasks.$taskId.ts  (new — single task proxy)
  src/screens/tasks/tasks-screen.tsx      (new — Kanban UI)
  src/screens/tasks/task-card.tsx         (new — card component)
  src/screens/tasks/task-dialog.tsx       (new — create/edit modal)
  src/routes/tasks.tsx                    (new — route)
  src/routeTree.gen.ts                    (modify — auto-updated by Vite)
  src/components/workspace-shell.tsx      (modify — slide order)
  src/screens/chat/components/chat-sidebar.tsx  (modify — nav link)
  src/server/gateway-capabilities.ts     (modify — tasks probe)
```

---

## Task 1: Create SQLite tasks storage module in webapi

**Objective:** Create `webapi/routes/tasks.py` with SQLite initialization, all CRUD operations, and FastAPI routes.

**Files:**
- Create: `~/hermes-webapi-fork/webapi/routes/tasks.py`

**Step 1: Create the file**

```python
"""
Tasks (Kanban) routes — SQLite-backed task management API.
Follows the same pattern as webapi/routes/jobs.py.
"""

import json
import logging
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

# ---------------------------------------------------------------------------
# Database setup
# ---------------------------------------------------------------------------

VALID_COLUMNS = {"backlog", "todo", "in_progress", "review", "done"}
VALID_PRIORITIES = {"high", "medium", "low"}
VALID_ASSIGNEES = {"jim", "kaylee", "wash", "book", "river", "simon"}


def _db_path() -> str:
    return str(get_hermes_home() / "tasks.db")


@contextmanager
def _get_db():
    db = sqlite3.connect(_db_path(), timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _ensure_table():
    with _get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                column TEXT NOT NULL DEFAULT 'backlog',
                priority TEXT NOT NULL DEFAULT 'medium',
                assignee TEXT DEFAULT NULL,
                tags TEXT DEFAULT '[]',
                due_date TEXT DEFAULT NULL,
                position INTEGER DEFAULT 0,
                created_by TEXT DEFAULT 'user',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)


def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    d = dict(row)
    try:
        d["tags"] = json.loads(d.get("tags") or "[]")
    except (json.JSONDecodeError, TypeError):
        d["tags"] = []
    return d


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Initialize table on import
try:
    _ensure_table()
except Exception as e:
    logger.warning("Failed to initialize tasks table: %s", e)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class CreateTaskRequest(BaseModel):
    title: str
    description: Optional[str] = ""
    column: Optional[str] = "backlog"
    priority: Optional[str] = "medium"
    assignee: Optional[str] = None
    tags: Optional[List[str]] = []
    due_date: Optional[str] = None
    created_by: Optional[str] = "user"


class UpdateTaskRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    column: Optional[str] = None
    priority: Optional[str] = None
    assignee: Optional[str] = None
    tags: Optional[List[str]] = None
    due_date: Optional[str] = None


class MoveTaskRequest(BaseModel):
    column: str
    moved_by: Optional[str] = "user"


class ReorderRequest(BaseModel):
    task_ids: List[str]  # ordered list of IDs within the column


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
async def list_tasks(
    column: Optional[str] = Query(None),
    assignee: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    include_done: bool = Query(False),
):
    """GET /api/tasks — list tasks with optional filters."""
    _ensure_table()
    conditions = []
    params = []

    if not include_done:
        conditions.append("column != 'done'")

    if column:
        conditions.append("column = ?")
        params.append(column)

    if assignee:
        conditions.append("assignee = ?")
        params.append(assignee)

    if priority:
        conditions.append("priority = ?")
        params.append(priority)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    with _get_db() as db:
        rows = db.execute(
            f"SELECT * FROM tasks {where} ORDER BY column, position, created_at",
            params,
        ).fetchall()

    return {"tasks": [_row_to_dict(r) for r in rows]}


@router.post("")
async def create_task(body: CreateTaskRequest):
    """POST /api/tasks — create a new task."""
    _ensure_table()

    if body.column and body.column not in VALID_COLUMNS:
        raise HTTPException(status_code=400, detail=f"Invalid column: {body.column}")
    if body.priority and body.priority not in VALID_PRIORITIES:
        raise HTTPException(status_code=400, detail=f"Invalid priority: {body.priority}")
    if body.assignee and body.assignee not in VALID_ASSIGNEES:
        raise HTTPException(status_code=400, detail=f"Invalid assignee: {body.assignee}")

    task_id = str(uuid.uuid4())[:12]
    now = _now()

    with _get_db() as db:
        # Get max position in target column
        row = db.execute(
            "SELECT COALESCE(MAX(position), -1) as max_pos FROM tasks WHERE column = ?",
            [body.column or "backlog"],
        ).fetchone()
        position = (row["max_pos"] or 0) + 1

        db.execute(
            """INSERT INTO tasks
               (id, title, description, column, priority, assignee, tags, due_date, position, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                task_id,
                body.title.strip(),
                body.description or "",
                body.column or "backlog",
                body.priority or "medium",
                body.assignee,
                json.dumps(body.tags or []),
                body.due_date,
                position,
                body.created_by or "user",
                now,
                now,
            ],
        )
        row = db.execute("SELECT * FROM tasks WHERE id = ?", [task_id]).fetchone()

    return {"task": _row_to_dict(row)}


@router.get("/{task_id}")
async def get_task(task_id: str):
    """GET /api/tasks/{task_id} — get a single task."""
    _ensure_table()
    with _get_db() as db:
        row = db.execute("SELECT * FROM tasks WHERE id = ?", [task_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    return {"task": _row_to_dict(row)}


@router.patch("/{task_id}")
async def update_task(task_id: str, body: UpdateTaskRequest):
    """PATCH /api/tasks/{task_id} — update task fields."""
    _ensure_table()

    if body.column and body.column not in VALID_COLUMNS:
        raise HTTPException(status_code=400, detail=f"Invalid column: {body.column}")
    if body.priority and body.priority not in VALID_PRIORITIES:
        raise HTTPException(status_code=400, detail=f"Invalid priority: {body.priority}")
    if body.assignee and body.assignee not in VALID_ASSIGNEES:
        raise HTTPException(status_code=400, detail=f"Invalid assignee: {body.assignee}")

    updates = {}
    if body.title is not None:
        updates["title"] = body.title.strip()
    if body.description is not None:
        updates["description"] = body.description
    if body.column is not None:
        updates["column"] = body.column
    if body.priority is not None:
        updates["priority"] = body.priority
    if body.assignee is not None:
        updates["assignee"] = body.assignee
    if body.tags is not None:
        updates["tags"] = json.dumps(body.tags)
    if body.due_date is not None:
        updates["due_date"] = body.due_date

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates["updated_at"] = _now()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [task_id]

    with _get_db() as db:
        db.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", params)
        row = db.execute("SELECT * FROM tasks WHERE id = ?", [task_id]).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    return {"task": _row_to_dict(row)}


@router.delete("/{task_id}")
async def delete_task(task_id: str):
    """DELETE /api/tasks/{task_id} — delete a task."""
    _ensure_table()
    with _get_db() as db:
        result = db.execute("DELETE FROM tasks WHERE id = ?", [task_id])
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    return {"ok": True}


@router.post("/{task_id}/move")
async def move_task(task_id: str, body: MoveTaskRequest):
    """POST /api/tasks/{task_id}/move — move task to a different column."""
    _ensure_table()

    if body.column not in VALID_COLUMNS:
        raise HTTPException(status_code=400, detail=f"Invalid column: {body.column}")

    # Enforce hybrid autonomy: agents cannot move to 'done'
    moved_by = (body.moved_by or "user").lower()
    if moved_by != "jim" and moved_by != "user" and body.column == "done":
        raise HTTPException(
            status_code=403,
            detail="Only the user (jim) can mark tasks as done",
        )

    # Validate movement direction for agents (can only move forward)
    COLUMN_ORDER = ["backlog", "todo", "in_progress", "review", "done"]
    if moved_by not in ("jim", "user"):
        with _get_db() as db:
            row = db.execute("SELECT column FROM tasks WHERE id = ?", [task_id]).fetchone()
        if row:
            current_idx = COLUMN_ORDER.index(row["column"]) if row["column"] in COLUMN_ORDER else 0
            target_idx = COLUMN_ORDER.index(body.column)
            if target_idx < current_idx:
                raise HTTPException(
                    status_code=403,
                    detail="Agents can only move tasks forward",
                )

    now = _now()
    with _get_db() as db:
        # Place at bottom of target column
        row = db.execute(
            "SELECT COALESCE(MAX(position), -1) as max_pos FROM tasks WHERE column = ?",
            [body.column],
        ).fetchone()
        position = (row["max_pos"] or 0) + 1

        db.execute(
            "UPDATE tasks SET column = ?, position = ?, updated_at = ? WHERE id = ?",
            [body.column, position, now, task_id],
        )
        row = db.execute("SELECT * FROM tasks WHERE id = ?", [task_id]).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    return {"task": _row_to_dict(row), "moved_by": moved_by}


@router.post("/reorder")
async def reorder_tasks(body: ReorderRequest):
    """POST /api/tasks/reorder — set position order within a column."""
    _ensure_table()
    now = _now()
    with _get_db() as db:
        for i, task_id in enumerate(body.task_ids):
            db.execute(
                "UPDATE tasks SET position = ?, updated_at = ? WHERE id = ?",
                [i, now, task_id],
            )
    return {"ok": True}
```

**Step 2: Verify syntax**

```bash
cd ~/hermes-webapi-fork && python3 -c "import webapi.routes.tasks; print('OK')"
```
Expected: `OK`

**Step 3: Commit**

```bash
cd ~/hermes-webapi-fork
git add webapi/routes/tasks.py
git commit -m "feat(tasks): SQLite-backed kanban task REST API"
```

---

## Task 2: Register tasks router in webapi app.py

**Objective:** Wire the tasks router into the FastAPI app so `/api/tasks` is live.

**Files:**
- Modify: `~/hermes-webapi-fork/webapi/app.py`

**Step 1: Add the import** (after the jobs_router import line):

```python
from webapi.routes.tasks import router as tasks_router
```

**Step 2: Register the router** (after `app.include_router(jobs_router)`):

```python
app.include_router(tasks_router)
```

**Step 3: Restart webapi and verify**

```bash
pkill -f "uvicorn webapi.app" 2>/dev/null; sleep 2
cd ~/hermes-webapi-fork && nohup .venv/bin/uvicorn webapi.app:app --host 0.0.0.0 --port 8642 > /tmp/webapi.log 2>&1 &
sleep 4
curl -s http://127.0.0.1:8642/api/tasks | python3 -m json.tool
```
Expected: `{"tasks": []}`

**Step 4: Test create and list**

```bash
curl -s -X POST http://127.0.0.1:8642/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Test task","priority":"high","column":"todo"}' | python3 -m json.tool
```
Expected: `{"task": {"id": "...", "title": "Test task", "priority": "high", ...}}`

**Step 5: Commit**

```bash
cd ~/hermes-webapi-fork
git add webapi/app.py
git commit -m "feat(tasks): register tasks router in webapi app"
```

---

## Task 3: Add tasks capability probe to workspace gateway

**Objective:** Add `tasks` to the gateway capability probe so the workspace knows when the API is available.

**Files:**
- Modify: `~/hermes-workspace/src/server/gateway-capabilities.ts`

**Step 1: Add `tasks` to the `EnhancedCapabilities` type** (after `jobs: boolean`):

```typescript
tasks: boolean
```

**Step 2: Add `tasks: false` to the default capabilities object** (after `jobs: false`):

```typescript
tasks: false,
```

**Step 3: Add `tasks` to `OPTIONAL_APIS`** — find the line:
```typescript
const OPTIONAL_APIS = new Set(['jobs', 'chatCompletions', 'streaming'])
```
Change to:
```typescript
const OPTIONAL_APIS = new Set(['jobs', 'tasks', 'chatCompletions', 'streaming'])
```

**Step 4: Add `tasks` to `enhancedKeys`** — find:
```typescript
const enhancedKeys: Array<keyof EnhancedCapabilities> = ['sessions', 'skills', 'memory', 'config', 'jobs']
```
Change to:
```typescript
const enhancedKeys: Array<keyof EnhancedCapabilities> = ['sessions', 'skills', 'memory', 'config', 'jobs', 'tasks']
```

**Step 5: Add `tasks` to the probe** — find the `Promise.all` block that probes `/api/jobs` and add:
```typescript
probe('/api/tasks'),
```
Then destructure it: add `tasks` to the destructured result and add `tasks` to the `capabilities = { ... }` object.

**Step 6: Verify**

```bash
curl -s http://localhost:3000/api/gateway-status | python3 -c "import json,sys; d=json.load(sys.stdin); print('tasks:', d['capabilities'].get('tasks'))"
```
Expected: `tasks: True`

**Step 7: Commit**

```bash
cd ~/hermes-workspace
git add src/server/gateway-capabilities.ts
git commit -m "feat(tasks): add tasks capability probe to gateway"
```

---

## Task 4: Create workspace proxy routes for tasks

**Objective:** Create the two proxy route files that forward workspace requests to the webapi `/api/tasks` endpoints.

**Files:**
- Create: `~/hermes-workspace/src/routes/api/hermes-tasks.ts`
- Create: `~/hermes-workspace/src/routes/api/hermes-tasks.$taskId.ts`

**Step 1: Create `hermes-tasks.ts`** (collection — GET list, POST create):

```typescript
/**
 * Tasks API proxy — forwards to Hermes WebAPI /api/tasks
 */
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { HERMES_API, ensureGatewayProbed, getCapabilities } from '../../server/gateway-capabilities'

export const Route = createFileRoute('/api/hermes-tasks')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
        }
        await ensureGatewayProbed()
        if (!getCapabilities().tasks) {
          return new Response(JSON.stringify({ tasks: [], source: 'unavailable' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        const url = new URL(request.url)
        const params = url.searchParams.toString()
        const target = `${HERMES_API}/api/tasks${params ? `?${params}` : ''}`
        const res = await fetch(target)
        return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' } })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
        }
        await ensureGatewayProbed()
        if (!getCapabilities().tasks) {
          return new Response(JSON.stringify({ error: 'Tasks API unavailable' }), { status: 503 })
        }
        const body = await request.text()
        const res = await fetch(`${HERMES_API}/api/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
      },
    },
  },
})
```

**Step 2: Create `hermes-tasks.$taskId.ts`** (single task — GET, PATCH, DELETE, POST move/reorder):

```typescript
/**
 * Single task proxy — forwards to Hermes WebAPI /api/tasks/{id}
 */
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { HERMES_API, ensureGatewayProbed, getCapabilities } from '../../server/gateway-capabilities'

export const Route = createFileRoute('/api/hermes-tasks/$taskId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
        }
        await ensureGatewayProbed()
        const res = await fetch(`${HERMES_API}/api/tasks/${params.taskId}`)
        return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
      },
      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
        }
        const body = await request.text()
        const res = await fetch(`${HERMES_API}/api/tasks/${params.taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
        }
        const res = await fetch(`${HERMES_API}/api/tasks/${params.taskId}`, { method: 'DELETE' })
        return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
      },
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
        }
        const url = new URL(request.url)
        const action = url.searchParams.get('action') || 'move'
        const body = await request.text()
        const res = await fetch(`${HERMES_API}/api/tasks/${params.taskId}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
      },
    },
  },
})
```

**Step 3: Verify Vite picks up routes**

```bash
sleep 3 && curl -s http://localhost:3000/api/hermes-tasks | python3 -c "import json,sys; d=json.load(sys.stdin); print('tasks:', len(d.get('tasks', [])))"
```
Expected: `tasks: 0` (or however many test tasks exist)

**Step 4: Commit**

```bash
cd ~/hermes-workspace
git add src/routes/api/hermes-tasks.ts src/routes/api/hermes-tasks.\$taskId.ts
git commit -m "feat(tasks): add workspace proxy routes for tasks API"
```

---

## Task 5: Create tasks API client library

**Objective:** Create `src/lib/tasks-api.ts` with typed fetch functions for all task operations.

**Files:**
- Create: `~/hermes-workspace/src/lib/tasks-api.ts`

**Step 1: Create the file**

```typescript
/**
 * Tasks API client — talks to /api/hermes-tasks endpoints.
 */

const BASE = '/api/hermes-tasks'

export type TaskColumn = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done'
export type TaskPriority = 'high' | 'medium' | 'low'
export type TaskAssignee = 'jim' | 'kaylee' | 'wash' | 'book' | 'river' | 'simon'

export type HermesTask = {
  id: string
  title: string
  description: string
  column: TaskColumn
  priority: TaskPriority
  assignee: TaskAssignee | null
  tags: Array<string>
  due_date: string | null
  position: number
  created_by: string
  created_at: string
  updated_at: string
}

export type CreateTaskInput = {
  title: string
  description?: string
  column?: TaskColumn
  priority?: TaskPriority
  assignee?: TaskAssignee | null
  tags?: Array<string>
  due_date?: string | null
  created_by?: string
}

export type UpdateTaskInput = Partial<Omit<CreateTaskInput, 'created_by'>>

export async function fetchTasks(params?: {
  column?: TaskColumn
  assignee?: TaskAssignee
  priority?: TaskPriority
  include_done?: boolean
}): Promise<Array<HermesTask>> {
  const q = new URLSearchParams()
  if (params?.column) q.set('column', params.column)
  if (params?.assignee) q.set('assignee', params.assignee)
  if (params?.priority) q.set('priority', params.priority)
  if (params?.include_done) q.set('include_done', 'true')
  const url = q.toString() ? `${BASE}?${q}` : BASE
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`)
  const data = await res.json()
  return data.tasks ?? []
}

export async function createTask(input: CreateTaskInput): Promise<HermesTask> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `Failed to create task: ${res.status}`)
  }
  return (await res.json()).task
}

export async function updateTask(taskId: string, input: UpdateTaskInput): Promise<HermesTask> {
  const res = await fetch(`${BASE}/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to update task: ${res.status}`)
  return (await res.json()).task
}

export async function deleteTask(taskId: string): Promise<void> {
  const res = await fetch(`${BASE}/${taskId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to delete task: ${res.status}`)
}

export async function moveTask(taskId: string, column: TaskColumn, movedBy = 'user'): Promise<HermesTask> {
  const res = await fetch(`${BASE}/${taskId}?action=move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ column, moved_by: movedBy }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `Failed to move task: ${res.status}`)
  }
  return (await res.json()).task
}

export const COLUMN_LABELS: Record<TaskColumn, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
}

export const COLUMN_ORDER: Array<TaskColumn> = ['backlog', 'todo', 'in_progress', 'review', 'done']

export const PRIORITY_COLORS: Record<TaskPriority, string> = {
  high: '#ef4444',
  medium: '#f97316',
  low: '#6b7280',
}

export const COLUMN_COLORS: Record<TaskColumn, string> = {
  backlog: '#6b7280',
  todo: '#3b82f6',
  in_progress: '#f97316',
  review: '#a855f7',
  done: '#22c55e',
}

export const ASSIGNEE_LABELS: Record<string, string> = {
  jim: 'Jim',
  kaylee: 'Kaylee 🔧',
  wash: 'Wash',
  book: 'Book',
  river: 'River',
  simon: 'Simon',
}

export function isOverdue(task: HermesTask): boolean {
  if (!task.due_date) return false
  return new Date(task.due_date) < new Date()
}
```

**Step 2: Commit**

```bash
cd ~/hermes-workspace
git add src/lib/tasks-api.ts
git commit -m "feat(tasks): tasks API client library with types"
```

---

## Task 6: Create TaskCard component

**Objective:** Build the individual task card shown in each Kanban column.

**Files:**
- Create: `~/hermes-workspace/src/screens/tasks/task-card.tsx`

**Step 1: Create the file**

```tsx
import { cn } from '@/lib/utils'
import type { HermesTask } from '@/lib/tasks-api'
import { ASSIGNEE_LABELS, PRIORITY_COLORS, isOverdue } from '@/lib/tasks-api'

type Props = {
  task: HermesTask
  onClick: () => void
  onDragStart: (e: React.DragEvent) => void
  isDragging?: boolean
}

export function TaskCard({ task, onClick, onDragStart, isDragging }: Props) {
  const overdue = isOverdue(task)
  const priorityColor = PRIORITY_COLORS[task.priority]

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className={cn(
        'rounded-lg border p-3 cursor-pointer transition-all select-none',
        'bg-[var(--theme-card)] hover:bg-[var(--theme-card2)]',
        'border-[var(--theme-border)] hover:border-[var(--theme-accent)]',
        isDragging && 'opacity-40',
      )}
      style={{ borderLeftWidth: 3, borderLeftColor: priorityColor }}
    >
      {/* Title */}
      <p className="text-sm font-medium text-[var(--theme-text)] leading-snug mb-1 line-clamp-2">
        {task.title}
      </p>

      {/* Description preview */}
      {task.description && (
        <p className="text-xs text-[var(--theme-muted)] line-clamp-2 mb-2">
          {task.description}
        </p>
      )}

      {/* Footer row */}
      <div className="flex items-center justify-between gap-2 mt-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Assignee */}
          {task.assignee && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--theme-hover)] text-[var(--theme-muted)]">
              {ASSIGNEE_LABELS[task.assignee] ?? task.assignee}
            </span>
          )}

          {/* Tags */}
          {task.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--theme-hover)] text-[var(--theme-muted)]"
            >
              {tag}
            </span>
          ))}
        </div>

        {/* Due date */}
        {task.due_date && (
          <span
            className={cn(
              'text-[10px] tabular-nums',
              overdue ? 'text-red-400 font-semibold' : 'text-[var(--theme-muted)]',
            )}
          >
            {overdue ? '⚠ ' : ''}
            {new Date(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
cd ~/hermes-workspace
git add src/screens/tasks/task-card.tsx
git commit -m "feat(tasks): TaskCard component with priority border, tags, overdue"
```

---

## Task 7: Create TaskDialog component (create/edit modal)

**Objective:** Build the modal for creating and editing tasks, using the existing `dialog` UI component.

**Files:**
- Create: `~/hermes-workspace/src/screens/tasks/task-dialog.tsx`

**Step 1: Create the file**

```tsx
import { useEffect, useState } from 'react'
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { HermesTask, CreateTaskInput, TaskColumn, TaskPriority, TaskAssignee } from '@/lib/tasks-api'
import { COLUMN_LABELS, COLUMN_ORDER, ASSIGNEE_LABELS } from '@/lib/tasks-api'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  task?: HermesTask | null  // null = create mode, task = edit mode
  defaultColumn?: TaskColumn
  onSubmit: (input: CreateTaskInput) => Promise<void>
  isSubmitting: boolean
}

export function TaskDialog({ open, onOpenChange, task, defaultColumn, onSubmit, isSubmitting }: Props) {
  const isEdit = Boolean(task)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [column, setColumn] = useState<TaskColumn>(defaultColumn ?? 'backlog')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [assignee, setAssignee] = useState<TaskAssignee | ''>('')
  const [tags, setTags] = useState('')
  const [dueDate, setDueDate] = useState('')

  useEffect(() => {
    if (task) {
      setTitle(task.title)
      setDescription(task.description)
      setColumn(task.column)
      setPriority(task.priority)
      setAssignee(task.assignee ?? '')
      setTags(task.tags.join(', '))
      setDueDate(task.due_date ?? '')
    } else {
      setTitle('')
      setDescription('')
      setColumn(defaultColumn ?? 'backlog')
      setPriority('medium')
      setAssignee('')
      setTags('')
      setDueDate('')
    }
  }, [task, open, defaultColumn])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    await onSubmit({
      title: title.trim(),
      description: description.trim(),
      column,
      priority,
      assignee: (assignee as TaskAssignee) || null,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      due_date: dueDate || null,
    })
  }

  const inputClass = cn(
    'w-full rounded-lg border px-3 py-2 text-sm',
    'bg-[var(--theme-input)] border-[var(--theme-border)] text-[var(--theme-text)]',
    'focus:outline-none focus:ring-1 focus:ring-[var(--theme-accent)]',
    'placeholder:text-[var(--theme-muted)]',
  )

  const labelClass = 'block text-xs font-medium text-[var(--theme-muted)] mb-1'

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(520px,95vw)] border-[var(--theme-border)] bg-[var(--theme-bg)]">
        <div className="p-5">
          <DialogTitle className="text-base font-semibold text-[var(--theme-text)] mb-1">
            {isEdit ? 'Edit Task' : 'New Task'}
          </DialogTitle>
          <DialogDescription className="text-xs text-[var(--theme-muted)] mb-4">
            {isEdit ? 'Update the task details below.' : 'Fill in the details for your new task.'}
          </DialogDescription>

          <form onSubmit={handleSubmit} className="space-y-3">
            {/* Title */}
            <div>
              <label className={labelClass}>Title *</label>
              <input
                className={inputClass}
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="What needs to be done?"
                required
                autoFocus
              />
            </div>

            {/* Description */}
            <div>
              <label className={labelClass}>Description</label>
              <textarea
                className={cn(inputClass, 'resize-none')}
                rows={3}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Optional details..."
              />
            </div>

            {/* Column + Priority row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Column</label>
                <select
                  className={inputClass}
                  value={column}
                  onChange={e => setColumn(e.target.value as TaskColumn)}
                >
                  {COLUMN_ORDER.map(col => (
                    <option key={col} value={col}>{COLUMN_LABELS[col]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Priority</label>
                <select
                  className={inputClass}
                  value={priority}
                  onChange={e => setPriority(e.target.value as TaskPriority)}
                >
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
            </div>

            {/* Assignee + Due date row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Assignee</label>
                <select
                  className={inputClass}
                  value={assignee}
                  onChange={e => setAssignee(e.target.value as TaskAssignee | '')}
                >
                  <option value="">Unassigned</option>
                  {Object.entries(ASSIGNEE_LABELS).map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Due Date</label>
                <input
                  type="date"
                  className={inputClass}
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                />
              </div>
            </div>

            {/* Tags */}
            <div>
              <label className={labelClass}>Tags (comma-separated)</label>
              <input
                className={inputClass}
                value={tags}
                onChange={e => setTags(e.target.value)}
                placeholder="hermes, neon-syndicate, personal"
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={isSubmitting || !title.trim()}
                style={{ background: 'var(--theme-accent)', color: 'white' }}
              >
                {isSubmitting ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Task'}
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </DialogRoot>
  )
}
```

**Step 2: Commit**

```bash
cd ~/hermes-workspace
git add src/screens/tasks/task-dialog.tsx
git commit -m "feat(tasks): TaskDialog create/edit modal component"
```

---

## Task 8: Create the main TasksScreen (Kanban board)

**Objective:** Build the full Kanban board screen with columns, cards, drag-and-drop, stats bar, and create/edit flow.

**Files:**
- Create: `~/hermes-workspace/src/screens/tasks/tasks-screen.tsx`

**Step 1: Create the file**

```tsx
'use client'

import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Add01Icon, RefreshIcon } from '@hugeicons/core-free-icons'
import { TaskCard } from './task-card'
import { TaskDialog } from './task-dialog'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import {
  fetchTasks,
  createTask,
  updateTask,
  deleteTask,
  moveTask,
  COLUMN_LABELS,
  COLUMN_ORDER,
  COLUMN_COLORS,
  isOverdue,
} from '@/lib/tasks-api'
import type { HermesTask, TaskColumn, CreateTaskInput } from '@/lib/tasks-api'

const QUERY_KEY = ['hermes', 'tasks'] as const

export function TasksScreen() {
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [createColumn, setCreateColumn] = useState<TaskColumn>('backlog')
  const [editingTask, setEditingTask] = useState<HermesTask | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<TaskColumn | null>(null)
  const [showDone, setShowDone] = useState(false)

  const tasksQuery = useQuery({
    queryKey: [...QUERY_KEY, showDone],
    queryFn: () => fetchTasks({ include_done: showDone }),
    refetchInterval: 30_000,
  })

  const tasks = tasksQuery.data ?? []

  // Group tasks by column
  const tasksByColumn = useMemo(() => {
    const map: Record<TaskColumn, Array<HermesTask>> = {
      backlog: [], todo: [], in_progress: [], review: [], done: [],
    }
    for (const t of tasks) {
      if (map[t.column]) map[t.column].push(t)
    }
    // Sort by position within each column
    for (const col of COLUMN_ORDER) {
      map[col].sort((a, b) => a.position - b.position)
    }
    return map
  }, [tasks])

  // Stats
  const stats = useMemo(() => {
    const allTasks = [...tasks]
    const total = allTasks.length
    const inProgress = allTasks.filter(t => t.column === 'in_progress').length
    const done = allTasks.filter(t => t.column === 'done').length
    const overdue = allTasks.filter(t => isOverdue(t) && t.column !== 'done').length
    const completion = total > 0 ? Math.round((done / total) * 100) : 0
    return { total, inProgress, done, overdue, completion }
  }, [tasks])

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
  }, [queryClient])

  const createMutation = useMutation({
    mutationFn: createTask,
    onSuccess: () => { invalidate(); toast('Task created'); setShowCreate(false) },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed to create task', { type: 'error' }),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: CreateTaskInput }) => updateTask(id, input),
    onSuccess: () => { invalidate(); toast('Task updated'); setEditingTask(null) },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed to update task', { type: 'error' }),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteTask,
    onSuccess: () => { invalidate(); toast('Task deleted') },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed to delete task', { type: 'error' }),
  })

  const moveMutation = useMutation({
    mutationFn: ({ id, column }: { id: string; column: TaskColumn }) => moveTask(id, column, 'user'),
    onSuccess: () => invalidate(),
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed to move task', { type: 'error' }),
  })

  // Drag and drop handlers
  function handleDragStart(e: React.DragEvent, taskId: string) {
    e.dataTransfer.setData('text/plain', taskId)
    setDraggingId(taskId)
  }

  function handleDragOver(e: React.DragEvent, col: TaskColumn) {
    e.preventDefault()
    setDragOverColumn(col)
  }

  function handleDrop(e: React.DragEvent, targetColumn: TaskColumn) {
    e.preventDefault()
    const taskId = e.dataTransfer.getData('text/plain')
    const task = tasks.find(t => t.id === taskId)
    if (task && task.column !== targetColumn) {
      moveMutation.mutate({ id: taskId, column: targetColumn })
    }
    setDraggingId(null)
    setDragOverColumn(null)
  }

  function handleDragEnd() {
    setDraggingId(null)
    setDragOverColumn(null)
  }

  const visibleColumns = showDone ? COLUMN_ORDER : COLUMN_ORDER.filter(c => c !== 'done')

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--theme-border)] px-4 py-3 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-base font-semibold text-[var(--theme-text)]">Tasks</h1>
          {/* Stats */}
          <div className="hidden sm:flex items-center gap-3 text-xs text-[var(--theme-muted)]">
            <span>{stats.total} total</span>
            <span>·</span>
            <span>{stats.inProgress} in progress</span>
            {stats.overdue > 0 && (
              <>
                <span>·</span>
                <span className="text-red-400">{stats.overdue} overdue</span>
              </>
            )}
            <span>·</span>
            <span>{stats.completion}% done</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowDone(v => !v)}
            className="text-xs text-[var(--theme-muted)] hover:text-[var(--theme-text)] transition-colors px-2 py-1 rounded"
          >
            {showDone ? 'Hide Done' : 'Show Done'}
          </button>
          <button
            onClick={invalidate}
            className="rounded-lg p-1.5 transition-colors hover:bg-[var(--theme-hover)]"
            title="Refresh"
          >
            <HugeiconsIcon icon={RefreshIcon} size={16} className="text-[var(--theme-muted)]" />
          </button>
          <button
            onClick={() => { setCreateColumn('backlog'); setShowCreate(true) }}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: 'var(--theme-accent)' }}
          >
            <HugeiconsIcon icon={Add01Icon} size={14} />
            New Task
          </button>
        </div>
      </div>

      {/* Board */}
      <div className="flex flex-1 gap-3 overflow-x-auto overflow-y-hidden p-4 min-h-0">
        {visibleColumns.map((col) => {
          const colTasks = tasksByColumn[col]
          const colColor = COLUMN_COLORS[col]
          const isDragOver = dragOverColumn === col

          return (
            <div
              key={col}
              className={cn(
                'flex flex-col rounded-xl border min-w-[240px] w-[280px] shrink-0',
                'bg-[var(--theme-card)] border-[var(--theme-border)]',
                'transition-colors',
                isDragOver && 'border-[var(--theme-accent)] bg-[var(--theme-hover)]',
              )}
              onDragOver={e => handleDragOver(e, col)}
              onDrop={e => handleDrop(e, col)}
              onDragLeave={() => setDragOverColumn(null)}
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--theme-border)]">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: colColor }}
                  />
                  <span className="text-xs font-semibold text-[var(--theme-text)]">
                    {COLUMN_LABELS[col]}
                  </span>
                  <span className="text-xs text-[var(--theme-muted)]">
                    ({colTasks.length})
                  </span>
                </div>
                <button
                  onClick={() => { setCreateColumn(col); setShowCreate(true) }}
                  className="rounded p-0.5 hover:bg-[var(--theme-hover)] transition-colors"
                  title={`Add to ${COLUMN_LABELS[col]}`}
                >
                  <HugeiconsIcon icon={Add01Icon} size={14} className="text-[var(--theme-muted)]" />
                </button>
              </div>

              {/* Cards */}
              <div className="flex flex-col gap-2 p-2 flex-1 overflow-y-auto">
                <AnimatePresence initial={false}>
                  {colTasks.length === 0 ? (
                    <div className="text-xs text-[var(--theme-muted)] text-center py-6 opacity-50">
                      No tasks
                    </div>
                  ) : (
                    colTasks.map(task => (
                      <motion.div
                        key={task.id}
                        layout
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                      >
                        <TaskCard
                          task={task}
                          isDragging={draggingId === task.id}
                          onDragStart={e => handleDragStart(e, task.id)}
                          onClick={() => setEditingTask(task)}
                        />
                      </motion.div>
                    ))
                  )}
                </AnimatePresence>
              </div>
            </div>
          )
        })}
      </div>

      {/* Create dialog */}
      <TaskDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        defaultColumn={createColumn}
        isSubmitting={createMutation.isPending}
        onSubmit={async (input) => { await createMutation.mutateAsync(input) }}
      />

      {/* Edit dialog */}
      <TaskDialog
        open={editingTask !== null}
        onOpenChange={(open) => { if (!open) setEditingTask(null) }}
        task={editingTask}
        isSubmitting={updateMutation.isPending}
        onSubmit={async (input) => {
          if (!editingTask) return
          await updateMutation.mutateAsync({ id: editingTask.id, input })
        }}
      />
    </div>
  )
}
```

**Step 2: Commit**

```bash
cd ~/hermes-workspace
git add src/screens/tasks/tasks-screen.tsx
git commit -m "feat(tasks): main Kanban board screen with drag-and-drop"
```

---

## Task 9: Create the tasks route

**Objective:** Register the `/tasks` route in TanStack Router.

**Files:**
- Create: `~/hermes-workspace/src/routes/tasks.tsx`

**Step 1: Create the file**

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'
import { TasksScreen } from '@/screens/tasks/tasks-screen'

export const Route = createFileRoute('/tasks')({
  component: TasksRoute,
})

function TasksRoute() {
  usePageTitle('Tasks')
  return <TasksScreen />
}
```

**Step 2: Verify Vite picked it up**

```bash
sleep 3 && curl -o /dev/null -s -w "%{http_code}" http://localhost:3000/tasks
```
Expected: `200`

**Step 3: Commit**

```bash
cd ~/hermes-workspace
git add src/routes/tasks.tsx
git commit -m "feat(tasks): register /tasks route"
```

---

## Task 10: Add Tasks to sidebar navigation and workspace-shell

**Objective:** Wire Tasks into the sidebar nav (between Jobs and Memory) and update the slide order in workspace-shell.

**Files:**
- Modify: `~/hermes-workspace/src/screens/chat/components/chat-sidebar.tsx`
- Modify: `~/hermes-workspace/src/components/workspace-shell.tsx`

**Step 1: Add icon import to chat-sidebar.tsx**

Find the existing icon imports at the top of chat-sidebar.tsx and add `CheckListIcon` or a suitable task icon. Use `Task01Icon` from `@hugeicons/core-free-icons`. If unavailable, use `CheckmarkSquare01Icon`.

Search for available icon:
```bash
grep -r "Task\|Kanban\|CheckList\|Checklist" ~/hermes-workspace/node_modules/@hugeicons/core-free-icons/dist/index.js 2>/dev/null | head -5
```

Use whichever task-related icon exists. Fallback: `NoteIcon` or `ListViewIcon`.

**Step 2: Add the Tasks nav item** in chat-sidebar.tsx

Find the `workspaceItems` array containing the Jobs link:
```typescript
{
  kind: 'link',
  to: '/jobs',
  icon: Clock01Icon,
  label: 'Jobs',
  active: isJobsActive,
},
```

Add after it:
```typescript
{
  kind: 'link',
  to: '/tasks',
  icon: Task01Icon,  // or whichever icon was found
  label: 'Tasks',
  active: pathname.startsWith('/tasks'),
},
```

**Step 3: Update slide order in workspace-shell.tsx**

Find the slide order function (lines 98-107) and add tasks:
```typescript
if (path.startsWith('/tasks')) return 5
if (path.startsWith('/memory')) return 6
if (path.startsWith('/skills')) return 7
if (path.startsWith('/settings')) return 8
```
(shift memory/skills/settings up by 1)

**Step 4: Add page title detection** in workspace-shell.tsx

Find:
```typescript
if (pathname.startsWith('/jobs')) return 'Jobs'
```

Add after:
```typescript
if (pathname.startsWith('/tasks')) return 'Tasks'
```

**Step 5: Verify the route appears in sidebar and navigates correctly**

```bash
curl -s http://localhost:3000/tasks | grep -c "Tasks" && echo "route ok"
```

**Step 6: Commit**

```bash
cd ~/hermes-workspace
git add src/screens/chat/components/chat-sidebar.tsx src/components/workspace-shell.tsx
git commit -m "feat(tasks): add Tasks to sidebar nav and slide order"
```

---

## Task 11: End-to-end smoke test

**Objective:** Verify the full stack works — create, display, move, delete a task.

**Step 1: Test webapi directly**

```bash
# Create
TASK=$(curl -s -X POST http://127.0.0.1:8642/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Smoke test task","priority":"high","column":"todo","assignee":"kaylee","tags":["test"]}')
echo $TASK | python3 -m json.tool | head -10
TASK_ID=$(echo $TASK | python3 -c "import json,sys; print(json.load(sys.stdin)['task']['id'])")
echo "Task ID: $TASK_ID"

# List
curl -s http://127.0.0.1:8642/api/tasks | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['tasks']), 'tasks')"

# Move
curl -s -X POST http://127.0.0.1:8642/api/tasks/$TASK_ID/move \
  -H "Content-Type: application/json" \
  -d '{"column":"in_progress","moved_by":"user"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['task']['column'])"

# Agent cannot move to done
curl -s -X POST http://127.0.0.1:8642/api/tasks/$TASK_ID/move \
  -H "Content-Type: application/json" \
  -d '{"column":"done","moved_by":"kaylee"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('detail','ok'))"

# Delete
curl -s -X DELETE http://127.0.0.1:8642/api/tasks/$TASK_ID | python3 -c "import json,sys; print(json.load(sys.stdin))"
```

Expected outputs:
- Task created with id, title, column=todo
- 1 tasks (or more if test tasks remain)
- `in_progress`
- `Only the user (jim) can mark tasks as done`
- `{'ok': True}`

**Step 2: Test workspace proxy**

```bash
curl -s http://localhost:3000/api/hermes-tasks | python3 -c "import json,sys; d=json.load(sys.stdin); print('tasks proxy ok, count:', len(d.get('tasks',[])))"
```

Expected: `tasks proxy ok, count: 0` (or however many remain)

**Step 3: Final commit**

```bash
cd ~/hermes-workspace
git push origin main
cd ~/hermes-webapi-fork
git push origin main 2>/dev/null || echo "no remote configured"
```

---

## Task 12: Frontend design polish pass

**Objective:** After verifying everything works functionally, run the frontend-design skill on the tasks screen to ensure visual consistency with the rest of hermes-workspace.

**Step 1:** Load the `frontend-design` skill and apply it to:
- `src/screens/tasks/tasks-screen.tsx`
- `src/screens/tasks/task-card.tsx`
- `src/screens/tasks/task-dialog.tsx`

Focus areas:
- CSS variable tokens (`--theme-*`) used consistently
- Card hover states match the jobs screen style
- Dialog matches the existing dialog pattern
- Column header style matches the sidebar panel aesthetic
- Mobile responsiveness — columns should stack or scroll horizontally on small screens
- Priority color borders are subtle, not garish
- Empty state illustration/text matches the jobs empty state style

**Step 2: Commit polished version**

```bash
cd ~/hermes-workspace
git add src/screens/tasks/
git commit -m "style(tasks): frontend-design polish pass for visual consistency"
git push origin main
```

---

## Completion Checklist

- [ ] Task 1: SQLite tasks API in webapi
- [ ] Task 2: Router registered in app.py
- [ ] Task 3: Gateway capability probe updated
- [ ] Task 4: Workspace proxy routes
- [ ] Task 5: Tasks API client library
- [ ] Task 6: TaskCard component
- [ ] Task 7: TaskDialog component
- [ ] Task 8: TasksScreen Kanban board
- [ ] Task 9: Route registered
- [ ] Task 10: Sidebar nav + workspace-shell wired
- [ ] Task 11: End-to-end smoke test passes
- [ ] Task 12: Frontend design polish
