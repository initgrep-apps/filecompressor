import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UnlistenFn } from '@tauri-apps/api/event'

const handlers: Array<(evt: unknown) => void> = []
const unlisten = vi.fn()

const getCurrentWebviewMock = vi.fn(() => ({
  onDragDropEvent: (h: (evt: unknown) => void) => {
    handlers.push(h)
    return Promise.resolve(unlisten as UnlistenFn)
  },
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: (...args: unknown[]) => getCurrentWebviewMock(...(args as [])),
}))

import { DropZone } from '@/components/DropZone'

function emit(evt: unknown) {
  act(() => {
    for (const h of handlers) h(evt)
  })
}

describe('DropZone', () => {
  beforeEach(() => {
    getCurrentWebviewMock.mockImplementation(() => ({
      onDragDropEvent: (h: (evt: unknown) => void) => {
        handlers.push(h)
        return Promise.resolve(unlisten as UnlistenFn)
      },
    }))
  })

  it('subscription rejection does not crash and browse still works', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    getCurrentWebviewMock.mockImplementation(() => ({
      onDragDropEvent: () => Promise.reject(new Error('no webview')),
    }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<DropZone onBrowse={onBrowse} onDrop={vi.fn()} />)
    await waitFor(() => expect(spy).toHaveBeenCalled())
    spy.mockRestore()
    await user.click(screen.getByRole('button', { name: /drop files/i }))
    expect(onBrowse).toHaveBeenCalled()
  })

  it('getCurrentWebview sync throw logs and leaves component usable', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    getCurrentWebviewMock.mockImplementation(() => {
      throw new Error('no internals')
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<DropZone onBrowse={onBrowse} onDrop={vi.fn()} />)
    await waitFor(() => expect(spy).toHaveBeenCalled())
    spy.mockRestore()
    await user.click(screen.getByRole('button', { name: /drop files/i }))
    expect(onBrowse).toHaveBeenCalled()
  })

  it('calls onDrop with Tauri-provided paths on drop event', async () => {
    const onDrop = vi.fn()
    const onBrowse = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    emit({
      payload: {
        type: 'drop',
        paths: ['/a/b.jpg', '/a/c.mp4'],
        position: { x: 0, y: 0 },
      },
    })
    expect(onDrop).toHaveBeenCalledWith(['/a/b.jpg', '/a/c.mp4'])
  })

  it('ignores enter/over/leave for onDrop', async () => {
    const onDrop = vi.fn()
    render(<DropZone onBrowse={vi.fn()} onDrop={onDrop} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    emit({
      payload: { type: 'enter', paths: ['/a.jpg'], position: { x: 0, y: 0 } },
    })
    emit({ payload: { type: 'over', position: { x: 0, y: 0 } } })
    emit({
      payload: { type: 'drop', paths: ['/a.jpg'], position: { x: 0, y: 0 } },
    })
    emit({ payload: { type: 'leave' } })
    expect(onDrop).toHaveBeenCalledTimes(1)
  })

  it('does not call onDrop when drop has empty paths', async () => {
    const onDrop = vi.fn()
    render(<DropZone onBrowse={vi.fn()} onDrop={onDrop} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    emit({ payload: { type: 'drop', paths: [], position: { x: 0, y: 0 } } })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('sets and clears isDragging visual state', async () => {
    render(<DropZone onBrowse={vi.fn()} onDrop={vi.fn()} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    const zone = screen.getByRole('button', { name: /drop files/i })
    emit({
      payload: { type: 'enter', paths: ['/a.jpg'], position: { x: 0, y: 0 } },
    })
    expect(zone.className).toContain('border-primary')
    emit({ payload: { type: 'leave' } })
    expect(zone.className).not.toContain('border-primary')
  })

  it('click triggers browse', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /drop files/i }))
    expect(onBrowse).toHaveBeenCalled()
  })

  it('Enter and Space trigger browse', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /drop files/i })
    zone.focus()
    await user.keyboard('{Enter}')
    expect(onBrowse).toHaveBeenCalledTimes(1)
    await user.keyboard(' ')
    expect(onBrowse).toHaveBeenCalledTimes(2)
  })

  it('inner browse button fires onBrowse exactly once', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} />)
    await user.click(screen.getByRole('button', { name: 'Browse your files' }))
    expect(onBrowse).toHaveBeenCalledTimes(1)
  })

  it('card click outside the button fires onBrowse exactly once', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} />)
    await user.click(screen.getByText('Drag and drop'))
    expect(onBrowse).toHaveBeenCalledTimes(1)
  })

  it('Enter on focused browse button fires onBrowse exactly once', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} />)
    const btn = screen.getByRole('button', { name: 'Browse your files' })
    btn.focus()
    await user.keyboard('{Enter}')
    expect(onBrowse).toHaveBeenCalledTimes(1)
  })

  it('Space on focused browse button fires onBrowse exactly once', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} />)
    const btn = screen.getByRole('button', { name: 'Browse your files' })
    btn.focus()
    await user.keyboard(' ')
    expect(onBrowse).toHaveBeenCalledTimes(1)
  })
})
