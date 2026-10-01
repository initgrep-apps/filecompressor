import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HistoryView } from '@/views/HistoryView'

describe('HistoryView', () => {
  it('renders history empty state', () => {
    render(<HistoryView />)
    expect(screen.getByText('No history yet')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(1)
  })
})
