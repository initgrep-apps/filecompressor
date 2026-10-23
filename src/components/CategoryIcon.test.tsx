import { expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { Category } from '@/types'
import { CATEGORIES } from '@/types'
import { CategoryIcon } from './CategoryIcon'

it.each(CATEGORIES)('renders one %s glyph tagged with its category', (category) => {
  const { container } = render(<CategoryIcon category={category} />)
  expect(container.querySelectorAll('svg')).toHaveLength(1)
  expect(container.querySelector('svg')?.getAttribute('data-category')).toBe(category)
})

it('matches the glyph markup for every category', () => {
  const glyphs = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      render(<CategoryIcon category={category} />).container.innerHTML,
    ])
  )
  expect(glyphs).toMatchInlineSnapshot(`
    {
      "document": "<svg aria-hidden="true" data-category="document" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>",
      "image": "<svg aria-hidden="true" data-category="image" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"></path></svg>",
      "other": "<svg aria-hidden="true" data-category="other" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>",
      "pdf": "<svg aria-hidden="true" data-category="pdf" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>",
      "video": "<svg aria-hidden="true" data-category="video" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"></path><rect x="2" y="6" width="14" height="12" rx="2"></rect></svg>",
    }
  `)
})

it('falls back to the other glyph and warns once for an unknown category', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const otherGlyph = render(<CategoryIcon category="other" />).container.querySelector('svg')?.innerHTML
  const first = render(<CategoryIcon category={'archive' as Category} />).container.querySelector('svg')
  const second = render(<CategoryIcon category={'archive' as Category} />).container.querySelector('svg')

  expect(first?.innerHTML).toBe(otherGlyph)
  expect(second?.innerHTML).toBe(otherGlyph)
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith('unknown category "archive" rendered as other')

  warn.mockRestore()
})

it('defaults to 11px and accepts size and className overrides', () => {
  const { container } = render(<CategoryIcon category="image" />)
  const svg = container.querySelector('svg')
  expect(svg?.getAttribute('width')).toBe('11')
  expect(svg?.getAttribute('height')).toBe('11')

  const { container: overridden } = render(
    <CategoryIcon category="image" size={18} className="text-primary" />
  )
  const overriddenSvg = overridden.querySelector('svg')
  expect(overriddenSvg?.getAttribute('width')).toBe('18')
  expect(overriddenSvg?.getAttribute('height')).toBe('18')
  expect(overriddenSvg?.getAttribute('class')).toBe('text-primary')
})
