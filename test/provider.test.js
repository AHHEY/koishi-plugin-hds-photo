'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createImageProvider } = require('../lib/provider')

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

function config(overrides = {}) {
  return {
    endpoint: 'https://api.example.test/v1/images/generations',
    apiKey: 'secret-key',
    model: 'image-model',
    size: '1024x1024',
    timeoutMs: 1000,
    maxImageMB: 1,
    ...overrides,
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
  }
}

function input(overrides = {}) {
  return {
    scene: 'A quiet scene',
    purpose: 'memory',
    story: {
      setting: {
        character: { name: 'Hikari', appearance: 'silver hair' },
        location: 'a station',
        style: 'watercolor',
      },
    },
    ...overrides,
  }
}

test('生成 b64 图片并构造提示词和请求体', async () => {
  let request
  const provider = createImageProvider(config({
    promptTemplate: '{characterName}|{appearance}|{scene}|{location}|{style}|{negativePrompt}',
    negativePrompt: 'blurry',
    appearanceProfile: 'fallback appearance',
    extraBody: { quality: 'high', size: '2048x2048' },
  }), {
    async fetchImpl(url, options) {
      request = { url, options }
      return jsonResponse({ data: [{ b64_json: `data:image/png;base64,${png.toString('base64')}` }] })
    },
  })

  const result = await provider.generate(input())

  assert.equal(request.url, config().endpoint)
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.headers.authorization, 'Bearer secret-key')
  const body = JSON.parse(request.options.body)
  assert.deepEqual(body, {
    model: 'image-model',
    prompt: 'Hikari|silver hair|A quiet scene|a station|watercolor|blurry',
    size: '2048x2048',
    n: 1,
    response_format: 'b64_json',
    quality: 'high',
  })
  assert.ok(Buffer.isBuffer(result.data))
  assert.ok(result.data.equals(png))
  assert.equal(result.mimeType, 'image/png')
  assert.equal(result.extension, 'png')
  assert.match(result.hash, /^[a-f0-9]{64}$/)
})

test('下载 https URL 图片并设置超时', async () => {
  const urls = []
  const provider = createImageProvider(config(), {
    async fetchImpl(url) {
      urls.push(url)
      if (urls.length === 1) return jsonResponse({ images: [{ url: 'https://img.example.test/a.png?private=signature' }] })
      assert.equal(url, 'https://img.example.test/a.png?private=signature')
      return { ok: true, status: 200, async arrayBuffer() { return png } }
    },
  })

  const result = await provider.generate(input())
  assert.equal(result.mimeType, 'image/png')
  assert.deepEqual(urls, [config().endpoint, 'https://img.example.test/a.png?private=signature'])
})

test('HTTP 失败只暴露安全错误', async () => {
  const provider = createImageProvider(config(), {
    async fetchImpl() {
      return {
        ok: false,
        status: 401,
        async json() { return { error: 'secret-key and private response' } },
      }
    },
  })
  await assert.rejects(provider.generate(input()), (error) => {
    assert.match(error.message, /401/)
    assert.doesNotMatch(error.message, /secret-key|private response/)
    return true
  })
})

test('响应没有图片时拒绝', async () => {
  const provider = createImageProvider(config(), {
    async fetchImpl() { return jsonResponse({ data: [] }) },
  })
  await assert.rejects(provider.generate(input()), /returned no image/)
})

test('拒绝非法图片内容', async () => {
  const provider = createImageProvider(config(), {
    async fetchImpl() {
      return jsonResponse({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })
    },
  })
  await assert.rejects(provider.generate(input()), /not a supported image/)
})

test('拒绝超过 maxImageMB 的图片', async () => {
  const provider = createImageProvider(config({ maxImageMB: 8 / (1024 * 1024) }), {
    async fetchImpl() {
      return jsonResponse({ data: [{ b64_json: png.toString('base64') }] })
    },
  })
  await assert.rejects(provider.generate(input()), /exceeds image size limit/)
})

