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

  const tasksByColumn = useMemo(() => {
    const map: Record<TaskColumn, Array<HermesTask>> = {
      backlog: [], todo: [], in_progress: [], review: [], done: [],
    }
    for (const t of tasks) {
      if (map[t.column]) map[t.column].push(t)
    }
    for (const col of COLUMN_ORDER) {
      map[col].sort((a, b) => a.position - b.position)
    }
    return map
  }, [tasks])

  const stats = useMemo(() => {
    const total = tasks.length
    const inProgress = tasks.filter(t => t.column === 'in_progress').length
    const done = tasks.filter(t => t.column === 'done').length
    const overdue = tasks.filter(t => isOverdue(t) && t.column !== 'done').length
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
                        onDragEnd={handleDragEnd}
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
