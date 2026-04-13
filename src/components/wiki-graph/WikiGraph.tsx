/// <reference types="cytoscape" />

import { useEffect, useRef, useState, useCallback } from 'react'
import type { KnowledgeGraphNode, KnowledgeGraphEdge } from '../../screens/memory/knowledge-browser-screen'

// ─── Cytoscape fcose layout extension ───────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('cytoscape-fcose')

// ─── Types ─────────────────────────────────────────────────────────────────

type WikiGraphProps = {
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
  onSelect: (path: string) => void
  currentPage?: string | null
}

// ─── Tag color palette ─────────────────────────────────────────────────────

const TAG_COLORS: Record<string, string> = {
  ai: '#e05c5c',
  ml: '#c070e0',
  engineering: '#5caee0',
  ops: '#5cb87a',
  research: '#e0a05c',
  gaming: '#e06c5c',
  forensics: '#5c8de0',
  default: '#94a3b8',
}

function getNodeColor(tags: Array<string> | undefined, isActive: boolean): string {
  if (isActive) return 'var(--accent, #3b82f6)'
  const first = tags?.[0]?.toLowerCase()
  if (first && first in TAG_COLORS) return TAG_COLORS[first]
  return TAG_COLORS.default
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function WikiGraph({ nodes, edges, onSelect, currentPage }: WikiGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cyRef = useRef<any>(null)
  const [filter, setFilter] = useState('')
  const [localMode, setLocalMode] = useState(false)
  const [dimensions, setDimensions] = useState({ width: 900, height: 520 })
  const filterRef = useRef(filter)
  filterRef.current = filter

  // ── Init Cytoscape ────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!containerRef.current) return

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cytoscape = require('cytoscape') as typeof import('cytoscape')

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: buildStylesheet(currentPage, cytoscape),
      layout: { name: 'preset' },
      minZoom: 0.15,
      maxZoom: 5,
      wheelSensitivity: 0.35,
      boxSelectionEnabled: false,
    })

    cyRef.current = cy

    // ── Hover: neighbor spotlight ─────────────────────────────────────────
    cy.on('mouseover', 'node', (e: cytoscape.EventObject) => {
      if (localMode) return
      const node = e.target
      const neighborhood = node.closedNeighborhood()

      cy.elements().not(neighborhood).not(node).addClass('dimmed')
      node.addClass('hovered')
      node.connectedEdges().addClass('connected')
      node.neighborhood('node').addClass('connected')
    })

    cy.on('mouseover', 'edge', (e: cytoscape.EventObject) => {
      if (localMode) return
      const edge = e.target
      edge.addClass('connected')
      edge.source().addClass('connected')
      edge.target().addClass('connected')
    })

    cy.on('mouseout', 'node', () => {
      if (localMode) return
      cy.elements().removeClass('hovered connected dimmed')
    })

    cy.on('mouseout', 'edge', (e: cytoscape.EventObject) => {
      if (localMode) return
      e.target.removeClass('connected')
    })

    // ── Click: navigate ─────────────────────────────────────────────────
    cy.on('tap', 'node', (e: cytoscape.EventObject) => {
      const nodeId = e.target.id()
      onSelect(decodeURIComponent(nodeId))
    })

    // ── Resize observer ────────────────────────────────────────────────
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 10 && height > 10) {
          setDimensions({ width, height })
          cy.resize()
        }
      }
    })
    if (containerRef.current) ro.observe(containerRef.current)

    const rect = containerRef.current.getBoundingClientRect()
    if (rect.width > 10 && rect.height > 10) {
      setDimensions({ width: rect.width, height: rect.height })
    }

    return () => {
      ro.disconnect()
      cy.destroy()
      cyRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeof window === 'undefined'])

  // ── Load / reload graph data ─────────────────────────────────────────────

  useEffect(() => {
    const cy = cyRef.current
    if (!cy || nodes.length === 0) return

    const currentFilter = filterRef.current
    const filtered = currentFilter
      ? nodes.filter(
          (n) =>
            n.title.toLowerCase().includes(currentFilter.toLowerCase()) ||
            n.tags?.some((t: string) => t.toLowerCase().includes(currentFilter.toLowerCase())),
        )
      : nodes

    const visibleIds = new Set(filtered.map((n) => n.id))

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cytoscape = require('cytoscape') as typeof import('cytoscape')

    const elements: cytoscape.ElementDefinition[] = [
      ...filtered.map((node) => ({
        data: {
          id: node.id,
          label: node.title.length > 26 ? node.title.slice(0, 24) + '…' : node.title,
          title: node.title,
          tags: node.tags,
        },
        classes: node.id === currentPage ? 'active-node' : undefined,
      })),
      ...edges
        .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
        .map((edge) => ({
          data: { source: edge.source, target: edge.target },
        })),
    ]

    cy.elements().remove()
    cy.add(elements)

    // Run fcose layout
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(cy.layout as any)({
      name: 'fcose',
      animate: false,
      randomize: true,
      dimensions: dimensions,
      layoutOptions: {
        randomize: true,
        animate: false,
        fit: true,
        padding: 50,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 110,
        edgeElasticity: () => 0.08,
        gravity: 0.25,
      },
    } as cytoscape.LayoutOptions).run()

    setTimeout(() => cy.fit(undefined, 50), 400)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, currentPage, dimensions])

  // ── Local mode ───────────────────────────────────────────────────────────

  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return

    if (!localMode) {
      cy.elements().removeClass('hovered connected dimmed')
      return
    }

    if (!currentPage) return

    const currentNode = cy.$id(currentPage)
    if (currentNode.empty()) return

    const neighborhood = currentNode.closedNeighborhood()
    cy.elements().addClass('dimmed')
    neighborhood.removeClass('dimmed')
    currentNode.addClass('hovered')
  }, [localMode, currentPage])

  // ── Filter change ────────────────────────────────────────────────────────

  const handleFilterChange = useCallback((value: string) => {
    setFilter(value)
    filterRef.current = value
  }, [])

  // ── Fit view ─────────────────────────────────────────────────────────────

  const handleFit = useCallback(() => {
    cyRef.current?.fit(undefined, 50)
  }, [])

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        {/* Filter input */}
        <div className="relative flex-1">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--theme-muted)]"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Filter nodes by name or tag…"
            value={filter}
            onChange={(e) => handleFilterChange(e.target.value)}
            className="w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] py-2 pl-9 pr-3 text-sm text-[var(--theme-text)] placeholder-[var(--theme-muted)] outline-none transition-colors focus:border-[var(--accent)]"
          />
        </div>

        {/* Local mode toggle */}
        <button
          type="button"
          onClick={() => setLocalMode((v) => !v)}
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
            localMode
              ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
              : 'border-[var(--theme-border)] bg-[var(--theme-card)] text-[var(--theme-text)] hover:border-[var(--theme-muted)]'
          }`}
          title="Toggle local mode: show only current page + immediate neighbors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <circle cx="4" cy="12" r="2" />
            <circle cx="20" cy="12" r="2" />
            <line x1="6" y1="12" x2="9" y2="12" />
            <line x1="15" y1="12" x2="18" y2="12" />
          </svg>
          Local
        </button>

        {/* Fit view */}
        <button
          type="button"
          onClick={handleFit}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] px-3 py-2 text-sm font-medium text-[var(--theme-text)] transition-colors hover:border-[var(--theme-muted)]"
          title="Fit graph to view"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--theme-muted)]">
        <span>Click node to open page</span>
        <span>·</span>
        <span>Hover to spotlight connections</span>
        <span>·</span>
        <span>
          <span
            className="mr-1 inline-block size-2 rounded-full"
            style={{ backgroundColor: 'var(--accent, #3b82f6)' }}
          />
          Current page
        </span>
      </div>

      {/* Graph canvas */}
      <div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)]"
        style={{ height: 520 }}
      />
    </div>
  )
}

// ─── Style sheet builder ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildStylesheet(currentPageId: string | null | undefined, cytoscape: any) {
  return cytoscape.stylesheet()
    .selector('node')
    .style({
      'background-color': (ele: cytoscape.NodeSingular) => {
        const isActive = ele.id() === currentPageId
        const tags = ele.data('tags') as Array<string> | undefined
        return getNodeColor(tags, isActive)
      },
      'border-width': 1.5,
      'border-color': 'rgba(148,163,184,0.35)',
      label: 'data(label)',
      color: 'var(--theme-text, #e2e8f0)',
      'font-size': 11,
      width: 24,
      height: 24,
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 7,
      'text-outline-width': 3,
      'text-outline-color': 'var(--theme-bg, #0f172a)',
    })
    .selector('node:selected')
    .style({
      'border-color': 'var(--accent, #3b82f6)',
      'border-width': 2.5,
    })
    .selector('edge')
    .style({
      width: 1.2,
      'line-color': 'rgba(148,163,184,0.35)',
      'target-arrow-color': 'rgba(148,163,184,0.35)',
      'target-arrow-shape': 'none',
      'curve-style': 'bezier',
      opacity: 0.65,
    })
    // State classes applied by JS event handlers
    .selector('.hovered')
    .style({
      'border-color': 'var(--accent, #3b82f6)',
      'border-width': 2.5,
      'background-color': 'var(--accent, #3b82f6)',
      'z-index': 10,
    })
    .selector('.connected')
    .style({
      'border-color': 'rgba(148,163,184,0.7)',
      'line-color': 'rgba(148,163,184,0.75)',
      'target-arrow-color': 'rgba(148,163,184,0.75)',
      opacity: 1,
      'z-index': 5,
    })
    .selector('.dimmed')
    .style({
      opacity: 0.12,
      'z-index': 1,
    })
    .selector('.active-node')
    .style({
      'border-color': 'var(--accent, #3b82f6)',
      'border-width': 3,
      'background-color': 'var(--accent, #3b82f6)',
    })
}
