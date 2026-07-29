// Build the standalone copy of index.html that gets pinned as a Flow artifact.
//
// The artifact is a single file with no server behind it, so two things are
// injected ahead of the app script:
//
//   __API__   the public tunnel origin, so the live board is fetched and the
//             write buttons work from inside the side panel
//   __SEED__  a snapshot taken at publish time, rendered read-only if the
//             tunnel is down — better than an empty panel and an error
//
//   node publish.mjs https://<tunnel-host> > /tmp/board-artifact.html
//
// Run it again after any change to index.html: the artifact carries its own
// copy of the UI, so edits are invisible until it is republished.
import { readFile } from 'node:fs/promises'

const origin = process.argv[2]?.replace(/\/$/, '')
if (!origin) {
  console.error('usage: node publish.mjs https://<tunnel-host>')
  process.exit(2)
}

const res = await fetch(origin + '/api/board')
if (!res.ok) throw new Error(`GET ${origin}/api/board → ${res.status}`)
const seed = await res.json()
if (!seed.items?.length) throw new Error('board came back with no items; refusing to bake an empty seed')

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')

// </script> inside the JSON would close the tag early; < keeps it inert.
const json = JSON.stringify(seed).replace(/</g, '\\u003c')
const inject = `<script>
window.__API__ = ${JSON.stringify(origin)}
window.__SEED__ = ${json}
</script>
`

const out = html.replace('<script>\n// Same-origin', inject + '<script>\n// Same-origin')
if (out === html) throw new Error('injection point not found — did the app script header change?')

process.stdout.write(out)
console.error(`baked ${seed.items.length} items from ${origin}`)
