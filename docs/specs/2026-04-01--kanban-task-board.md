# Kanban Task Board — Design Spec
**Date:** 2026-04-01  
**Status:** Awaiting approval  
**Author:** Kaylee (with Jim)

---

## Overview

A Kanban-style task board built into Hermes Workspace, accessible via a new `/tasks` route. Tasks can be created and managed by the user or by any assigned agent. Agents can move tasks forward autonomously up to Review; only the user can mark tasks Done. Any agent-driven status change triggers a Telegram notification.

Designed for upstream contribution — built on SQLite + webapi like the existing jobs/sessions pattern, with a clean REST API so any frontend (or future frontends) can consume it.

---

## Columns

| Column | Color | Description |
|--------|-------|-------------|
| Backlog | Gray | Someday/maybe pile — not yet committed |
| Todo | Blue | Committed, ready to start |
| In Progress | Orange | Actively being worked on |
| Review | Purple | Work done, needs checking |
| Done | Green | Closed out |

Columns are ordered and fixed. Cards can be dragged between columns or moved via the API.

---

## Task Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | string (UUID) | auto | Generated on creation |
| title | string | yes | Max 200 chars |
| description | string | no | Markdown supported |
| column | enum | yes | backlog/todo/in_progress/review/done |
| priority | enum | yes | high/medium/low — default: medium |
| assignee | enum | no | jim/kaylee/wash/book/river/simon |
| tags | string[] | no | Freeform, e.g. ["hermes", "neon-syndicate"] |
| due_date | ISO date | no | Optional. Overdue = flagged red on card |
| created_at | timestamp | auto | |
| updated_at | timestamp | auto | |
| created_by | enum | auto | Who/what created the task |
| position | integer | auto | Sort order within column |

---

## Architecture

### Two-part implementation

**Part 1 — hermes-webapi** (upstreamable to hermes-agent repo)
- SQLite table `tasks` in `~/.hermes/tasks.db`
- REST API at `/api/tasks` following the same pattern as `/api/jobs`
- Python module `webapi/routes/tasks.py`

**Part 2 — hermes-workspace** (upstreamable to hermes-workspace repo)
- Proxy routes at `/api/hermes-tasks` and `/api/hermes-tasks/$taskId`
- New screen `src/screens/tasks/tasks-screen.tsx`
- New route `src/routes/tasks.tsx`
- Sidebar nav entry

### Storage — SQLite

```sql
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    column TEXT NOT NULL DEFAULT 'backlog',
    priority TEXT NOT NULL DEFAULT 'medium',
    assignee TEXT DEFAULT NULL,
    tags TEXT DEFAULT '[]',  -- JSON array stored as string
    due_date TEXT DEFAULT NULL,  -- ISO date string
    position INTEGER DEFAULT 0,
    created_by TEXT DEFAULT 'user',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

Concurrency handled by SQLite's built-in write locking — safe for multiple agents writing simultaneously.

---

## REST API — `/api/tasks`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/tasks | List all tasks (filterable by column, assignee, priority) |
| POST | /api/tasks | Create a new task |
| GET | /api/tasks/{id} | Get a single task |
| PATCH | /api/tasks/{id} | Update task fields |
| DELETE | /api/tasks/{id} | Delete a task |
| POST | /api/tasks/{id}/move | Move to a different column |
| POST | /api/tasks/reorder | Reorder positions within a column |

### Query params for GET /api/tasks
- `?column=backlog` — filter by column
- `?assignee=kaylee` — filter by assignee
- `?priority=high` — filter by priority
- `?include_done=true` — include Done column (excluded by default for performance)

### Agent autonomy rules enforced server-side

The `/api/tasks/{id}/move` endpoint accepts a `moved_by` field. If `moved_by` is an agent (not `jim`) and the target column is `done`, the API returns a 403 with `{"error": "Only the user can mark tasks as done"}`. This is enforced in the webapi, not just the frontend.

---

## Telegram Integration

When an agent moves a task via the API with `moved_by` set to an agent name, the webapi fires a Telegram notification:

```
🔧 Wash moved "Fix auth bug in Neon Syndicate" → Review
```

This is handled by an optional webhook config in `~/.hermes/config.yaml`:

```yaml
tasks:
  notify_on_agent_move: true
