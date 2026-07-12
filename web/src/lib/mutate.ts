import { parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import type { Kind, SectionName } from '../types'
import { KIND_TO_SECTION } from '../types'

/**
 * Comment-preserving surgical edits to the YAML config, built on the yaml
 * Document API. Each function takes the current text and returns new text.
 *
 * The yaml package's node generics are stricter than useful here, so node
 * plumbing goes through a loosely-typed document handle.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = any

// Canonical top-level section order for generated configs.
const TOP_LEVEL_ORDER = ['receivers', 'processors', 'exporters', 'extensions', 'connectors', 'service']

// Serialize with bare nulls: `docker_stats:` instead of `docker_stats: null`.
const TO_STRING = { nullStr: '' }

function ensureMap(doc: Doc, path: string[]): YAMLMap {
  if (!(doc.contents instanceof YAMLMap)) {
    doc.contents = doc.createNode({})
  }
  let current: YAMLMap = doc.contents
  for (let i = 0; i < path.length; i++) {
    const key = path[i]
    let next: unknown = current.get(key, true)
    if (!(next instanceof YAMLMap)) {
      next = doc.createNode({})
      if (i === 0 && TOP_LEVEL_ORDER.includes(key)) {
        insertTopLevelOrdered(doc, current, key, next)
      } else {
        current.set(doc.createNode(key), next)
      }
    }
    // Structural containers (sections, service, pipelines) render as block
    // maps — an empty `{}` re-parses as flow style and would otherwise
    // collapse everything added later onto one line.
    ;(next as YAMLMap).flow = false
    current = next as YAMLMap
  }
  return current
}

// Inserts a new top-level section before the first known section that
// should come after it, so generated configs read in the conventional
// order regardless of the order the user clicked things together.
function insertTopLevelOrdered(doc: Doc, root: YAMLMap, key: string, value: unknown) {
  const rank = TOP_LEVEL_ORDER.indexOf(key)
  let index = root.items.length
  for (let j = 0; j < root.items.length; j++) {
    const existing = String((root.items[j].key as any)?.value ?? '')
    const r = TOP_LEVEL_ORDER.indexOf(existing)
    if (r !== -1 && r > rank) {
      index = j
      break
    }
  }
  root.items.splice(index, 0, doc.createPair(key, value))
}

function configNode(doc: Doc, config: unknown) {
  const empty =
    config === undefined ||
    config === null ||
    (typeof config === 'object' && !Array.isArray(config) && Object.keys(config as object).length === 0)
  return empty ? doc.createNode(null) : doc.createNode(config)
}

/** Adds a component definition and (optionally) references it from pipelines. */
export function addComponent(
  yamlText: string,
  kind: Kind,
  id: string,
  config: unknown,
  opts: {
    pipelines?: string[] // pipeline IDs to attach to (receivers/exporters by kind; exporter side for connectors)
    recvPipelines?: string[] // for connectors: pipelines that consume its output (receiver side)
    enableExtension?: boolean
  } = {},
): string {
  const doc: Doc = parseDocument(yamlText)
  const section = KIND_TO_SECTION[kind]
  const sectionMap = ensureMap(doc, [section])
  sectionMap.set(doc.createNode(id), configNode(doc, config))

  if (kind === 'extension') {
    if (opts.enableExtension !== false) appendToSeq(doc, ['service', 'extensions'], id)
  } else if (kind === 'receiver' || kind === 'exporter' || kind === 'processor') {
    const role = kind === 'receiver' ? 'receivers' : kind === 'exporter' ? 'exporters' : 'processors'
    for (const p of opts.pipelines ?? []) {
      appendToSeq(doc, ['service', 'pipelines', p, role], id)
    }
  } else if (kind === 'connector') {
    for (const p of opts.pipelines ?? []) {
      appendToSeq(doc, ['service', 'pipelines', p, 'exporters'], id)
    }
    for (const p of opts.recvPipelines ?? []) {
      appendToSeq(doc, ['service', 'pipelines', p, 'receivers'], id)
    }
  }
  return doc.toString(TO_STRING)
}

function appendToSeq(doc: Doc, path: string[], value: string) {
  const parent = ensureMap(doc, path.slice(0, -1))
  const key = path[path.length - 1]
  let seq: unknown = parent.get(key, true)
  if (!(seq instanceof YAMLSeq)) {
    seq = doc.createNode([])
    ;(seq as YAMLSeq).flow = true
    parent.set(doc.createNode(key), seq)
  }
  const s = seq as YAMLSeq
  const exists = s.items.some((it: any) => it?.value === value)
  if (!exists) s.add(doc.createNode(value))
}

/** Adds a pipeline to service.pipelines referencing already-defined components. */
export function addPipeline(
  yamlText: string,
  id: string,
  lists: { receivers: string[]; processors: string[]; exporters: string[] },
): string {
  const doc: Doc = parseDocument(yamlText)
  ensureMap(doc, ['service', 'pipelines', id])
  for (const r of lists.receivers) appendToSeq(doc, ['service', 'pipelines', id, 'receivers'], r)
  for (const p of lists.processors) appendToSeq(doc, ['service', 'pipelines', id, 'processors'], p)
  for (const e of lists.exporters) appendToSeq(doc, ['service', 'pipelines', id, 'exporters'], e)
  return doc.toString(TO_STRING)
}

/** Replaces the config block of an existing component. */
export function setComponentConfig(yamlText: string, section: SectionName, id: string, config: unknown): string {
  const doc: Doc = parseDocument(yamlText)
  const sectionMap = ensureMap(doc, [section])
  sectionMap.set(doc.createNode(id), configNode(doc, config))
  return doc.toString(TO_STRING)
}

/** Reads the current config object of a component (or undefined). */
export function getComponentConfig(yamlText: string, section: SectionName, id: string): unknown {
  try {
    const doc: Doc = parseDocument(yamlText)
    const node = doc.getIn([section, id], true)
    return node?.toJSON?.() ?? undefined
  } catch {
    return undefined
  }
}

/** Removes a component definition and all references to it. */
export function removeComponent(yamlText: string, section: SectionName, id: string): string {
  const doc: Doc = parseDocument(yamlText)
  doc.deleteIn([section, id])
  // Drop from service.extensions
  const ext = doc.getIn(['service', 'extensions'], true)
  if (ext instanceof YAMLSeq) {
    ext.items = ext.items.filter((it: any) => it?.value !== id)
  }
  // Drop from every pipeline list
  const pipelines = doc.getIn(['service', 'pipelines'], true)
  if (pipelines instanceof YAMLMap) {
    for (const pair of pipelines.items) {
      const pl = pair.value
      if (!(pl instanceof YAMLMap)) continue
      for (const role of ['receivers', 'processors', 'exporters']) {
        const seq = pl.get(role, true)
        if (seq instanceof YAMLSeq) {
          seq.items = seq.items.filter((it: any) => it?.value !== id)
        }
      }
    }
  }
  return doc.toString(TO_STRING)
}
