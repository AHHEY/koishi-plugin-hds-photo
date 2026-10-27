'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRuntime } = require('../lib/runtime')
const { initialState } = require('../lib/store')
const { hash } = require('../lib/protocol')

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const existingFile = path.join(__dirname, '..', 'package.json')

function matches(row, query) {
  return Object.entries(query || {}).every(([key, expected]) => {
    const actual = key.includes('.') ? key.split('.').reduce((value, part) => value?.[part], row) : row[key]
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) {
      if ('$gte' in expected) return actual >= expected.$gte
      return matches(actual || {}, expected)
    }
    return actual === expected
  })
}

function createHarness(overrides = {}) {
  const tables = {
    interlude_story: [{
      id: 'story-1', platform: 'onebot', selfId: 'bot-1', status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      setting: { character: { name: '由纪' }, world: '现实生活', location: '贵阳', style: '现实主义' },
    }],
    interlude_participant: [{
      id: 'participant-1', storyId: 'story-1', platform: 'onebot', selfId: 'bot-1',
      userId: 'user-1', status: 'active',
    }],
    interlude_script_entry: [],
  }
  const state = initialState()
  const calls = { generate: 0, send: 0, append: 0, persist: 0, decide: 0 }
  let now = new Date('2026-01-02T00:00:00Z')
  let entryId = 0
  const originalNarrator = {
    async decide(request) {
      calls.decide += 1
      if (overrides.decideError) throw overrides.decideError
      return { script: '她正准备继续自己的生活。', browserIntents: [], request }
    },
  }
  const service = {
    config: { runtime: { allowProactiveMessages: true, ...overrides.runtimeConfig } },
    getNarrator: () => originalNarrator.current || originalNarrator,
    setNarrator(provider) { originalNarrator.current = provider },
    getDesktopRuntimePhase: () => overrides.runtimePhase || 'running',
    canHandleStory: () => true,
    canHandleParticipant: () => true,
    serial: (_id, task) => task(),
    async persistDecision(story, participant, decision, _from, createdAt) {
      calls.persist += 1
      calls.lastDecision = decision
      if (overrides.persistError) throw overrides.persistError
      tables.interlude_script_entry.push({
        id: ++entryId,
        storyId: story.id,
        participantId: participant.id,
        kind: 'script',
        actor: 'character',
        content: decision.script,
        createdAt,
        occurredAt: createdAt,
        metadata: {},
      })
      return overrides.persistedResult || { messages: [{ participantId: participant.id, content: '好' }] }
    },
    async appendEntry(storyId, entry, createdAt, participantId = '') {
      calls.append += 1
      if (typeof overrides.appendError === 'function' ? overrides.appendError(entry) : overrides.appendError) {
        throw typeof overrides.appendError === 'object' ? overrides.appendError : new Error('append failed')
      }
      const row = { ...entry, id: ++entryId, storyId, participantId, createdAt, metadata: entry.metadata || {} }
      tables.interlude_script_entry.push(row)
      return row
    },
  }
  const ctx = {
    interlude: service,
    bots: [{
      platform: 'onebot', selfId: 'bot-1',
      async sendPrivateMessage() {
        calls.send += 1
        if (overrides.sendError) throw overrides.sendError
        return 'message-1'
      },
    }],
    database: {
      async get(table, query) {
        if (overrides.databaseWait?.(table, query)) return overrides.databaseWait(table, query)
        if (overrides.databaseError?.(table, query)) throw new Error('database unavailable')
        return tables[table].filter(row => matches(row, query))
      },
    },
    logger: () => ({ warn() {}, info() {} }),
  }
  const store = {
    state,
    save() {
      if (overrides.saveError) {
        state.paused = true
        state.persistenceFault = true
        return false
      }
      return true
    },
    writeAsset(job, image) {
      if (overrides.assetError) throw overrides.assetError
      return `${job.id}-${image.hash.slice(0, 16)}.${image.extension}`
    },
    assetPath: () => existingFile,
  }
  const provider = {
    async generate() {
      calls.generate += 1
      if (overrides.generateError) throw overrides.generateError
      return { data: png, mimeType: 'image/png', extension: 'png', hash: hash(png) }
    },
  }
  const config = {
    enabled: true,
    platform: 'onebot', selfId: '', targetUserId: '',
    proactiveEnabled: true,
    dailyLimit: 4, maxPendingJobs: 2,
    requestCooldownMinutes: 0, proactiveCooldownMinutes: 0,
    requestTtlHours: 2, proactiveTtlHours: 1,
    ...overrides.config,
  }
  const h = (type, attrs) => ({ type, attrs })
  const runtime = createRuntime(ctx, config, { store, provider, h, autoSchedule: false, now: () => now })
  const story = tables.interlude_story[0]
  const participant = tables.interlude_participant[0]
  const decision = {
    script: '她想拍一张窗边的照片。',
    browserIntents: [{ mode: 'search', query: 'photo-request: 她正坐在窗边看书，桌上有一杯热茶', purpose: '用户想看看她现在在做什么', timing: 'deferred' }],
  }
  const args = () => [story, participant, decision, new Date(+now - 1000), now, true, 'user-message']
  const persist = async (...persistArgs) => {
    const result = await service.persistDecision(...persistArgs)
    await runtime.flushCaptures()
    return result
  }
  return { runtime, service, persist, tables, state, calls, story, participant, decision, args, ctx, originalNarrator, setNow: value => { now = new Date(value) } }
}

