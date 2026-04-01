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
      <p className="text-sm font-medium text-[var(--theme-text)] leading-snug mb-1 line-clamp-2">
        {task.title}
      </p>

      {task.description && (
        <p className="text-xs text-[var(--theme-muted)] line-clamp-2 mb-2">
          {task.description}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 mt-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {task.assignee && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--theme-hover)] text-[var(--theme-muted)]">
              {ASSIGNEE_LABELS[task.assignee] ?? task.assignee}
            </span>
          )}
          {task.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--theme-hover)] text-[var(--theme-muted)]"
            >
              {tag}
            </span>
          ))}
        </div>

        {task.due_date && (
          <span
            className={cn(
              'text-[10px] tabular-nums',
              overdue ? 'text-red-400 font-semibold' : 'text-[var(--theme-muted)]',
            )}
          >
            {overdue ? '\u26a0 ' : ''}
            {new Date(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>
    </div>
  )
}
