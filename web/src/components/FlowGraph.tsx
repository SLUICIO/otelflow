import { Fragment, useMemo } from 'react'
import type { Component, ConfigModel, Diagnostic, Kind } from '../types'
import { componentType } from '../types'

const NODE_W = 170
const NODE_H = 46
const NODE_GAP = 12
const COL_GAP = 56
const LANE_PAD = 16
const LANE_HEADER = 34
const LANE_GAP = 24
const ADD_H = 32
const MARGIN = 24

export interface Selection {
  kind: Kind
  id: string
}

interface Props {
  model: ConfigModel
  componentIndex: Map<string, Component> // key: `${kind}:${type}`
  diagnostics: Diagnostic[]
  selected: Selection | null
  onSelect: (sel: Selection | null) => void
  onAdd: (kind: Kind, pipelineId?: string) => void
  onAddPipeline: () => void
  readOnly?: boolean
}

interface NodePos {
  x: number
  y: number
  id: string
  kind: Kind
}

interface LaneLayout {
  pipeline: ConfigModel['pipelines'][number]
  y: number
  height: number
  receivers: NodePos[]
  processors: NodePos[]
  exporters: NodePos[]
  exporterX: number
}

export interface GraphLayout {
  lanes: LaneLayout[]
  laneWidth: number
  exporterX: number
  pipelineZoneY: number
  extY: number
  totalH: number
  totalW: number
  maxProc: number
  showExtensions: boolean
}

/**
 * Pure layout computation, shared between rendering and consumers that need
 * to predict the canvas size (the share dialog computes exact embed heights
 * from it — embeds are immutable, so the prediction stays correct).
 */
export function computeLayout(model: ConfigModel, readOnly = false): GraphLayout {
  const connectorIds = new Set(model.sections.connectors)
  const maxProc = Math.max(0, ...model.pipelines.map((p) => p.processors.length))
  // Middle area: one column per processor, at least one column wide. The
  // "+ Processor" zone lives at the BOTTOM of this area, below the rows
  // where edges travel, so lines never cross it.
  const procZone = Math.max(maxProc, 1) * (NODE_W + COL_GAP)
  const exporterX = LANE_PAD + NODE_W + COL_GAP + procZone
  const laneWidth = exporterX + NODE_W + LANE_PAD
  // Read-only embeds render no add zones, so don't reserve their rows.
  const zoneH = readOnly ? 0 : ADD_H

  const lanes: LaneLayout[] = []
  let y = MARGIN
  for (const p of model.pipelines) {
    const recvColH = p.receivers.length * (NODE_H + NODE_GAP) + zoneH
    const expColH = p.exporters.length * (NODE_H + NODE_GAP) + zoneH
    const contentH = Math.max(recvColH, expColH, NODE_H + NODE_GAP)
    const height = LANE_HEADER + contentH + LANE_PAD

    const midY = y + LANE_HEADER + (contentH - zoneH - NODE_H) / 2

    const receivers = p.receivers.map((id, i) => ({
      id,
      kind: (connectorIds.has(id) ? 'connector' : 'receiver') as Kind,
      x: LANE_PAD,
      y: y + LANE_HEADER + i * (NODE_H + NODE_GAP),
    }))
    const exporters = p.exporters.map((id, i) => ({
      id,
      kind: (connectorIds.has(id) ? 'connector' : 'exporter') as Kind,
      x: exporterX,
      y: y + LANE_HEADER + i * (NODE_H + NODE_GAP),
    }))
    const processors = p.processors.map((id, j) => ({
      id,
      kind: 'processor' as Kind,
      x: LANE_PAD + NODE_W + COL_GAP + j * (NODE_W + COL_GAP),
      y: midY,
    }))
    lanes.push({ pipeline: p, y, height, receivers, processors, exporters, exporterX })
    y += height + LANE_GAP
  }

  // Pipeline add zone (edit mode only), then extensions rail. Read-only
  // embeds skip the zones, and skip the rail entirely when the config
  // defines no extensions.
  const pipelineZoneY = y
  if (!readOnly) y += ADD_H + 20
  const showExtensions = !readOnly || model.sections.extensions.length > 0
  const extY = y + 8
  const extRailH = 30 + NODE_H + 16
  const totalH = (showExtensions ? extY + extRailH : y) + MARGIN
  // Extra width on the right for the connector-edge routing channel.
  const totalW = Math.max(laneWidth + MARGIN * 2 + 56, 720)
  return { lanes, laneWidth, exporterX, pipelineZoneY, extY, totalH, totalW, maxProc, showExtensions }
}