test('正常闭环不阻塞主叙事，图片只发送一次并回写成功事实', async () => {
  const h = createHarness()
  const persisted = await h.persist(...h.args())
  assert.equal(persisted.messages[0].content, '好')
  assert.equal(h.calls.generate, 0)
  assert.equal(h.state.jobs.length, 1)

  await h.runtime.drain()
  const job = h.state.jobs[0]
  assert.equal(job.status, 'delivered')
  assert.ok(job.recordedAt)
  assert.equal(h.calls.generate, 1)
  assert.equal(h.calls.send, 1)
  assert.equal(h.tables.interlude_script_entry.filter(row => row.kind === 'photo-observation').length, 1)
  assert.equal(h.tables.interlude_script_entry.filter(row => row.kind === 'character-platform-action').length, 1)

  await h.runtime.drain()
  assert.equal(h.calls.generate, 1)
  assert.equal(h.calls.send, 1)
})

test('生图 API 失败只终止拍照任务，原决策结果不变且不重试', async () => {
  const h = createHarness({ generateError: new Error('provider down') })
  const result = await h.persist(...h.args())
  assert.equal(result.messages[0].content, '好')
  await h.runtime.drain()
  assert.equal(h.state.jobs[0].status, 'failed')
  assert.equal(h.calls.send, 0)
  assert.equal(h.tables.interlude_script_entry.at(-1).kind, 'photo-observation')
  await h.runtime.drain()
  assert.equal(h.calls.generate, 1)
})

test('投递异常标记结果未知，不自动重发', async () => {
  const h = createHarness({ sendError: new Error('transport timeout') })
  await h.persist(...h.args())
  await h.runtime.drain()
  assert.equal(h.state.jobs[0].status, 'delivery-unknown')
  assert.equal(h.calls.send, 1)
  await h.runtime.drain()
  assert.equal(h.calls.send, 1)
})

test('HDS 回写失败不撤回主叙事，也不重复生成或发送', async () => {
  const h = createHarness({ appendError: new Error('database read only') })
  const result = await h.persist(...h.args())
  assert.equal(result.messages[0].content, '好')
  await h.runtime.drain()
  const job = h.state.jobs[0]
  assert.equal(job.status, 'delivered')
  assert.equal(job.recordedAt, undefined)
  assert.equal(h.calls.generate, 1)
  assert.equal(h.calls.send, 1)
  await h.runtime.drain()
  assert.equal(h.calls.generate, 1)
  assert.equal(h.calls.send, 1)
})

test('拍照意图捕获数据库失败不影响原 persistDecision 返回', async () => {
  const h = createHarness({
    databaseError: (table, query) => table === 'interlude_script_entry' && query.kind === 'script',
  })
  const result = await h.persist(...h.args())
  assert.equal(result.messages[0].content, '好')
  assert.equal(h.state.jobs.length, 0)
  assert.equal(h.calls.persist, 1)
})

test('状态保存失败会暂停拍照，不调用生图且不影响主叙事', async () => {
  const h = createHarness({ saveError: true })
  const result = await h.persist(...h.args())
  assert.equal(result.messages[0].content, '好')
  await h.runtime.drain()
  assert.equal(h.calls.generate, 0)
  assert.equal(h.calls.send, 0)
  assert.equal(h.state.persistenceFault, true)
})

test('HDS 原持久化异常保持原样抛出，拍照不创建任务', async () => {
  const expected = new Error('original HDS failure')
  const h = createHarness({ persistError: expected })
  await assert.rejects(h.persist(...h.args()), error => error === expected)
  assert.equal(h.state.jobs.length, 0)
  assert.equal(h.calls.generate, 0)
})

