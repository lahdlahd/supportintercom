/**

- TaskAuction — P2P Task Auction House built on Intercom
- 
- Agents post tasks with a budget; other agents bid to complete them.
- Bids are negotiated over Intercom sidechannels in real time.
- Winning bid and task state are committed to the shared contract/subnet.
- 
- Usage (via Pear runtime):
- pear run . –peer-store-name myPeer –msb-store-name myMSB –role poster
- pear run . –peer-store-name bidderPeer –msb-store-name bidderMSB –role bidder –subnet-bootstrap <admin-key>
  */

‘use strict’

const goodbye = require(‘graceful-goodbye’)
const minimist = require(‘minimist’)
const Intercom = require(’./index.js’) // upstream Intercom entry point

const argv = minimist(process.argv.slice(2), {
string: [‘peer-store-name’, ‘msb-store-name’, ‘role’, ‘subnet-bootstrap’, ‘subnet-channel’, ‘sidechannels’],
default: {
role: ‘bidder’,
‘subnet-channel’: ‘taskauction’,
sidechannels: ‘taskauction-bids’
}
})

// ── Auction state (in-memory; durable state lives in contract) ──────────────
const openAuctions = new Map()   // taskId -> { title, budget, deadline, bids: [] }
const myBids       = new Map()   // taskId -> amount

// ── Message types ────────────────────────────────────────────────────────────
const MSG = {
POST_TASK:   ‘TASK_POST’,
BID:         ‘TASK_BID’,
AWARD:       ‘TASK_AWARD’,
CANCEL:      ‘TASK_CANCEL’,
LIST_TASKS:  ‘TASK_LIST’
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeTaskId () {
return ‘task-’ + Date.now() + ‘-’ + Math.random().toString(36).slice(2, 8)
}

function log (…args) {
console.log(’[TaskAuction]’, …args)
}

// ── Core handlers ────────────────────────────────────────────────────────────

/**

- Post a new task to the auction channel.
- @param {object} intercom  - running Intercom instance
- @param {string} title     - task description
- @param {number} budget    - maximum budget (in TNK or any unit)
- @param {number} ttlMs     - auction duration in milliseconds
  */
  async function postTask (intercom, { title, budget, ttlMs = 60_000 }) {
  const taskId  = makeTaskId()
  const deadline = Date.now() + ttlMs

const task = { taskId, title, budget, deadline, bids: [] }
openAuctions.set(taskId, task)

await intercom.send(‘taskauction-bids’, {
type: MSG.POST_TASK,
taskId,
title,
budget,
deadline
})

log(`Posted task "${title}" [${taskId}] budget=${budget} TTL=${ttlMs}ms`)

// Auto-award lowest bid when deadline passes
setTimeout(() => awardBestBid(intercom, taskId), ttlMs)

return taskId
}

/**

- Submit a bid for an open task.
  */
  async function submitBid (intercom, { taskId, amount, bidderKey }) {
  if (!openAuctions.has(taskId)) {
  log(`Unknown task ${taskId}, cannot bid`)
  return
  }
  myBids.set(taskId, amount)

await intercom.send(‘taskauction-bids’, {
type: MSG.BID,
taskId,
amount,
bidderKey
})

log(`Bid submitted: task=${taskId} amount=${amount}`)
}

/**

- Award the task to the best (lowest) bidder.
  */
  async function awardBestBid (intercom, taskId) {
  const task = openAuctions.get(taskId)
  if (!task || task.bids.length === 0) {
  log(`No bids for task ${taskId}, cancelling`)
  await intercom.send(‘taskauction-bids’, { type: MSG.CANCEL, taskId })
  openAuctions.delete(taskId)
  return
  }

// Pick the lowest bid
const winner = task.bids.reduce((best, b) => b.amount < best.amount ? b : best)

await intercom.send(‘taskauction-bids’, {
type:      MSG.AWARD,
taskId,
winner:    winner.bidderKey,
amount:    winner.amount
})

log(`Task ${taskId} awarded to ${winner.bidderKey} for ${winner.amount}`)
openAuctions.delete(taskId)
}

// ── Incoming message router ──────────────────────────────────────────────────
function handleMessage (intercom, msg) {
switch (msg.type) {
case MSG.POST_TASK: {
log(`New task posted: "${msg.title}" [${msg.taskId}] budget=${msg.budget}`)
if (!openAuctions.has(msg.taskId)) {
openAuctions.set(msg.taskId, { …msg, bids: [] })
}
break
}

```
case MSG.BID: {
  const task = openAuctions.get(msg.taskId)
  if (task) {
    task.bids.push({ bidderKey: msg.bidderKey, amount: msg.amount })
    log(`Bid received on ${msg.taskId}: ${msg.amount} from ${msg.bidderKey}`)
  }
  break
}

case MSG.AWARD: {
  log(`🏆 Task ${msg.taskId} won by ${msg.winner} for ${msg.amount}`)
  openAuctions.delete(msg.taskId)
  break
}

case MSG.CANCEL: {
  log(`Task ${msg.taskId} cancelled (no bids)`)
  openAuctions.delete(msg.taskId)
  break
}

case MSG.LIST_TASKS: {
  log('Open tasks:', [...openAuctions.keys()])
  break
}
```

}
}

// ── SC-Bridge command handler (agents call this via WebSocket) ───────────────
function handleBridgeCommand (intercom, cmd) {
switch (cmd.action) {
case ‘post_task’:
return postTask(intercom, cmd)
case ‘bid’:
return submitBid(intercom, cmd)
case ‘list’:
return { tasks: […openAuctions.values()].map(t => ({
taskId:   t.taskId,
title:    t.title,
budget:   t.budget,
deadline: t.deadline,
bidCount: t.bids.length
}))}
default:
return { error: ‘Unknown action’ }
}
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function main () {
const intercom = new Intercom(argv)

// Subscribe to the auction sidechannel
intercom.on(‘message:taskauction-bids’, (msg) => handleMessage(intercom, msg))

// Expose bridge commands for agent automation
intercom.on(‘bridge:command’, (cmd, reply) => {
const result = handleBridgeCommand(intercom, cmd)
if (result && typeof result.then === ‘function’) {
result.then(reply).catch(err => reply({ error: err.message }))
} else {
reply(result)
}
})

await intercom.ready()
log(`Running as ${argv.role}. Sidechannel: taskauction-bids`)

if (argv.role === ‘demo’) {
// Demo: post a task after 2s, then bid on it after 4s (self-demo)
setTimeout(async () => {
await postTask(intercom, {
title:  ‘Summarise this week's Trac Network news’,
budget: 50,
ttlMs:  15_000
})
}, 2000)

```
setTimeout(async () => {
  const [taskId] = openAuctions.keys()
  if (taskId) {
    await submitBid(intercom, {
      taskId,
      amount:    30,
      bidderKey: await intercom.publicKey()
    })
  }
}, 5000)
```

}

goodbye(() => intercom.close())
}

main().catch(err => { console.error(err); process.exit(1) })
