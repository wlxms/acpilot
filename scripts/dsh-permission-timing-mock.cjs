'use strict'

const assert = require('node:assert/strict')

/**
 * Minimal timing model for the DSH -> ACPilot file-edit path.
 *
 * DSH's tools/pre-execute `next()` only resolves the policy decision; the
 * actual tool body runs later in tools/execute. The model deliberately keeps
 * the bridge, approval, External Edit baseline, and file write as separate
 * events so a regression in the ordering is visible without VS Code or a real
 * DSH process.
 */
class Timeline {
  constructor() {
    this.events = []
    this.content = 'before'
    this.baseline = undefined
  }

  push(event) {
    this.events.push(event)
  }

  captureBaseline() {
    this.push('external_edit.baseline')
    this.baseline = this.content
  }

  writeFile() {
    this.push('file_write')
    this.content = 'after'
  }

  diff() {
    return this.baseline === this.content ? '+0 -0' : '+1 -1'
  }
}

function assertOrdered(events, required) {
  let previous = -1
  for (const event of required) {
    const index = events.indexOf(event)
    assert.notEqual(index, -1, `missing event: ${event}`)
    assert.ok(index > previous, `${event} must follow ${required[required.indexOf(event) - 1] ?? 'start'}`)
    previous = index
  }
}

async function runDirectAskScenario() {
  const timeline = new Timeline()
  timeline.push('tool.pre-execute')
  timeline.push('bridge.emit.tool_call')
  timeline.push('bridge.return.ask')
  timeline.push('permission.request')
  timeline.captureBaseline()
  timeline.push('permission.reply')
  timeline.push('tools.execute')
  timeline.writeFile()
  timeline.push('tool.result')
  timeline.push('assistant.reply')
  return timeline
}

async function runLegacyNextThenAskScenario() {
  const timeline = new Timeline()
  timeline.push('tool.pre-execute')
  timeline.push('bridge.emit.tool_call')
  // DSH's pre-execute next() is policy-only; it does not dispatch the body.
  timeline.push('bridge.next.allow')
  timeline.push('bridge.return.ask')
  timeline.push('permission.request')
  timeline.captureBaseline()
  timeline.push('permission.reply')
  timeline.push('tools.execute')
  timeline.writeFile()
  timeline.push('tool.result')
  timeline.push('assistant.reply')
  return timeline
}

async function runBridgeFreeScenario() {
  const timeline = new Timeline()
  timeline.push('tool.pre-execute')
  timeline.push('dsh.permission.not_requested')
  // The ACP tool_call is delivered after DSH has committed the call. The
  // fallback External Edit is therefore scheduled after the un-gated tool can
  // already dispatch and write.
  await Promise.resolve().then(() => timeline.writeFile())
  await Promise.resolve().then(() => timeline.captureBaseline())
  timeline.push('tool.result')
  timeline.push('assistant.reply')
  return timeline
}

async function main() {
  const direct = await runDirectAskScenario()
  const legacy = await runLegacyNextThenAskScenario()
  const bridgeFree = await runBridgeFreeScenario()

  const expected = [
    'tool.pre-execute',
    'permission.request',
    'external_edit.baseline',
    'permission.reply',
    'file_write',
    'tool.result',
    'assistant.reply',
  ]
  assertOrdered(direct.events, expected)
  assertOrdered(legacy.events, expected)
  assert.ok(direct.events.indexOf('external_edit.baseline') < direct.events.indexOf('file_write'))
  assert.ok(legacy.events.indexOf('external_edit.baseline') < legacy.events.indexOf('file_write'))
  assert.equal(direct.diff(), '+1 -1')
  assert.equal(legacy.diff(), '+1 -1')

  const writeIndex = bridgeFree.events.indexOf('file_write')
  const baselineIndex = bridgeFree.events.indexOf('external_edit.baseline')
  assert.ok(writeIndex < baselineIndex, 'bridge-free full access should demonstrate the unsafe race')
  assert.equal(bridgeFree.diff(), '+0 -0')

  const output = {
    directAsk: { events: direct.events, diff: direct.diff() },
    legacyNextThenAsk: { events: legacy.events, diff: legacy.diff() },
    bridgeFree: {
      events: bridgeFree.events,
      diff: bridgeFree.diff(),
      conclusion: 'without a DSH bridge permission gate, ACPilot can only observe the edit after dispatch',
    },
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
