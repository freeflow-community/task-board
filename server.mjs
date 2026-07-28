// Task board — a tiny read-only frontend over a GitHub Project.
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

const QUERY = `
query($owner:String!, $number:Int!) {
  organization(login:$owner) {
    projectV2(number:$number) {
      title
      url
      items(first:100) {
        nodes {
          fieldValueByName(name:"Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            ... on Issue {
              number title url createdAt state
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
  const { stdout } = await exec(
    'gh',
    ['api', 'graphql', '-F', `owner=${OWNER}`, '-F', `number=${NUMBER}`, '-f', `query=${QUERY}`],
    { maxBuffer: 10 * 1024 * 1024 },
  )
  const project = JSON.parse(stdout).data?.organization?.projectV2
  if (!project) throw new Error(`no project #${NUMBER} under ${OWNER}`)

  const items = project.items.nodes
    // Draft items and PRs have no `number`; this first cut only renders issues.
    .filter((n) => n.content?.number)
    .map((n) => ({
      number: n.content.number,
      title: n.content.title,
      url: n.content.url,
      state: n.content.state,
      status: n.fieldValueByName?.name ?? null,
      repo: n.content.repository.nameWithOwner,
      createdAt: n.content.createdAt,
      labels: n.content.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
      assignees: n.content.assignees.nodes.map((a) => a.login),
    }))

  return { title: project.title, url: project.url, items, fetchedAt: new Date().toISOString() }
}

async function board() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data
  const data = await fetchBoard()
  cache = { at: Date.now(), data }
  return data
}

const send = (res, code, body, type) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  try {
    if (path === '/api/board') {
      return send(res, 200, JSON.stringify(await board()), 'application/json')
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
