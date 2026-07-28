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
            ... on ProjectV2ItemFieldSingleSelectValue { name }
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

// Move one item up or down a single slot. The new neighbour is computed from a
// freshly-fetched order rather than from whatever the client last rendered, so
// a stale tab can't reorder against a board that has since changed.
async function move(itemId, direction) {
  const { projectId, items } = await board({ fresh: true })
  const i = items.findIndex((it) => it.id === itemId)
  if (i < 0) throw new Error('item is no longer on the board')

  const to = direction === 'up' ? i - 1 : i + 1
  if (to < 0 || to >= items.length) return { moved: false, reason: 'already at the end' }

  // afterId is whichever item ends up directly above this one. Omitting it
  // entirely means "move to the top".
  const after = direction === 'up' ? items[i - 2]?.id : items[i + 1].id

  const mutation = after
    ? `mutation($p:ID!,$i:ID!,$a:ID!){updateProjectV2ItemPosition(input:{projectId:$p,itemId:$i,afterId:$a}){clientMutationId}}`
    : `mutation($p:ID!,$i:ID!){updateProjectV2ItemPosition(input:{projectId:$p,itemId:$i}){clientMutationId}}`

  const args = ['api', 'graphql', '-f', `p=${projectId}`, '-f', `i=${itemId}`, '-f', `query=${mutation}`]
  if (after) args.push('-f', `a=${after}`)

  const res = await gh(args)
  if (res.errors?.length) throw new Error(res.errors[0].message)

  cache = { at: 0, data: null } // force a refetch on the next read
  return { moved: true }
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
    if (path === '/api/move' && req.method === 'POST') {
      const { itemId, direction } = JSON.parse(await readBody(req))
      if (!itemId || !['up', 'down'].includes(direction)) throw new Error('need itemId and direction up|down')
      return send(res, 200, JSON.stringify(await move(itemId, direction)), 'application/json')
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
