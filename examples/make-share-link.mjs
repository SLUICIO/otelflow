#!/usr/bin/env node
// Generates an OTelFlow share link from a collector configuration file.
//
//   node make-share-link.mjs <config.yaml> [collector-version] [base-url]
//
// The whole configuration travels inside the URL fragment — OTelFlow stores
// nothing on any server. Replace #share= with #embed= for a read-only
// pipeline canvas to put in an <iframe>.

import { readFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

const [file = 'otelcol.yaml', version = '0.127.0', baseUrl = 'https://otelflow.sluicio.com/'] =
  process.argv.slice(2)

const yaml = readFileSync(file, 'utf8')
const payload = deflateRawSync(Buffer.from(JSON.stringify({ v: version, c: yaml }))).toString(
  'base64url',
)

console.log(`${baseUrl}#share=1.${payload}`)
