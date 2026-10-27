'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createStore } = require('../lib/store')

function fixture(t) {
  const directory = path.join(__dirname, `.store-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  fs.mkdirSync(directory, { recursive: true })
  t.after(() => {
    const state = path.join(directory, 'state.json')
    const temporary = state + '.tmp'
    for (const file of [state, temporary]) if (fs.existsSync(file)) fs.unlinkSync(file)
    const assets = path.join(directory, 'assets')
    if (fs.existsSync(assets)) {
      for (const file of fs.readdirSync(assets)) fs.unlinkSync(path.join(assets, file))
      fs.rmdirSync(assets)
    }
    fs.rmdirSync(directory)
  })
  return directory
}

const image = {
  data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 1, 2]),
  mimeType: 'image/png', extension: 'png', hash: 'a'.repeat(64),
}

test('任务状态原子保存并可重新读取', t => {
  const directory = fixture(t)
  const store = createStore(directory, console)
  store.state.jobs.push({ id: 'a'.repeat(32), status: 'pending' })
  assert.equal(store.save(), true)
  const loaded = createStore(directory, console)
  assert.equal(loaded.state.jobs.length, 1)
  assert.equal(loaded.state.paused, false)
})

test('损坏状态只暂停自身，不覆盖原文件', t => {
  const directory = fixture(t)
  const file = path.join(directory, 'state.json')
  fs.writeFileSync(file, '{broken json')
  const store = createStore(directory, console)
  assert.equal(store.state.paused, true)
  assert.equal(store.state.persistenceFault, true)
  assert.equal(store.save(), false)
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken json')
})

test('重复任务 ID 会触发安全暂停而不是覆盖状态', t => {
  const directory = fixture(t)
  const file = path.join(directory, 'state.json')
  const job = { id: 'd'.repeat(32), status: 'pending' }
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, jobs: [job, job], counters: {} }))
  const store = createStore(directory, console)
  assert.equal(store.state.paused, true)
  assert.equal(store.state.persistenceFault, true)
  assert.equal(store.save(), false)
})

test('图片写入受控资产目录并拒绝路径穿越', t => {
  const directory = fixture(t)
  const store = createStore(directory, console)
  const job = { id: 'b'.repeat(32) }
  const assetFile = store.writeAsset(job, image)
  job.assetFile = assetFile
  const file = store.assetPath(job)
  assert.ok(file)
  assert.deepEqual(fs.readFileSync(file), image.data)
  assert.equal(store.assetPath({ assetFile: '../state.json' }), null)
  assert.equal(store.assetPath({ assetFile: 'not-an-image.txt' }), null)
  fs.writeFileSync(file, Buffer.from('corrupted'))
  assert.throws(() => store.writeAsset(job, image), /asset-hash-mismatch/)
})
