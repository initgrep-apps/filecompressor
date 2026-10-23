import { expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { CategoryIcon } from './CategoryIcon'

it.each(['image', 'video', 'pdf', 'document', 'other'] as const)(
  'renders one glyph for %s',
  (category) => {
    const { container } = render(<CategoryIcon category={category} />)
    expect(container.querySelectorAll('svg')).toHaveLength(1)
    expect(container.querySelector('svg')?.getAttribute('data-category')).toBe(category)
  }
)