test('重载时 sending 只转为 delivery-unknown，绝不自动重发', async () => {
  const h = createHarness()
  h.state.jobs.push({
    id: 'a'.repeat(32), storyId: 'story-1', participantId: 'participant-1',
    status: 'sending', createdAt: Date.now(), updatedAt: Date.now(), notBefore: 0,
  })
  h.runtime.dispose()
  const restarted = createRuntime(h.ctx, {
    enabled: true, platform: 'onebot', proactiveEnabled: true,
    dailyLimit: 4, maxPendingJobs: 2, requestCooldownMinutes: 0,
    proactiveCooldownMinutes: 0, requestTtlHours: 2, proactiveTtlHours: 1,
  }, {
    store: { state: h.state, save: () => true, assetPath: () => existingFile },
    provider: { generate: async () => { throw new Error('must not generate') } },
    h: () => ({}), autoSchedule: false,
  })
  assert.equal(h.state.jobs[0].status, 'delivery-unknown')
  await restarted.drain()
  assert.equal(h.calls.send, 0)
  restarted.dispose()
})

test('只消费自己的拍照意图，B 站与普通网页意图原样保留', async () => {
  const h = createHarness()
  h.decision.browserIntents.push(
    { mode: 'search', query: 'bili: 摄影', purpose: '看看视频', timing: 'deferred' },
    { mode: 'search', query: '贵阳天气', purpose: '核对天气', timing: 'deferred' },
  )
  await h.persist(...h.args())
  const source = h.tables.interlude_script_entry.find(row => row.kind === 'script')
  assert.ok(source)
  assert.equal(h.state.jobs.length, 1)
  assert.equal(h.decision.browserIntents.length, 3)
  assert.deepEqual(h.calls.lastDecision.browserIntents.map(intent => intent.query), ['bili: 摄影', '贵阳天气'])
})

test('重复提交同一来源与场景只创建一个任务', async () => {
  const h = createHarness()
  const persisted = await h.persist(...h.args())
  await h.runtime.capture(h.args(), {
    scene: '她正坐在窗边看书，桌上有一杯热茶', purpose: '用户想看看她现在在做什么', requested: true,
  }, persisted)
  assert.equal(h.state.jobs.length, 1)
  await h.runtime.drain()
  assert.equal(h.calls.generate, 1)
  assert.equal(h.calls.send, 1)
})

test('存图失败不调用发送且不影响原叙事', async () => {
  const h = createHarness({ assetError: new Error('disk full') })
  const result = await h.persist(...h.args())
  assert.equal(result.messages[0].content, '好')
  await h.runtime.drain()
  assert.equal(h.state.jobs[0].status, 'failed')
  assert.equal(h.calls.send, 0)
})

test('来源剧本被改变后取消过期任务，不生图不发送', async () => {
  const h = createHarness()
  await h.persist(...h.args())
  const source = h.tables.interlude_script_entry.find(row => row.kind === 'script')
  source.content = '已经被其他剧情替代'
  await h.runtime.drain()
  assert.equal(h.state.jobs[0].status, 'cancelled')
  assert.equal(h.calls.generate, 0)
  assert.equal(h.calls.send, 0)
})

test('后台主动拍照没有 HDS 实际可见消息许可时不创建任务', async () => {
  const h = createHarness({ persistedResult: { messages: [] } })
  const args = h.args()
  args[5] = true
  args[6] = 'advance'
  await h.persist(...args)
  assert.equal(h.state.jobs.length, 0)
  assert.equal(h.calls.generate, 0)
})

test('能力上下文失败时仍调用原主叙事', async () => {
  const h = createHarness({
    databaseError: table => table === 'interlude_script_entry',
  })
  const request = {
    story: h.story,
    participant: h.participant,
    writingOptions: {},
    contractFeatures: {},
  }
  const result = await h.service.getNarrator().decide(request)
  assert.equal(h.calls.decide, 1)
  assert.equal(result.script, '她正准备继续自己的生活。')
})

test('部分结果回写后只补缺失事件，不重复观察或发送', async () => {
  let failAction = true
  const h = createHarness({
    appendError: entry => failAction && entry.kind === 'character-platform-action',
  })
  await h.persist(...h.args())
  await h.runtime.drain()
  const job = h.state.jobs[0]
  assert.equal(job.status, 'delivered')
  assert.equal(job.recordedAt, undefined)
  assert.equal(h.tables.interlude_script_entry.filter(row => row.kind === 'photo-observation').length, 1)
  assert.equal(h.tables.interlude_script_entry.filter(row => row.kind === 'character-platform-action').length, 0)

  failAction = false
  h.setNow('2026-01-02T00:01:01Z')
  await h.runtime.drain()
  assert.ok(job.recordedAt)
  assert.equal(h.tables.interlude_script_entry.filter(row => row.kind === 'photo-observation').length, 1)
  assert.equal(h.tables.interlude_script_entry.filter(row => row.kind === 'character-platform-action').length, 1)
  assert.equal(h.calls.send, 1)
})

