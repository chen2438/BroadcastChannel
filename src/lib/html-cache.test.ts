import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheHtml, HTML_CACHE_CONTROL } from './html-cache'

function html(body = '<html>rendered</html>', init: ResponseInit = {}) {
  return new Response(body, {
    ...init,
    headers: { 'Content-Type': 'text/html', 'Cache-Control': HTML_CACHE_CONTROL, ...init.headers },
  })
}

describe('rendered HTML cache', () => {
  const entries = new Map<string, Response>()
  const tasks: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (task: Promise<unknown>) => {
      tasks.push(task)
    },
  }
  const options = { enabled: true, ctx, hasCookies: () => false }
  const request = new Request('https://blog.example/?before=20')
  const match = vi.fn(async (key: Request) => entries.get(key.url)?.clone())
  const put = vi.fn(async (key: Request, response: Response) => {
    entries.set(key.url, new Response(await response.arrayBuffer(), response))
  })
  const flush = async () => {
    while (tasks.length) {
      await Promise.all(tasks.splice(0))
    }
  }

  beforeEach(() => {
    entries.clear()
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    vi.stubGlobal('caches', { default: { match, put } })
  })

  afterEach(async () => {
    await flush()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('stores HTML through waitUntil and skips rendering on a URL hit', async () => {
    const render = vi.fn(async () => html())
    const first = await cacheHtml(request, render, options)
    expect(tasks.length).toBe(1)
    expect(await first.text()).toBe('<html>rendered</html>')
    await flush()
    const hit = await cacheHtml(request, render, options)
    expect(await hit.text()).toBe('<html>rendered</html>')
    expect(hit.headers.get('Cache-Control')).toBe(HTML_CACHE_CONTROL)
    expect(hit.headers.has('X-BroadcastChannel-Cached-At')).toBe(false)
    expect(render).toHaveBeenCalledTimes(1)
    await cacheHtml(new Request('https://blog.example/?before=19'), render, options)
    expect(render).toHaveBeenCalledTimes(2)
  })

  it.each([
    new Request('https://blog.example/', { method: 'POST' }),
    new Request('https://blog.example/', { method: 'HEAD' }),
    new Request('https://blog.example/', { headers: { Cookie: 'session=1' } }),
    new Request('https://blog.example/', { headers: { Authorization: 'Bearer test' } }),
    new Request('https://blog.example/', { headers: { Range: 'bytes=0-2' } }),
  ])('bypasses cache for unsafe request %s', async (request) => {
    await cacheHtml(request, async () => html(), options)
    expect(match).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it.each([
    { status: 404 },
    { status: 500 },
    { status: 302 },
    { status: 206 },
    { headers: { 'Set-Cookie': 'session=1' } },
    { headers: { Vary: 'Cookie' } },
    { headers: { 'Cache-Control': 'private, max-age=60' } },
    { headers: { 'Cache-Control': 'no-store' } },
    { headers: { 'Cache-Control': 'no-cache' } },
    { headers: { 'Content-Type': 'application/rss+xml' } },
  ])('does not share errors, partial, private or non-HTML responses: %j', async (init) => {
    await cacheHtml(request, async () => html('body', init), options)
    expect(put).not.toHaveBeenCalled()
  })

  it('checks pending Astro cookies as well as Set-Cookie headers', async () => {
    await cacheHtml(request, async () => html(), { ...options, hasCookies: () => true })
    expect(put).not.toHaveBeenCalled()
  })

  it('degrades gracefully without caches.default or a Cloudflare context', async () => {
    vi.stubGlobal('caches', {})
    expect(await (await cacheHtml(request, async () => html(), options)).text()).toContain('rendered')
    vi.stubGlobal('caches', undefined)
    await cacheHtml(request, async () => html(), options)
    vi.stubGlobal('caches', { default: { match, put } })
    await cacheHtml(request, async () => html(), { ...options, ctx: undefined })
    expect(entries.has(request.url)).toBe(true)
  })

  it('serves stale HTML immediately, coalesces refreshes, then serves updated HTML', async () => {
    await cacheHtml(request, async () => html('old'), options)
    await flush()
    vi.mocked(Date.now).mockReturnValue(1_800_000_901_000)
    let complete!: (response: Response) => void
    const render = vi.fn(() => new Promise<Response>((resolve) => {
      complete = resolve
    }))
    const stale = await cacheHtml(request, render, options)
    expect(await stale.text()).toBe('old')
    expect(stale.headers.get('Age')).toBe('901')
    const concurrent = await cacheHtml(request, render, options)
    expect(await concurrent.text()).toBe('old')
    expect(render).toHaveBeenCalledTimes(1)
    complete(html('new'))
    await flush()
    expect(await (await cacheHtml(request, render, options)).text()).toBe('new')
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('retains stale HTML when background rendering fails', async () => {
    await cacheHtml(request, async () => html('old'), options)
    await flush()
    vi.mocked(Date.now).mockReturnValue(1_800_000_901_000)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await (await cacheHtml(request, async () => {
      throw new Error('upstream')
    }, options)).text()).toBe('old')
    await flush()
    expect(entries.has(request.url)).toBe(true)
  })

  it('does not serve stale content beyond the SWR window', async () => {
    await cacheHtml(request, async () => html('old'), options)
    await flush()
    vi.mocked(Date.now).mockReturnValue(1_800_087_301_000)
    expect(await (await cacheHtml(request, async () => html('new'), options)).text()).toBe('new')
  })

  it('keeps rendering available if the cache throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    match.mockRejectedValueOnce(new Error('cache unavailable'))
    put.mockRejectedValueOnce(new Error('quota'))
    expect(await (await cacheHtml(request, async () => html(), options)).text()).toContain('rendered')
    await flush()
    expect(console.warn).toHaveBeenCalledTimes(2)
  })
})
