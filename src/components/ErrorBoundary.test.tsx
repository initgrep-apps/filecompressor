import { describe, expect, it, vi } from 'vitest'
import type React from 'react'
import { render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

function Bomb(): never {
  throw new Error('kaboom')
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>content</div>
      </ErrorBoundary>,
    )
    expect(screen.getByText('content')).toBeInTheDocument()
  })

  it('renders fallback instead of crashing the tree when a child throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByText('kaboom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    expect(screen.queryByText('content')).not.toBeInTheDocument()
    spy.mockRestore()
  })

  it('recovers children after Try again is clicked', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = (await import('@testing-library/user-event')).userEvent.setup()
    let boom = true
    function MaybeBomb(): React.ReactElement {
      if (boom) throw new Error('kaboom')
      return <div>back</div>
    }
    render(
      <ErrorBoundary>
        <MaybeBomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    boom = false
    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(screen.getByText('back')).toBeInTheDocument()
    spy.mockRestore()
  })
})