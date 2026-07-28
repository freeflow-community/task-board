// Task board — a small frontend over a GitHub Project.
//
// Zero dependencies. GitHub access comes from the `gh` CLI already logged in on
// this machine, so no token is ever read, copied or stored by this process.
//
//   node server.mjs           → http://localhost:8787
//   PORT=9000 node server.mjs
//
// Config via env: BOARD_OWNER (org login), BOARD_NUMBER (project number).

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT ?? 8787)
const OWNER = process.env.BOARD_OWNER ?? 'freeflow-community'
const NUMBER = Number(process.env.BOARD_NUMBER ?? 1)

const gh = (args) => exec('gh', args, { maxBuffer: 10 * 1024 * 1024 }).then((r) => JSON.parse(r.stdout))

const QUERY = `
query($owner:String!, $number:Int!) {
  organization(login:$owner) {
    projectV2(number:$number) {
      id title url
      items(first:100) {
        nodes {
          id
          fieldValueByName(name:"Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
          }
          content {
            ... on Issue {
              number title url body createdAt state
              repository { nameWithOwner }
              labels(first:10) { nodes { name color } }
              assignees(first:5) { nodes { login } }
            }
          }
        }
      }
    }
  }
}`

// The board changes on human timescales; don't re-hit the API on every reload.
let cache = { at: 0, data: null }
const TTL_MS = 20_000

async function fetchBoard() {
  const res = await gh(['api', 'graphql', '-F', `owner=${OWNER}`, '-F', `number=${NUMBER}`, '-f', `query=${QUERY}`])
  const project = res.data?.organization?.projectV2
  if (!project) throw new Error(`no project #${NUMBER} under ${OWNER}`)

  const items = project.items.nodes
    // Draft items and PRs have no `number`; this first cut only renders issues.
    .filter((n) => n.content?.number)
    .map((n) => ({
      id: n.id, // project item id — what the reorder mutation takes
      number: n.content.number,
      title: n.content.title,
      url: n.content.url,
      body: n.content.body ?? '',
      state: n.content.state,
      status: n.fieldValueByName?.name ?? null,
      statusAt: n.fieldValueByName?.updatedAt ?? null, // when Status last changed
      repo: n.content.repository.nameWithOwner,
      createdAt: n.content.createdAt,
      labels: n.content.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
      assignees: n.content.assignees.nodes.map((a) => a.login),
    }))

  return {
    projectId: project.id,
    title: project.title,
    url: project.url,
    items,
    fetchedAt: new Date().toISOString(),
  }
}

async function board({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < TTL_MS) return cache.data
  const data = await fetchBoard()
  cache = { at: Date.now(), data }
  return data
}

// Status moves independently of the board (an agent picks a task up, finishes
// it), so the UI polls for it. This query deliberately fetches nothing but id
// and status — no bodies, labels or assignees — because it runs every few
// seconds per open tab.
const STATUS_QUERY = `
query($owner:String!, $number:Int!) {
  organization(login:$owner) {
    projectV2(number:$number) {
      items(first:100) {
        nodes {
          id
          fieldValueByName(name:"Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
          }
        }
      }
    }
  }
}`

let statusCache = { at: 0, data: null }
const STATUS_TTL_MS = 3_000 // collapses several open tabs into one API call

