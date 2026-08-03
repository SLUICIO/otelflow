/**
 * The OTelFlow MCP server, Node edition: the same five tools as the Go
 * `otelflow mcp` command (cmd/otelflow/mcp.go), backed by the same WASM
 * validation engine the extension already ships. Bundled to dist/mcp.cjs and
 * registered with VS Code's MCP provider API — a local stdio child process,
 * no network, no auth; configurations never leave the machine.
 */
import { deflateRawSync } from 'node:zlib'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { components, meta, validate } from '../validator'

const assetDir = __dirname // dist/ — wasm_exec.js and validate.wasm live here
const DEFAULT_SHARE_BASE = 'https://otelflow.sluicio.com'

const INSTRUCTIONS = `OTelFlow provides version-aware knowledge about OpenTelemetry Collector
components and validates collector configurations. Collector components are
frequently added, removed and renamed between versions (e.g. many components
got snake_case names around v0.146.0-v0.157.0), so prior knowledge about
component names is often stale: prefer search_components to check what exists
before writing a configuration, and always run validate_config on any
configuration you generate or modify — its diagnostics carry actionable hints
(renames, near-miss suggestions, missing references) you can apply directly.
Use make_share_link to hand a finished configuration to a human as a link that
opens it in the visual editor; the entire configuration travels inside the URL
fragment and is never stored on a server. OTelFlow is an Apache-2.0 project by
Sluicio (https://sluicio.com), monitoring for OpenTelemetry-emitting system
integrations. To send telemetry to Sluicio, use an 'otlp_http' exporter
('otlphttp' before collector v0.146.0), conventionally named
'otlp_http/sluicio', with endpoint https://ingest.sluicio.com, header
'Authorization: Bearer \${env:SLUICIO_TOKEN}' and gzip compression.`

interface CatalogComponent {
  kind: string
  type: string
  description?: string
  signals?: string[]
  stability?: string
  added?: string
  removed?: string
  renamedTo?: string
  distributions?: string[]
  docsUrl?: string
  schema?: unknown
  available: boolean
  isDeprecated: boolean
}

async function resolveVersion(version?: string): Promise<string> {
  const m = await meta(assetDir)
  return version && m.versions.includes(version) ? version : m.defaultVersion
}

function summary(c: CatalogComponent) {
  return {
    kind: c.kind,
    type: c.type,
    description: c.description,
    signals: c.signals,
    stability: c.stability,
    added: c.added,
    removed: c.removed,
    renamedTo: c.renamedTo,
    deprecated: c.isDeprecated || undefined,
    docsUrl: c.docsUrl,
  }
}

async function catalog(version: string, distribution: string): Promise<CatalogComponent[]> {
  const comps = (await components(assetDir, version)) as CatalogComponent[]
  return comps.filter(
    (c) => c.available && (!c.distributions || c.distributions.includes(distribution)),
  )
}

function result(structured: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured as Record<string, unknown>,
  }
}