export function FlowGraph({ model, componentIndex, diagnostics, selected, onSelect, onAdd, onAddPipeline, readOnly }: Props) {
  const connectorIds = new Set(model.sections.connectors)

  // Section+id pairs that have an error/warning diagnostic, to badge nodes.
  const problems = useMemo(() => {
    const map = new Map<string, 'error' | 'warning'>()
    for (const d of diagnostics) {
      if (!d.path || d.severity === 'info') continue
      const m = d.path.match(/^(receivers|processors|exporters|extensions|connectors)\.([^.]+)$/)
      if (!m) continue
      const key = `${m[1]}.${m[2]}`
      if (d.severity === 'error' || !map.has(key)) map.set(key, d.severity)
    }
    return map
  }, [diagnostics])

  const layout = useMemo(() => computeLayout(model, readOnly), [model, readOnly])

  // Cross-lane connector edges: exporter-side instance -> receiver-side
  // instance, with the lanes they sit in (needed for routing).
  const connectorEdges = useMemo(() => {
    const edges: { from: NodePos; fromLane: LaneLayout; to: NodePos; toLane: LaneLayout; id: string }[] = []
    for (const id of connectorIds) {
      const sources: { n: NodePos; lane: LaneLayout }[] = []
      const targets: { n: NodePos; lane: LaneLayout }[] = []
      for (const lane of layout.lanes) {
        for (const n of lane.exporters) if (n.id === id) sources.push({ n, lane })
        for (const n of lane.receivers) if (n.id === id) targets.push({ n, lane })
      }
      for (const s of sources)
        for (const t of targets)
          edges.push({ from: s.n, fromLane: s.lane, to: t.n, toLane: t.lane, id })
    }
    return edges
  }, [layout, connectorIds])

  if (model.pipelines.length === 0) {
    return (
      <div className="graph-empty">
        <svg width="56" height="56" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path
            d="M 48 17 H 16 V 32 H 48 V 47 H 16"
            stroke="var(--border-strong)"
            strokeWidth="9"
            strokeLinecap="square"
            strokeLinejoin="miter"
          />
        </svg>
        <h3>No pipelines yet</h3>
        <p>
          Paste an OpenTelemetry Collector configuration into the editor, use "Load sample" above, or
          start from scratch — the flow of receivers, processors, exporters, connectors and extensions
          will appear here.
        </p>
        {!readOnly && (
          <button className="btn" onClick={onAddPipeline}>+ Add pipeline</button>
        )}
      </div>
    )
  }

  const { lanes, laneWidth, exporterX, pipelineZoneY, extY, totalH, totalW, showExtensions } = layout

  const renderNode = (n: NodePos, signal?: string) => {
    const typeName = componentType(n.id)
    const comp = componentIndex.get(`${n.kind}:${typeName}`)
    const section = n.kind + 's'
    const problem = problems.get(`${section}.${n.id}`)
    const isSel = selected?.kind === n.kind && selected?.id === n.id
    const instance = n.id.includes('/') ? n.id.slice(n.id.indexOf('/') + 1) : null
    // Only flag unknown types once the catalog has actually loaded —
    // otherwise every node flashes red during the initial fetch.
    const unknown = componentIndex.size > 0 && !comp
    const deprecated = comp?.isDeprecated
    const isConnector = n.kind === 'connector'
    const classes = [
      'flow-node',
      isSel ? 'selected' : '',
      problem === 'error' || unknown || (comp && !comp.available) ? 'has-error' : '',
      deprecated ? 'deprecated' : '',
    ].join(' ')
    return (
      <g
        key={`${n.kind}:${n.id}:${n.x}:${n.y}`}
        className={classes}
        style={readOnly ? { cursor: 'default' } : undefined}
        transform={`translate(${n.x},${n.y})`}
        onClick={(e) => {
          e.stopPropagation()
          if (!readOnly) onSelect({ kind: n.kind, id: n.id })
        }}
      >
        <rect className="node-box" width={NODE_W} height={NODE_H} rx={8} />
        <rect
          className={`node-accent ${isConnector ? 'connector' : (signal ?? '')}`}
          width={3}
          height={NODE_H}
          rx={1.5}
        />
        <text className={`node-kind-label${isConnector ? ' connector' : ''}`} x={14} y={15}>
          {n.kind}
        </text>
        <text className="node-title" x={14} y={32}>
          {truncate(typeName, 17)}
          {instance ? <tspan className="node-sub"> /{truncate(instance, 10)}</tspan> : null}
        </text>
        {problem && (
          <g transform={`translate(${NODE_W - 14},12)`}>
            <circle r={7} fill={problem === 'error' ? 'var(--err)' : 'var(--warn)'} />
            <text x={0} y={3.2} textAnchor="middle" fontSize={10} fontWeight={800} fill="var(--surface-2)">
              !
            </text>
          </g>
        )}
      </g>
    )
  }

  const edge = (x1: number, y1: number, x2: number, y2: number, cls = 'edge') => {
    const dx = Math.max(30, (x2 - x1) / 2)
    return <path className={cls} d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`} />
  }

  return (
    <svg
      width={totalW}
      height={totalH}
      viewBox={`0 0 ${totalW} ${totalH}`}
      style={{ display: 'block', minWidth: '100%' }}
      onClick={() => onSelect(null)}
    >
      {lanes.map((lane) => {
        const p = lane.pipeline
        const cy = (n: NodePos) => n.y + NODE_H / 2
        const firstProc = lane.processors[0]
        const lastProc = lane.processors[lane.processors.length - 1]
        return (
          <Fragment key={p.id}>
            <rect className="pipeline-lane" x={MARGIN} y={lane.y} width={laneWidth} height={lane.height} rx={12} />
            <circle className={`lane-dot ${p.signal}`} cx={MARGIN + 20} cy={lane.y + 17} r={4.5} />
            <text className={`lane-title ${p.signal}`} x={MARGIN + 32} y={lane.y + 21}>
              pipeline: {p.id}
            </text>

            {/* edges */}
            {lane.receivers.map((r, ri) =>
              firstProc ? (
                <Fragment key={`r${ri}`}>{edge(MARGIN + r.x + NODE_W, cy(r), MARGIN + firstProc.x, cy(firstProc))}</Fragment>
              ) : (
                lane.exporters.map((e, ei) => (
                  <Fragment key={`r${ri}-e${ei}`}>{edge(MARGIN + r.x + NODE_W, cy(r), MARGIN + e.x, cy(e))}</Fragment>
                ))
              ),
            )}
            {lane.processors.slice(0, -1).map((pr, j) => {
              const next = lane.processors[j + 1]
              return <Fragment key={`p${j}`}>{edge(MARGIN + pr.x + NODE_W, cy(pr), MARGIN + next.x, cy(next))}</Fragment>
            })}
            {lastProc &&
              lane.exporters.map((e) => (
                <Fragment key={`pe-${e.id}`}>{edge(MARGIN + lastProc.x + NODE_W, cy(lastProc), MARGIN + e.x, cy(e))}</Fragment>
              ))}

            {/* nodes (shifted by outer margin) */}
            {[...lane.receivers, ...lane.processors, ...lane.exporters].map((n) =>
              renderNode({ ...n, x: n.x + MARGIN }, p.signal),
            )}

            {/* add zones */}
            {!readOnly && (
              <>
                <AddZone
                  x={MARGIN + LANE_PAD}
                  y={lane.y + LANE_HEADER + lane.receivers.length * (NODE_H + NODE_GAP)}
                  label="+ Receiver"
                  onClick={() => onAdd('receiver', p.id)}
                />
                <AddZone
                  // centered in the processor area, at the lane bottom —
                  // below the node rows so edges never cross it
                  x={MARGIN + LANE_PAD + NODE_W + COL_GAP + (exporterX - (LANE_PAD + NODE_W + COL_GAP) - COL_GAP - NODE_W) / 2}
                  y={lane.y + lane.height - LANE_PAD - ADD_H}
                  label="+ Processor"
                  onClick={() => onAdd('processor', p.id)}
                />
                <AddZone
                  x={MARGIN + exporterX}
                  y={lane.y + LANE_HEADER + lane.exporters.length * (NODE_H + NODE_GAP)}
                  label="+ Exporter"
                  onClick={() => onAdd('exporter', p.id)}
                />
              </>
            )}
          </Fragment>
        )
      })}

      {/* Connector cross-lane edges. Routed orthogonally through the free
          channels — right of the lanes, through the gap between lanes, in
          along the left — so they never cross nodes or other lanes. */}
      {connectorEdges.map((e, i) => {
        const x1 = MARGIN + e.from.x + NODE_W
        const y1 = e.from.y + NODE_H / 2
        const x2 = MARGIN + e.to.x
        const y2 = e.to.y + NODE_H / 2
        const outR = MARGIN + laneWidth + 18 + i * 8 // right-hand vertical channel
        const outL = Math.max(4, MARGIN - 14 - i * 6) // left-hand vertical channel
        const below = e.toLane.y > e.fromLane.y
        // Horizontal run goes through the empty gap adjacent to the target lane.
        const gapY = below
          ? e.toLane.y - LANE_GAP / 2 - i * 4
          : e.toLane.y + e.toLane.height + LANE_GAP / 2 + i * 4
        const pts: [number, number][] = [
          [x1, y1],
          [outR, y1],
          [outR, gapY],
          [outL, gapY],
          [outL, y2],
          [x2, y2],
        ]
        return (
          <g key={`ce${i}`}>
            <path className="edge edge-connector" d={roundedPolyline(pts, 8)}>
              <title>{`${e.id}: ${e.fromLane.pipeline.id} → ${e.toLane.pipeline.id}`}</title>
            </path>
            <path
              className="edge-connector-arrow"
              d={`M ${x2 - 6} ${y2 - 4} L ${x2} ${y2} L ${x2 - 6} ${y2 + 4} Z`}
            />
          </g>
        )
      })}

      {/* pipeline add zone spanning the lane width */}
      {!readOnly && (
        <g
          className="add-zone"
          transform={`translate(${MARGIN},${pipelineZoneY})`}
          onClick={(e) => {
            e.stopPropagation()
            onAddPipeline()
          }}
        >
          <rect width={laneWidth} height={ADD_H} rx={8} />
          <text x={laneWidth / 2} y={ADD_H / 2 + 4} textAnchor="middle">
            + Pipeline
          </text>
        </g>
      )}

      {/* extensions rail */}
      {showExtensions && (
        <text className="section-heading" x={MARGIN} y={extY + 12}>
          Extensions
        </text>
      )}
      {model.sections.extensions.map((id, i) => {
        const enabled = model.serviceExtensions.includes(id)
        return (
          <g key={id} opacity={enabled ? 1 : 0.55}>
            {renderNode({
              id,
              kind: 'extension',
              x: MARGIN + i * (NODE_W + 16),
              y: extY + 22,
            })}
            {!enabled && (
              <text className="node-sub" x={MARGIN + i * (NODE_W + 16) + 14} y={extY + 22 + NODE_H + 12} fill="var(--warn)">
                not enabled
              </text>
            )}
          </g>
        )
      })}
      {!readOnly && (
        <AddZone
          x={MARGIN + model.sections.extensions.length * (NODE_W + 16)}
          y={extY + 22 + (NODE_H - ADD_H) / 2}
          label="+ Extension"
          onClick={() => onAdd('extension')}
        />
      )}
    </svg>
  )
}

function AddZone({ x, y, label, onClick }: { x: number; y: number; label: string; onClick: () => void }) {
  return (
    <g
      className="add-zone"
      transform={`translate(${x},${y})`}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <rect width={NODE_W} height={ADD_H} rx={8} />
      <text x={NODE_W / 2} y={ADD_H / 2 + 4} textAnchor="middle">
        {label}
      </text>
    </g>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** Builds an SVG path along the given points with rounded corners. */
function roundedPolyline(pts: [number, number][], r: number): string {
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]
    const [cx, cy] = pts[i]
    const [nx, ny] = pts[i + 1]
    const len1 = Math.hypot(cx - px, cy - py)
    const len2 = Math.hypot(nx - cx, ny - cy)
    if (len1 === 0 || len2 === 0) continue
    const rr = Math.min(r, len1 / 2, len2 / 2)
    const sx = cx - ((cx - px) / len1) * rr
    const sy = cy - ((cy - py) / len1) * rr
    const ex = cx + ((nx - cx) / len2) * rr
    const ey = cy + ((ny - cy) / len2) * rr
    d += ` L ${sx} ${sy} Q ${cx} ${cy}, ${ex} ${ey}`
  }
  const [lx, ly] = pts[pts.length - 1]
  d += ` L ${lx} ${ly}`
  return d
}