async function statuses() {
  if (statusCache.data && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.data
  const res = await gh(['api', 'graphql', '-F', `owner=${OWNER}`, '-F', `number=${NUMBER}`, '-f', `query=${STATUS_QUERY}`])
  const nodes = res.data?.organization?.projectV2?.items?.nodes ?? []
  const data = Object.fromEntries(nodes.map((n) => [n.id,
    { status: n.fieldValueByName?.name ?? null, at: n.fieldValueByName?.updatedAt ?? null }]))
  statusCache = { at: Date.now(), data }
  return data
}

// Setting Status needs the field id and the option id for the target name.
// Both are stable for the life of the project, so look them up once.
let fieldCache = null
async function statusField() {
  if (fieldCache) return fieldCache
  const q = `query($owner:String!, $number:Int!) {
    organization(login:$owner) { projectV2(number:$number) {
      field(name:"Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`
  const res = await gh(['api', 'graphql', '-F', `owner=${OWNER}`, '-F', `number=${NUMBER}`, '-f', `query=${q}`])
  const f = res.data?.organization?.projectV2?.field
  if (!f) throw new Error('this project has no Status field')
  fieldCache = { id: f.id, options: Object.fromEntries(f.options.map((o) => [o.name, o.id])) }
  return fieldCache
}

async function setStatus(itemId, name) {
  const { projectId } = await board()
  const field = await statusField()
  const optionId = field.options[name]
  if (!optionId) throw new Error(`unknown status "${name}" — have: ${Object.keys(field.options).join(', ')}`)

  const m = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{
    projectId:$p, itemId:$i, fieldId:$f, value:{singleSelectOptionId:$o}}){clientMutationId}}`
  const res = await gh(['api', 'graphql', '-f', `p=${projectId}`, '-f', `i=${itemId}`,
    '-f', `f=${field.id}`, '-f', `o=${optionId}`, '-f', `query=${m}`])
  if (res.errors?.length) throw new Error(res.errors[0].message)

  cache = { at: 0, data: null }
  statusCache = { at: 0, data: null }
  return { status: name }
}

// Place one item directly after another (or at the top when `after` is null).
async function position(projectId, itemId, after) {
  const mutation = after
    ? `mutation($p:ID!,$i:ID!,$a:ID!){updateProjectV2ItemPosition(input:{projectId:$p,itemId:$i,afterId:$a}){clientMutationId}}`
    : `mutation($p:ID!,$i:ID!){updateProjectV2ItemPosition(input:{projectId:$p,itemId:$i}){clientMutationId}}`

  const args = ['api', 'graphql', '-f', `p=${projectId}`, '-f', `i=${itemId}`, '-f', `query=${mutation}`]
  if (after) args.push('-f', `a=${after}`)

  const res = await gh(args)
  if (res.errors?.length) throw new Error(res.errors[0].message)
}

// Reconcile the board against a desired order. The client reorders optimistically
// and sends the whole resulting order once the user stops clicking, so a run of
// ten ▲ clicks costs one fetch and one mutation instead of ten round trips.
//
// Only positions that actually differ are mutated, and the desired order is
// intersected with a freshly-fetched board — items added or removed elsewhere
// since the client last loaded are preserved rather than dropped.
async function reorder(desired) {
  const { projectId, items } = await board({ fresh: true })
  const current = items.map((it) => it.id)
  const known = new Set(current)

  const target = desired.filter((id) => known.has(id))
  const wanted = new Set(target)
  for (const id of current) if (!wanted.has(id)) target.push(id) // unknown to the client → keep at the end

  const working = [...current]
  let mutations = 0
  for (let i = 0; i < target.length; i++) {
    if (working[i] === target[i]) continue
    const id = target[i]
    working.splice(working.indexOf(id), 1)
    working.splice(i, 0, id)
    await position(projectId, id, i === 0 ? null : target[i - 1])
    mutations++
  }

  cache = { at: 0, data: null } // force a refetch on the next read
  return { mutations, order: working }
}

// Open CORS so the board can be embedded from elsewhere (a Flow artifact, a
// docs page) rather than only from the origin serving index.html.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

const send = (res, code, body, type) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...CORS })
  res.end(body)
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      return res.end()
    }
    if (path === '/api/board') {
      return send(res, 200, JSON.stringify(await board()), 'application/json')
    }
    if (path === '/api/status') {
      return send(res, 200, JSON.stringify(await statuses()), 'application/json')
    }
    if (path === '/api/set-status' && req.method === 'POST') {
      const { itemId, status } = JSON.parse(await readBody(req))
      if (!itemId || !status) throw new Error('need itemId and status')
      return send(res, 200, JSON.stringify(await setStatus(itemId, status)), 'application/json')
    }
    if (path === '/api/reorder' && req.method === 'POST') {
      const { order } = JSON.parse(await readBody(req))
      if (!Array.isArray(order) || !order.length) throw new Error('need a non-empty order array of item ids')
      return send(res, 200, JSON.stringify(await reorder(order)), 'application/json')
    }
    if (path === '/' || path === '/index.html') {
      return send(res, 200, await readFile(join(here, 'index.html')), 'text/html; charset=utf-8')
    }
    send(res, 404, 'not found', 'text/plain')
  } catch (err) {
    // Surface the real reason — usually gh not being logged in, or the token
    // missing the `project` scope. A blank board would hide that.
    send(res, 500, JSON.stringify({ error: String(err.message ?? err) }), 'application/json')
  }
}).listen(PORT, () => {
  console.log(`task board → http://localhost:${PORT}  (${OWNER} project #${NUMBER})`)
})
