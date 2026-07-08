import { parse } from 'yaml'
import type { ConfigModel, PipelineModel, SectionName, Signal } from '../types'
import { componentType } from '../types'

const SECTIONS: SectionName[] = ['receivers', 'processors', 'exporters', 'extensions', 'connectors']

const EMPTY: ConfigModel = {
  sections: { receivers: [], processors: [], exporters: [], extensions: [], connectors: [] },
  pipelines: [],
  serviceExtensions: [],
}

/**
 * Tolerantly parses a collector config into the model used by the flow
 * graph. Malformed parts are skipped rather than failing the whole parse —
 * the authoritative diagnostics come from the backend.
 */
export function parseConfigModel(yamlText: string): ConfigModel {
  let doc: unknown
  try {
    doc = parse(yamlText, { strict: false, uniqueKeys: false })
  } catch (e) {
    return { ...EMPTY, parseError: e instanceof Error ? e.message : String(e) }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return EMPTY

  const root = doc as Record<string, unknown>
  const sections = { receivers: [], processors: [], exporters: [], extensions: [], connectors: [] } as ConfigModel['sections']
  for (const s of SECTIONS) {
    const sec = root[s]
    if (sec && typeof sec === 'object' && !Array.isArray(sec)) {
      sections[s] = Object.keys(sec as object)
    }
  }

  const pipelines: PipelineModel[] = []
  let serviceExtensions: string[] = []
  const service = root['service']
  if (service && typeof service === 'object' && !Array.isArray(service)) {
    const svc = service as Record<string, unknown>
    if (Array.isArray(svc['extensions'])) {
      serviceExtensions = svc['extensions'].filter((x): x is string => typeof x === 'string')
    }
    const pls = svc['pipelines']
    if (pls && typeof pls === 'object' && !Array.isArray(pls)) {
      for (const [id, raw] of Object.entries(pls as Record<string, unknown>)) {
        const signal = componentType(id)
        const p: PipelineModel = {
          id,
          signal: (['traces', 'metrics', 'logs'] as const).includes(signal as Signal)
            ? (signal as Signal)
            : 'unknown',
          receivers: [],
          processors: [],
          exporters: [],
        }
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const o = raw as Record<string, unknown>
          for (const role of ['receivers', 'processors', 'exporters'] as const) {
            if (Array.isArray(o[role])) {
              p[role] = (o[role] as unknown[]).filter((x): x is string => typeof x === 'string')
            }
          }
        }
        pipelines.push(p)
      }
    }
  }
  return { sections, pipelines, serviceExtensions }
}