```

Falls back gracefully (no error) if Telegram is not configured.

---

## Frontend — Kanban Screen

### Layout

```
┌─────────────────────────────────────────────────────┐
│  Tasks   [+ New Task]          [Filter ▼] [Search]  │
│  5 total · 2 in progress · 1 overdue                │
├──────────┬──────────┬────────────┬────────┬─────────┤
│ Backlog  │  Todo    │ In Progress│ Review │  Done   │
│   (1)    │   (2)    │    (2)     │  (0)   │   (0)   │
│          │          │            │        │         │
│ [card]   │ [card]   │ [card]     │        │         │
│ [card]   │ [card]   │ [card]     │        │         │
│          │          │            │        │         │
│  [+ Add] │  [+ Add] │  [+ Add]   │[+ Add] │ [+ Add] │
└──────────┴──────────┴────────────┴────────┴─────────┘
```

### Task Card

```
┌──────────────────────────────────┐
│ 🔴 Fix auth bug in Neon Syndicate│  ← title (red = high priority)
│ Debug the JWT refresh issue...   │  ← description preview
│                                  │
│ 🔧 Wash  · neon-syndicate        │  ← assignee · tags
│ Due Apr 5 ⚠️ overdue             │  ← due date (red if overdue)
└──────────────────────────────────┘
```

Priority colors: High = red border, Medium = orange border, Low = no border

### Interactions
- **Drag and drop** between columns (with agent autonomy rules enforced client-side too)
- **Click card** to open detail/edit modal
- **+ Add** at bottom of each column — quick-add with just a title
- **New Task button** — full create modal with all fields
- **Overdue** tasks get a red due date label

### Stats bar
- Total tasks · In progress count · Overdue count · Completion % (done / total)

---

## Agent Integration

Agents (Wash, Book, River, etc.) can interact with the board via the webapi:

```python
# Example: Wash moving his task to Review when done
import requests
requests.post("http://127.0.0.1:8642/api/tasks/{id}/move", json={
    "column": "review",
    "moved_by": "wash"
})
```

A skill (`kanban` skill) will be created so agents can easily:
- List their assigned tasks
- Move tasks forward
- Create tasks on behalf of the user (when messaged via Telegram)

### Telegram "add task" flow

Jim messages: `!kaylee add task: fix the login bug on Neon Syndicate, high priority, assign to Wash`

Kaylee parses and creates the task, confirms:
`✅ Task added: "Fix the login bug on Neon Syndicate" → Backlog, High, assigned to Wash`

---

## Capability Probe

The workspace's gateway capabilities probe adds `tasks` to the check list, same pattern as `jobs`:

```typescript
const tasks = await probe('/api/tasks')
capabilities = { ...capabilities, tasks }
```

If `tasks` capability is false, the Tasks tab shows an upgrade prompt.

---

## Implementation Plan (Two PRs)

### PR 1 — hermes-agent / hermes-webapi
1. `webapi/routes/tasks.py` — SQLite storage + REST API
2. Register in `webapi/app.py`
3. `tools/kanban_tool.py` — agent-facing skill tool
4. Add `tasks` to capability probe list

### PR 2 — hermes-workspace
1. `src/routes/api/hermes-tasks.ts` — proxy route
2. `src/routes/api/hermes-tasks.$taskId.ts` — single task proxy
3. `src/screens/tasks/tasks-screen.tsx` — Kanban UI
4. `src/routes/tasks.tsx` — route
5. Sidebar nav entry
6. Capability probe update

---

## Design Polish Pass

After the initial implementation is functional, run the kanban screen through the `frontend-design` skill to ensure visual consistency with the rest of hermes-workspace — colors, spacing, card styling, typography, dark theme tokens, hover states, and mobile responsiveness. This is a mandatory step before the feature is considered complete.

---

## Out of Scope (Future)

- Multiple boards (Projects board) — separate spec
- Comments/activity log on tasks
- File attachments
- Recurring tasks
- Board-level permissions per agent
