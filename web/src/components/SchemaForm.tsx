import { useState } from 'react'
import { parse, stringify } from 'yaml'
import type { SchemaNode } from '../types'

/**
 * Renders an editable form from a (simplified JSON-Schema style) component
 * schema. Scalar fields get typed inputs; deeply free-form parts fall back
 * to an inline YAML editor so nothing is un-editable.
 */

type Obj = Record<string, unknown>

interface Props {
  schema: SchemaNode
  value: Obj
  onChange: (v: Obj) => void
}

export function SchemaForm({ schema, value, onChange }: Props) {
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return <YamlField label="Configuration" value={value} onChange={(v) => onChange((v as Obj) ?? {})} />
  }
  return (
    <div className="schema-form">
      {Object.entries(schema.properties).map(([name, sub]) => (
        <Field
          key={name}
          name={name}
          schema={sub}
          required={schema.required?.includes(name) ?? false}
          value={value?.[name]}
          onChange={(v) => {
            const next = { ...value }
            if (v === undefined) delete next[name]
            else next[name] = v
            onChange(next)
          }}
        />
      ))}
    </div>
  )
}

function Field({
  name,
  schema,
  required,
  value,
  onChange,
}: {
  name: string
  schema: SchemaNode
  required: boolean
  value: unknown
  onChange: (v: unknown) => void
}) {
  const label = (
    <label className="form-label">
      <span className="mono">{name}</span>
      {required && <span className="req" title="required">*</span>}
      {schema.default !== undefined && (
        <span className="muted small">default: {JSON.stringify(schema.default)}</span>
      )}
    </label>
  )
  const desc = schema.description ? <div className="form-desc">{schema.description}</div> : null

  switch (schema.type) {
    case 'bool':
      return (
        <div className="form-field">
          <div className="checkbox-row">
            <input
              type="checkbox"
              checked={value === true}
              onChange={(e) => onChange(e.target.checked ? true : undefined)}
            />
            <span className="mono">{name}</span>
          </div>
          {desc}
        </div>
      )
    case 'int':
    case 'number':
      return (
        <div className="form-field">
          {label}
          <input
            className="num-input"
            type="number"
            step={schema.type === 'int' ? 1 : 'any'}
            value={typeof value === 'number' ? value : ''}
            placeholder={schema.default !== undefined ? String(schema.default) : ''}
            onChange={(e) => {
              const raw = e.target.value
              onChange(raw === '' ? undefined : schema.type === 'int' ? parseInt(raw, 10) : parseFloat(raw))
            }}
          />
          {desc}
        </div>
      )
    case 'duration':
      return (
        <div className="form-field">
          {label}
          <input
            className="text-input mono"
            type="text"
            value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
            placeholder={schema.default !== undefined ? String(schema.default) : 'e.g. 10s, 200ms, 1m'}
            onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          />
          {desc}
        </div>
      )
    case 'string':
      if (schema.enum) {
        return (
          <div className="form-field">
            {label}
            <select
              className="select-input mono"
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
            >
              <option value="">{schema.default !== undefined ? `(default: ${schema.default})` : '(unset)'}</option>
              {schema.enum.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            {desc}
          </div>
        )
      }
      return (
        <div className="form-field">
          {label}
          <input
            className="text-input mono"
            type={schema.secret ? 'password' : 'text'}
            value={typeof value === 'string' ? value : ''}
            placeholder={firstExample(schema)}
            onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          />
          {desc}
        </div>
      )
    case 'array': {
      if (schema.items?.type === 'string' || schema.items?.type === 'duration') {
        const lines = Array.isArray(value) ? (value as unknown[]).map(String).join('\n') : ''
        return (
          <div className="form-field">
            {label}
            <textarea
              className="yaml-textarea"
              rows={3}
              value={lines}
              placeholder={firstExample(schema) || 'one entry per line'}
              onChange={(e) => {
                const items = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)
                onChange(items.length ? items : undefined)
              }}
            />
            {desc}
          </div>
        )
      }
      return <YamlField label={name} description={schema.description} value={value} onChange={onChange} />
    }
    case 'map':
      return <YamlField label={name} description={schema.description ?? 'key: value pairs'} value={value} onChange={onChange} />
    case 'object': {
      if (schema.properties && Object.keys(schema.properties).length > 0) {
        const obj = (value ?? {}) as Obj
        const isSet = value !== undefined
        return (
          <fieldset className="form-fieldset">
            <legend>
              {name}
              {required && <span className="req"> *</span>}
            </legend>
            {desc}
            {!isSet && (
              <button type="button" className="btn" onClick={() => onChange({})}>
                Configure {name}
              </button>
            )}
            {isSet && (
              <>
                <SchemaForm
                  schema={schema}
                  value={obj}
                  onChange={(v) => onChange(Object.keys(v).length ? v : {})}
                />
                <button type="button" className="btn btn--link" onClick={() => onChange(undefined)}>
                  Remove {name}
                </button>
              </>
            )}
          </fieldset>
        )
      }
      return <YamlField label={name} description={schema.description} value={value} onChange={onChange} />
    }
    default:
      return <YamlField label={name} description={schema.description} value={value} onChange={onChange} />
  }
}

/** Fallback editor for free-form parts of the config. */
function YamlField({
  label,
  description,
  value,
  onChange,
}: {
  label: string
  description?: string
  value: unknown
  onChange: (v: unknown) => void
}) {
  const [text, setText] = useState(() =>
    value === undefined || value === null ? '' : stringify(value).trimEnd(),
  )
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="form-field">
      <label className="form-label">
        <span className="mono">{label}</span>
        <span className="muted small">YAML</span>
      </label>
      <textarea
        className="yaml-textarea"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          const t = e.target.value
          setText(t)
          if (t.trim() === '') {
            setErr(null)
            onChange(undefined)
            return
          }
          try {
            onChange(parse(t))
            setErr(null)
          } catch (ex) {
            setErr(ex instanceof Error ? ex.message.split('\n')[0] : 'invalid YAML')
          }
        }}
      />
      {err ? <div className="form-desc" style={{ color: 'var(--err)' }}>{err}</div> : null}
      {description ? <div className="form-desc">{description}</div> : null}
    </div>
  )
}

function firstExample(schema: SchemaNode): string {
  const ex = schema.examples?.[0]
  return ex === undefined ? '' : String(ex)
}
