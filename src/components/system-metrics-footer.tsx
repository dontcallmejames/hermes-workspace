'use client'

import { useQuery } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  CheckmarkCircle02Icon,
  CpuIcon,
  DatabaseIcon,
  HardDriveIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'

type SystemMetrics = {
  checkedAt: number
  cpu: {
    loadPercent: number
    loadAverage1m: number
    cores: number
  }
  memory: {
    usedBytes: number
    totalBytes: number
    usedPercent: number
  }
  disk: {
    path: string
    usedBytes: number
    totalBytes: number
    usedPercent: number
  }
  hermes: {
    status: 'connected' | 'enhanced' | 'partial' | 'disconnected'
    health: boolean
    dashboard: boolean
  }
}

async function fetchSystemMetrics(): Promise<SystemMetrics> {
  const response = await fetch('/api/system-metrics', { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<SystemMetrics>
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function metricTone(percent: number): 'good' | 'warn' | 'hot' {
  if (percent >= 90) return 'hot'
  if (percent >= 75) return 'warn'
  return 'good'
}

function MetricPill({
  icon,
  label,
  value,
  tone = 'good',
}: {
  icon: typeof CpuIcon
  label: string
  value: string
  tone?: 'good' | 'warn' | 'hot' | 'muted'
}) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur-md',
        tone === 'good' &&
          'border-emerald-400/25 bg-emerald-500/10 text-emerald-100',
        tone === 'warn' && 'border-amber-400/30 bg-amber-500/10 text-amber-100',
        tone === 'hot' && 'border-red-400/30 bg-red-500/10 text-red-100',
        tone === 'muted' && 'border-white/10 bg-white/5 text-primary-100/75',
      )}
    >
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.7} />
      <span className="uppercase tracking-[0.12em] opacity-60">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export function SystemMetricsFooter({ leftOffsetPx = 0 }: { leftOffsetPx?: number }) {
  const { data, isError } = useQuery({
    queryKey: ['system-metrics-footer'],
    queryFn: fetchSystemMetrics,
    refetchInterval: 15_000,
    staleTime: 14_000,
  })

  const hermesHealthy = data?.hermes.status === 'connected' || data?.hermes.status === 'enhanced'

  return (
    <footer
      className="fixed bottom-0 right-0 z-40 hidden h-8 items-center justify-center border-t border-l border-white/10 bg-neutral-950/85 px-4 text-xs text-primary-100 shadow-[0_-8px_24px_rgba(0,0,0,0.22)] backdrop-blur-xl md:flex"
      data-testid="system-metrics-footer"
      aria-label="System metrics footer"
      style={{ left: leftOffsetPx }}
    >
      <div className="flex max-w-full items-center gap-2 overflow-hidden">
        {data ? (
          <>
            <MetricPill
              icon={CpuIcon}
              label="CPU"
              value={`${data.cpu.loadPercent}% (${data.cpu.loadAverage1m}/${data.cpu.cores})`}
              tone={metricTone(data.cpu.loadPercent)}
            />
            <MetricPill
              icon={DatabaseIcon}
              label="RAM"
              value={`${data.memory.usedPercent}% ${formatBytes(data.memory.usedBytes)}/${formatBytes(data.memory.totalBytes)}`}
              tone={metricTone(data.memory.usedPercent)}
            />
            <MetricPill
              icon={HardDriveIcon}
              label="Disk"
              value={`${data.disk.usedPercent}% ${formatBytes(data.disk.usedBytes)}/${formatBytes(data.disk.totalBytes)}`}
              tone={metricTone(data.disk.usedPercent)}
            />
            <MetricPill
              icon={hermesHealthy ? CheckmarkCircle02Icon : WifiDisconnected02Icon}
              label="Hermes"
              value={data.hermes.status}
              tone={hermesHealthy ? 'good' : 'warn'}
            />
          </>
        ) : (
          <MetricPill
            icon={isError ? WifiDisconnected02Icon : CpuIcon}
            label="Metrics"
            value={isError ? 'unavailable' : 'loading'}
            tone={isError ? 'warn' : 'muted'}
          />
        )}
      </div>
    </footer>
  )
}
