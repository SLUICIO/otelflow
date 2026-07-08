import type { Component, Meta, ValidationResult } from './types'

export async function fetchMeta(): Promise<Meta> {
  const res = await fetch('/api/meta')
  if (!res.ok) throw new Error(`meta: ${res.status}`)
  return res.json()
}

export async function fetchComponents(version: string): Promise<Component[]> {
  const res = await fetch(`/api/components?version=${encodeURIComponent(version)}`)
  if (!res.ok) throw new Error(`components: ${res.status}`)
  const body = await res.json()
  return body.components
}

export async function validateConfig(config: string, version: string): Promise<ValidationResult> {
  const res = await fetch('/api/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, version }),
  })
  if (!res.ok) throw new Error(`validate: ${res.status}`)
  return res.json()
}