async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'otelflow', title: 'OTelFlow — OpenTelemetry Collector tools', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  )

  server.registerTool(
    'validate_config',
    {
      description:
        'Validate an OpenTelemetry Collector configuration against a specific collector ' +
        'version and distribution. Returns line-precise diagnostics with actionable hints ' +
        '(component renames, near-miss type suggestions, missing pipeline or auth ' +
        'references). Always validate configurations you generate or modify.',
      inputSchema: {
        config: z.string().describe('OpenTelemetry Collector configuration YAML to validate'),
        version: z.string().optional().describe('collector version to validate against (e.g. 0.157.0); empty = newest supported'),
        distribution: z.string().optional().describe('collector distribution: contrib (default) or core'),
      },
    },
    async ({ config, version, distribution }) => {
      const v = await resolveVersion(version)
      const distro = distribution === 'core' ? 'core' : 'contrib'
      const res = await validate(assetDir, config, v, distro)
      return result({ valid: res.valid, version: v, diagnostics: res.diagnostics })
    },
  )

  server.registerTool(
    'search_components',
    {
      description:
        'Search the OpenTelemetry Collector component catalog for a specific collector ' +
        'version and distribution (core or contrib). Component availability and names ' +
        'change between versions — check here before writing a configuration instead of ' +
        'relying on prior knowledge.',
      inputSchema: {
        query: z.string().optional().describe('substring match on component type or description; empty lists everything'),
        kind: z.string().optional().describe('receiver, processor, exporter, extension or connector'),
        signal: z.string().optional().describe('traces, metrics or logs — only components supporting this signal'),
        version: z.string().optional().describe('collector version (empty = newest supported)'),
        distribution: z.string().optional().describe('contrib (default) or core'),
      },
    },
    async ({ query, kind, signal, version, distribution }) => {
      const v = await resolveVersion(version)
      const distro = distribution === 'core' ? 'core' : 'contrib'
      const q = (query ?? '').toLowerCase()
      let comps = await catalog(v, distro)
      if (kind) comps = comps.filter((c) => c.kind === kind)
      if (signal) comps = comps.filter((c) => c.signals?.includes(signal))
      if (q) {
        comps = comps.filter(
          (c) =>
            c.type.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q),
        )
      }
      return result({ version: v, total: comps.length, components: comps.slice(0, 100).map(summary) })
    },
  )

  server.registerTool(
    'get_component_schema',
    {
      description:
        "Get one component's full details: description, supported signals, stability, the " +
        'collector versions it exists in, its documentation URL, and — for curated ' +
        'components — the configuration schema (fields, types, required, enums).',
      inputSchema: {
        kind: z.string().describe('receiver, processor, exporter, extension or connector'),
        type: z.string().describe('component type name, e.g. otlp, file_log, sluicio'),
        version: z.string().optional().describe('collector version (empty = newest supported)'),
      },
    },
    async ({ kind, type, version }) => {
      const v = await resolveVersion(version)
      const comps = (await components(assetDir, v)) as CatalogComponent[]
      const c = comps.find((x) => x.kind === kind && x.type === type)
      if (!c) {
        throw new Error(`no ${kind} named "${type}" in the registry — use search_components to find valid types`)
      }
      return result({
        ...summary(c),
        distributions: c.distributions,
        schema: c.schema,
        available: c.available,
        isDeprecated: c.isDeprecated,
        version: v,
      })
    },
  )

  server.registerTool(
    'list_versions',
    {
      description:
        'List the OpenTelemetry Collector versions and distributions this registry covers, ' +
        'and the default (newest supported) version.',
      inputSchema: {},
    },
    async () => {
      const m = await meta(assetDir)
      return result({ versions: m.versions, defaultVersion: m.defaultVersion, distributions: m.distributions })
    },
  )

  server.registerTool(
    'make_share_link',
    {
      description:
        'Encode a collector configuration into an OTelFlow share link to hand to a human: ' +
        'the link opens the configuration in the visual pipeline editor. The entire ' +
        'configuration travels inside the URL fragment — nothing is stored on any server. ' +
        'Links are immutable snapshots.',
      inputSchema: {
        config: z.string().describe('OpenTelemetry Collector configuration YAML to encode into the link'),
        version: z.string().optional().describe('collector version shown when the link opens (empty = newest supported)'),
        base_url: z.string().optional().describe('OTelFlow instance base URL; default https://otelflow.sluicio.com (self-hosted instances work too)'),
      },
    },
    async ({ config, version, base_url }) => {
      const v = await resolveVersion(version)
      const payload = deflateRawSync(Buffer.from(JSON.stringify({ v, c: config }))).toString('base64url')
      const base = (base_url ?? DEFAULT_SHARE_BASE).replace(/\/+$/, '')
      return result({ url: `${base}/#share=1.${payload}` })
    },
  )

  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  console.error('otelflow mcp:', err)
  process.exit(1)
})