test('回写失败会安排定时重试而不是静默搁置', async () => {
  const h = createHarness({ appendError: new Error('temporary failure') })
  await h.persist(...h.args())
  await h.runtime.drain()
  assert.equal(h.state.jobs[0].status, 'delivered')
  assert.equal(h.state.jobs[0].recordedAt, undefined)
  assert.equal(h.runtime.nextWakeDelay(), 60000)
})

test('主功能暂停时仍可补写已完成的拍照结果', async () => {
  const h = createHarness()
  await h.persist(...h.args())
  await h.runtime.drain()
  const job = h.state.jobs[0]
  assert.ok(job.recordedAt)
  job.recordedAt = undefined
  h.state.jobs.unshift({ id: 'e'.repeat(32), status: 'pending', notBefore: 0 })
  h.state.paused = true
  await h.runtime.drain()
  assert.ok(job.recordedAt)
  assert.equal(h.calls.send, 1)
})

test('HDS 主动消息总开关关闭时，不允许后台拍照绕出门控', async () => {
  const h = createHarness({ runtimeConfig: { allowProactiveMessages: false } })
  const args = h.args()
  args[6] = 'advance'
  await h.persist(...args)
  assert.equal(h.state.jobs.length, 0)
  assert.equal(h.calls.generate, 0)
})

test('任务数量裁剪只删除已完成记录，保留未回写终态', async () => {
  const h = createHarness()
  h.state.jobs.push(...Array.from({ length: 300 }, (_, index) => ({
    id: hash(`old-${index}`).slice(0, 32), status: 'delivered', recordedAt: Date.now(), notBefore: 0,
  })))
  const pending = { id: 'c'.repeat(32), status: 'failed', notBefore: 0 }
  h.state.jobs.push(pending)
  await h.persist(...h.args())
  assert.equal(h.state.jobs.length, 300)
  assert.ok(h.state.jobs.includes(pending))
  assert.equal(h.state.jobs.at(-1).status, 'pending')
})

test('后台捕获数据库不响应时，主 persistDecision 仍立即返回', async () => {
  let release
  const h = createHarness({
    databaseWait: (table, query) => table === 'interlude_script_entry' && query.kind === 'script'
      ? new Promise(resolve => { release = () => resolve([]) })
      : null,
  })
  const result = await h.service.persistDecision(...h.args())
  assert.equal(result.messages[0].content, '好')
  assert.equal(h.state.jobs.length, 0)
  await new Promise(resolve => setImmediate(resolve))
  release()
  await h.runtime.flushCaptures()
  assert.equal(h.state.jobs.length, 0)
})

test('拍照上下文数据库卡住时，超时后仍执行原主叙事', async () => {
  const h = createHarness({
    config: { contextTimeoutMs: 50 },
    databaseWait: table => table === 'interlude_script_entry' ? new Promise(() => {}) : null,
  })
  const started = Date.now()
  const keepAlive = setTimeout(() => {}, 200)
  try {
    const result = await h.service.getNarrator().decide({
      story: h.story, participant: h.participant, writingOptions: {}, contractFeatures: {},
    })
    assert.equal(h.calls.decide, 1)
    assert.equal(result.script, '她正准备继续自己的生活。')
    assert.ok(Date.now() - started < 500)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('自主拍照捕获后出现新用户消息，旧任务会取消', async () => {
  const h = createHarness()
  h.decision.browserIntents[0].query = 'photo: 她正坐在窗边看书'
  const args = h.args()
  args[6] = 'advance'
  await h.persist(...args)
  assert.equal(h.state.jobs.length, 1)
  h.tables.interlude_script_entry.push({
    id: 999, storyId: 'story-1', participantId: 'participant-1', kind: 'user-message',
    content: '新消息', createdAt: new Date(), occurredAt: new Date(), metadata: {},
  })
  await h.runtime.drain()
  assert.equal(h.state.jobs[0].status, 'cancelled')
  assert.equal(h.calls.generate, 0)
  assert.equal(h.calls.send, 0)
})

test('用户明确索取的照片不会因普通后续消息被误取消', async () => {
  const h = createHarness()
  await h.persist(...h.args())
  h.tables.interlude_script_entry.push({
    id: 999, storyId: 'story-1', participantId: 'participant-1', kind: 'user-message',
    content: '好了吗', createdAt: new Date(), occurredAt: new Date(), metadata: {},
  })
  await h.runtime.drain()
  assert.equal(h.state.jobs[0].status, 'delivered')
  assert.equal(h.calls.send, 1)
})
