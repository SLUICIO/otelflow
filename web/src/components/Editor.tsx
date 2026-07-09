import { useEffect, useMemo, useRef } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { yaml } from '@codemirror/lang-yaml'
import { linter, type Diagnostic as CmDiagnostic } from '@codemirror/lint'
import { EditorView } from '@codemirror/view'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import type { Diagnostic } from '../types'

interface Props {
  value: string
  onChange: (v: string) => void
  diagnostics: Diagnostic[]
  jumpToLine: number | null
  onJumped: () => void
  dark: boolean
}

/** Editor chrome from the Sluicio tokens; works in both theme modes. */
function chromeTheme(dark: boolean) {
  return EditorView.theme(
    {
      '&': { backgroundColor: 'var(--surface-2)', color: 'var(--ink)' },
      '.cm-gutters': {
        backgroundColor: 'var(--surface-2)',
        color: 'var(--muted)',
        borderRight: '1px solid var(--border)',
      },
      '.cm-activeLine': { backgroundColor: 'var(--surface-3)' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--surface-3)', color: 'var(--primary)' },
      // Selection needs real contrast against the editor surface — the
      // soft tint is invisible in dark mode. --focus is 35%-alpha azure,
      // strong enough to see while keeping the text readable.
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'var(--focus) !important',
      },
      '.cm-content ::selection': { backgroundColor: 'var(--focus)' },
      '.cm-cursor': { borderLeftColor: 'var(--primary)' },
      '.cm-lintRange-error': { textDecoration: 'underline wavy var(--err)' },
      '.cm-lintRange-warning': { textDecoration: 'underline wavy var(--warn)' },
    },
    { dark },
  )
}

/** Read-only, syntax-highlighted configuration view for embeds. */
export function ConfigViewer({ value, dark }: { value: string; dark: boolean }) {
  const extensions = useMemo(
    () => [yaml(), chromeTheme(dark), syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle)],
    [dark],
  )
  return (
    <CodeMirror
      value={value}
      editable={false}
      theme="none"
      extensions={extensions}
      height="100%"
      style={{ height: '100%' }}
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
    />
  )
}

export function Editor({ value, onChange, diagnostics, jumpToLine, onJumped, dark }: Props) {
  const ref = useRef<ReactCodeMirrorRef>(null)
  const diagRef = useRef(diagnostics)
  diagRef.current = diagnostics

  // Re-run the linter when new backend diagnostics arrive.
  const lintExt = useMemo(
    () =>
      linter(
        (view) => {
          const doc = view.state.doc
          const out: CmDiagnostic[] = []
          for (const d of diagRef.current) {
            if (!d.line || d.line < 1 || d.line > doc.lines) continue
            const line = doc.line(d.line)
            const from = Math.min(line.from + Math.max(0, (d.column ?? 1) - 1), line.to)
            out.push({
              from,
              to: line.to,
              severity: d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info',
              message: d.message + (d.hint ? `\n${d.hint}` : ''),
            })
          }
          return out
        },
        { delay: 120 },
      ),
    [],
  )

  const extensions = useMemo(
    () => [
      yaml(),
      lintExt,
      chromeTheme(dark),
      syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle),
    ],
    [lintExt, dark],
  )

  // Nudge the linter whenever diagnostics change.
  useEffect(() => {
    const view = ref.current?.view
    if (view) view.dispatch({}) // triggers lint refresh via transaction
  }, [diagnostics])

  useEffect(() => {
    const view = ref.current?.view
    if (view && jumpToLine && jumpToLine >= 1 && jumpToLine <= view.state.doc.lines) {
      const pos = view.state.doc.line(jumpToLine).from
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      })
      view.focus()
      onJumped()
    }
  }, [jumpToLine, onJumped])

  return (
    <div className="editor-wrap">
      <CodeMirror
        ref={ref}
        value={value}
        onChange={onChange}
        theme="none"
        extensions={extensions}
        height="100%"
        style={{ height: '100%' }}
        basicSetup={{ foldGutter: true, highlightActiveLine: true, bracketMatching: true }}
        placeholder="# Paste your OpenTelemetry Collector configuration here…"
      />
    </div>
  )
}
