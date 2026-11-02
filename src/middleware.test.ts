import type { APIContext, MiddlewareNext } from 'astro'
import { createContext } from 'astro/middleware'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('astro:middleware', () => ({
  defineMiddleware: <T>(handler: T): T => handler,
}))

const { isHtmlResponse, onRequest, shouldApplyDefaultCache } = await import('./middleware')

afterEach(() => {
  vi.unstubAllGlobals()
})

function pageContext(path: string) {
  const request = new Request(`https://blog.example${path}`)
  return createContext({ request, defaultLocale: 'en' })
}

async function runMiddleware(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const response = await onRequest(context, next)
  if (!response) {
    throw new Error('Expected middleware response')
  }
  return response
}

describe('middleware HTML cache integration', () => {
  it.each(['/', '/before/20', '/after/20', '/posts/20', '/search/result?q=hello'])('skips rendering on a cache hit for %s', async (path) => {
    const match = vi.fn(async () => new Response('cached page', {
      headers: { 'X-BroadcastChannel-Cached-At': String(Date.now()) },
    }))
    vi.stubGlobal('caches', { default: { match } })
    const next = vi.fn(async () => new Response('rendered page'))
    const response = await runMiddleware(pageContext(path), next)
    expect(await response.text()).toBe('cached page')
    expect(next).not.toHaveBeenCalled()
    expect(match.mock.calls.length).toBe(1)
  })

  it('preserves RSS cache headers and bypasses the HTML cache', async () => {
    const match = vi.fn()
    vi.stubGlobal('caches', { default: { match } })
    const response = await runMiddleware(pageContext('/rss.xml'), async () => new Response('<rss/>', {
      headers: { 'Content-Type': 'application/rss+xml', 'Cache-Control': 'public, max-age=3600' },
    }))
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(match).not.toHaveBeenCalled()
  })

  it('adds the new HTML cache headers without requiring Cloudflare globals', async () => {
    vi.stubGlobal('caches', undefined)
    const response = await runMiddleware(pageContext('/'), async () => new Response('<html/>', {
      headers: { 'Content-Type': 'text/html' },
    }))
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=900, stale-while-revalidate=86400')
    expect(response.headers.get('Speculation-Rules')).toBe('"/rules/prefetch.json"')
  })
})

describe('middleware response header helpers', () => {
  it('applies default cache to successful responses without cache headers', () => {
    expect(shouldApplyDefaultCache(new Response('', { status: 200 }))).toBe(true)
  })

  it('applies default cache to redirects without cache headers', () => {
    expect(shouldApplyDefaultCache(new Response('', { status: 302 }))).toBe(true)
  })

  it('does not apply default cache to not found responses', () => {
    expect(shouldApplyDefaultCache(new Response('', { status: 404 }))).toBe(false)
  })

  it('does not apply default cache to upstream error responses', () => {
    expect(shouldApplyDefaultCache(new Response('', { status: 502 }))).toBe(false)
  })

  it('does not replace existing cache headers', () => {
    expect(shouldApplyDefaultCache(new Response('', {
      headers: {
        'Cache-Control': 'private, max-age=0',
      },
      status: 200,
    }))).toBe(false)
  })

  it('detects HTML responses with charset parameters', () => {
    expect(isHtmlResponse(new Response('', {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    }))).toBe(true)
  })
})