test('参考图读取失败时不调用 API', async () => {
  let called = false
  const provider = createImageProvider(config({
    referenceMode: 'single',
    referenceRoot: os.tmpdir(),
    referenceImages: [path.join(os.tmpdir(), 'hds-photo-file-that-does-not-exist.png')],
  }), {
    async fetchImpl() {
      called = true
      throw new Error('should not be called')
    },
  })
  await assert.rejects(provider.generate(input()), /Failed to read reference image/)
  assert.equal(called, false)
})

test('single 和 array 参考图使用 data URI', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hds-photo-provider-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const first = path.join(directory, 'first.png')
  const second = path.join(directory, 'second.jpg')
  await fs.writeFile(first, png)
  await fs.writeFile(second, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))

  for (const [mode, expected] of [
    ['single', `data:image/png;base64,${png.toString('base64')}`],
    ['array', [
      `data:image/png;base64,${png.toString('base64')}`,
      'data:image/jpeg;base64,/9j/2Q==',
    ]],
  ]) {
    let body
    const provider = createImageProvider(config({
      referenceMode: mode,
      referenceRoot: directory,
      referenceImages: [first, second],
    }), {
      async fetchImpl(_url, options) {
        body = JSON.parse(options.body)
        return jsonResponse({ data: [{ b64_json: png.toString('base64') }] })
      },
    })
    await provider.generate(input())
    assert.deepEqual(body.image, expected)
  }
})

test('参考图不能逃出专用目录', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hds-photo-reference-root-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let called = false
  const provider = createImageProvider(config({
    referenceMode: 'single',
    referenceRoot: directory,
    referenceImages: ['../outside.png'],
  }), {
    async fetchImpl() {
      called = true
      throw new Error('should not be called')
    },
  })
  await assert.rejects(provider.generate(input()), /allowed directory/)
  assert.equal(called, false)
})

test('流式下载超过大小限制时提前终止', async () => {
  const provider = createImageProvider(config({ maxImageMB: 1 / (1024 * 1024) }), {
    async fetchImpl(url) {
      if (url.includes('images/generations')) return jsonResponse({ data: [{ url: 'https://img.example.test/large.png' }] })
      return {
        ok: true, status: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.alloc(2)
            yield png
          },
        },
      }
    },
  })
  await assert.rejects(provider.generate(input()), /exceeds image size limit/)
})

test('图片响应体读取也有独立超时', async () => {
  const provider = createImageProvider(config({ timeoutMs: 5 }), {
    async fetchImpl(url) {
      if (url.includes('images/generations')) return jsonResponse({ data: [{ url: 'https://img.example.test/slow.png' }] })
      return {
        ok: true, status: 200,
        body: {
          [Symbol.asyncIterator]() {
            return { next: () => new Promise(() => {}) }
          },
        },
      }
    },
  })
  await assert.rejects(provider.generate(input()), /response body timed out/)
})

test('图片 URL 不能指向本机或内网', async () => {
  let calls = 0
  const provider = createImageProvider(config(), {
    async fetchImpl() {
      calls += 1
      return jsonResponse({ data: [{ url: 'https://127.0.0.1/private.png' }] })
    },
  })
  await assert.rejects(provider.generate(input()), /public HTTPS URL/)
  assert.equal(calls, 1)
})

test('图片重定向目标同样必须是公开 HTTPS', async () => {
  let calls = 0
  const provider = createImageProvider(config(), {
    async fetchImpl(url) {
      calls += 1
      if (url.includes('images/generations')) return jsonResponse({ data: [{ url: 'https://img.example.test/start' }] })
      return { ok: false, status: 302, headers: { get: () => 'https://192.168.1.10/internal.png' } }
    },
  })
  await assert.rejects(provider.generate(input()), /public HTTPS URL/)
  assert.equal(calls, 2)
})

test('生图接口 JSON 响应体读取也有超时', async () => {
  const provider = createImageProvider(config({ timeoutMs: 5 }), {
    async fetchImpl() {
      return { ok: true, status: 200, json: () => new Promise(() => {}) }
    },
  })
  await assert.rejects(provider.generate(input()), /provider response body timed out/)
})

test('请求超时安全拒绝', async () => {
  const provider = createImageProvider(config({ timeoutMs: 5 }), {
    fetchImpl(_url, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  })
  await assert.rejects(provider.generate(input()), /timed out after 5ms/)
})
