'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function initialState() {
  return {
    schemaVersion: 1,
    jobs: [],
    counters: {},
    lastAttemptAt: 0,
    lastRequestAt: 0,
    lastProactiveAt: 0,
    paused: false,
    persistenceFault: false,
  }
}

function validateState(loaded) {
  if (!loaded || loaded.schemaVersion !== 1 || !Array.isArray(loaded.jobs)) throw new Error('invalid-state-schema')
  if (loaded.counters !== undefined && (!loaded.counters || typeof loaded.counters !== 'object' || Array.isArray(loaded.counters))) {
    throw new Error('invalid-state-counters')
  }
  const statuses = new Set(['pending', 'generating', 'generated', 'sending', 'delivered', 'failed', 'cancelled', 'generation-unknown', 'delivery-unknown'])
  const ids = new Set()
  for (const job of loaded.jobs) {
    if (!job || typeof job !== 'object' || !/^[a-f0-9]{32}$/.test(job.id || '') || !statuses.has(job.status)) {
      throw new Error('invalid-state-job')
    }
    if (ids.has(job.id)) throw new Error('duplicate-state-job')
    ids.add(job.id)
  }
}

function createStore(directory, logger) {
  const dir = path.resolve(directory)
  const file = path.join(dir, 'state.json')
  const assetsDir = path.join(dir, 'assets')
  let state = initialState()

  try {
    const raw = fs.readFileSync(file, 'utf8')
    const loaded = JSON.parse(raw)
    validateState(loaded)
    state = { ...initialState(), ...loaded }
    state.counters = loaded.counters || {}
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      state.paused = true
      state.persistenceFault = true
      logger?.warn?.('拍照状态无法安全读取，自动执行已暂停；不会覆盖原状态文件')
    }
  }

  function save() {
    if (state.persistenceFault) return false
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const descriptor = fs.openSync(file + '.tmp', 'w', 0o600)
      try {
        fs.writeFileSync(descriptor, JSON.stringify(state))
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
      fs.renameSync(file + '.tmp', file)
      return true
    } catch (error) {
      state.paused = true
      state.persistenceFault = true
      logger?.warn?.('拍照状态保存失败，自动执行已暂停：%s', error?.code || '文件写入错误')
      return false
    }
  }

  function assetPath(job) {
    if (!job?.assetFile || !/^[a-f0-9-]+-[a-f0-9]{16}\.(?:png|jpg|gif|webp)$/.test(job.assetFile)) return null
    const filePath = path.resolve(assetsDir, job.assetFile)
    if (path.dirname(filePath) !== assetsDir) return null
    return filePath
  }

  function writeAsset(job, image) {
    const assetFile = `${job.id}-${image.hash.slice(0, 16)}.${image.extension}`
    const target = assetPath({ assetFile })
    if (!target) throw Object.assign(new Error('invalid-asset-path'), { code: 'invalid-asset-path' })
    fs.mkdirSync(assetsDir, { recursive: true, mode: 0o700 })
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target)
      const actual = crypto.createHash('sha256').update(existing).digest('hex')
      if (actual !== image.hash) throw Object.assign(new Error('asset-hash-mismatch'), { code: 'asset-hash-mismatch' })
      return assetFile
    }
    const temporary = target + '.tmp'
    const descriptor = fs.openSync(temporary, 'w', 0o600)
    try {
      fs.writeFileSync(descriptor, image.data)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.renameSync(temporary, target)
    return assetFile
  }

  return { state, save, assetPath, writeAsset, dir, assetsDir }
}

module.exports = { createStore, initialState }
