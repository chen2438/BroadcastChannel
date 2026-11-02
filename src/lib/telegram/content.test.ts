import { load } from 'cheerio'
import { describe, expect, it } from 'vitest'
import { sanitizeContentHtml, sanitizeFeedHtml } from '../sanitize'
import { modifyHTMLContent } from './content'

describe('telegram HTML content', () => {
  it.each([
    '<pre>&lt;script&gt;alert("x")&lt;/script&gt; &amp; x &lt; y<br>next</pre>',
    '<pre data-language="unknown-language">&lt;script&gt;alert("x")&lt;/script&gt; &amp; x &lt; y<br>next</pre>',
  ])('escapes unlabelled or unsupported code as plain text', async (markup) => {
    const $ = load(`<div class="message">${markup}</div>`)
    await modifyHTMLContent($, $('.message'))
    expect($('pre code').text()).toBe('<script>alert("x")</script> & x < y\nnext')
    expect($('pre code').hasClass('language-text')).toBe(true)
    expect($('pre code .token, pre code script').length).toBe(0)
    expect($('pre').html()).toContain('&lt;script&gt;')
  })

  it.each([
    '<pre class="language-python">def greet():<br>    pass</pre>',
    '<pre><code class="language-python">def greet():<br>    pass</code></pre>',
  ])('supports explicit language classes on pre and code', async (markup) => {
    const $ = load(`<div class="message">${markup}</div>`)
    await modifyHTMLContent($, $('.message'))
    expect($('pre code').hasClass('language-python')).toBe(true)
    expect($('pre code .token').length).toBeGreaterThan(0)
  })

  it('emits and preserves the stable code block hooks', async () => {
    const $ = load('<div class="message"><pre data-language="python">def greet(name):<br>    return f"Hello {name}"</pre></div>')
    const content = $('.message')

    await modifyHTMLContent($, content)

    const html = content.html() ?? ''
    const pre = content.find('pre')
    const code = pre.children('code')

    expect(pre.hasClass('code')).toBe(true)
    expect(code.hasClass('language-python')).toBe(true)
    expect(code.find('.token').length).toBeGreaterThan(0)
    expect(sanitizeContentHtml(html)).toContain('<pre class="code"><code class="language-python">')
    expect(sanitizeFeedHtml(html)).toContain('<pre class="code"><code class="language-python">')
    expect(sanitizeFeedHtml(html)).toContain('class="token keyword"')
  })
})
