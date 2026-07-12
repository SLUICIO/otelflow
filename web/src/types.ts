export type Kind = 'receiver' | 'processor' | 'exporter' | 'extension' | 'connector'
export type Signal = 'traces' | 'metrics' | 'logs'

export interface SchemaNode {
  type?: 'object' | 'map' | 'array' | 'string' | 'int' | 'number' | 'bool' | 'duration'
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  values?: SchemaNode
  enum?: string[]
  required?: string[]
  default?: unknown
  description?: string
  examples?: unknown[]
  secret?: boolean
  additionalProperties?: boolean
}

export interface Connection {
  from: Signal
  to: Signal
}

export interface Component {
  type: string
  kind: Kind
  signals?: Signal[]
  connects?: Connection[]
  added: string
  deprecated?: string
  removed?: string
  stability: string
  distributions?: string[]
  docsUrl?: string
  description: string
  schema?: SchemaNode
  available: boolean
  isDeprecated: boolean
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info'
  message: string
  path?: string
  line?: number
  column?: number
  hint?: string
}

export interface ValidationResult {
  valid: boolean
  diagnostics: Diagnostic[]
}

export interface Meta {
  versions: string[]
  defaultVersion: string
  distributions: string[]
}

/** Parsed view of the config used to draw the flow graph. */
export interface ConfigModel {
  sections: Record<SectionName, string[]>
  pipelines: PipelineModel[]
  serviceExtensions: string[]
  parseError?: string
}

export type SectionName = 'receivers' | 'processors' | 'exporters' | 'extensions' | 'connectors'

export interface PipelineModel {
  id: string
  signal: Signal | 'unknown'
  receivers: string[]
  processors: string[]
  exporters: string[]
}

export const KIND_TO_SECTION: Record<Kind, SectionName> = {
  receiver: 'receivers',
  processor: 'processors',
  exporter: 'exporters',
  extension: 'extensions',
  connector: 'connectors',
}

export const SECTION_TO_KIND: Record<SectionName, Kind> = {
  receivers: 'receiver',
  processors: 'processor',
  exporters: 'exporter',
  extensions: 'extension',
  connectors: 'connector',
}

export function componentType(id: string): string {
  const i = id.indexOf('/')
  return i >= 0 ? id.slice(0, i) : id
}
