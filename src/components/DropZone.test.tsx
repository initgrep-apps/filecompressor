import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UnlistenFn } from '@tauri-apps/api/event'

const handlers: Array<(evt: unknown) => void> = []
const unlisten = vi.fn()

const pushHandler = (h: (evt: unknown) => void) => {
  handlers.push(h)
  return Promise.resolve(unlisten as UnlistenFn)
}

const getCurrentWebviewMock = vi.fn(() => ({ onDragDropEvent: pushHandler }))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: (...args: unknown[]) => getCurrentWebviewMock(...(args as [])),
}))

import { DropZone } from '@/components/DropZone'

const ALL_FORMATS = 'JPEG, PNG, WebP, HEIC, MP4, MOV, PDF, DOCX, XLSX, PPTX'

function emit(evt: unknown) {
  act(() => {
    for (const h of handlers) h(evt)
  })
}

describe('DropZone', () => {
  beforeEach(() => {
    handlers.length = 0
    unlisten.mockClear()
    getCurrentWebviewMock.mockImplementation(() => ({ onDragDropEvent: pushHandler }))
  })

  it('unmounts the webview listener via unlisten after setup resolves', async () => {
    const { unmount } = render(<DropZone onBrowse={vi.fn()} onDrop={vi.fn()} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('unmount before setup resolves still unlistens once once resolved', async () => {
    let resolveSetup!: (fn: () => void) => void
    getCurrentWebviewMock.mockImplementation(() => ({
      onDragDropEvent: (h: (evt: unknown) => void) => {
        handlers.push(h)
        return new Promise<() => void>((resolve) => {
          resolveSetup = resolve
        })
      },
    }))
    const { unmount } = render(<DropZone onBrowse={vi.fn()} onDrop={vi.fn()} />)
    unmount()
    await act(async () => {
      resolveSetup(unlisten as UnlistenFn)
      await Promise.resolve()
    })
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('listener setup failure is caught and the component still renders', async () => {
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

  it('drop event delivers payload paths to onDrop', async () => {
    const paths = ['/a/b.jpg', '/a/c.mp4']
    const onDrop = vi.fn()
    render(<DropZone onBrowse={vi.fn()} onDrop={onDrop} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    emit({ payload: { type: 'drop', paths, position: { x: 0, y: 0 } } })
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDrop).toHaveBeenCalledWith(paths)
  })

  it('rerender with a new onDrop callback delivers paths to the latest callback', async () => {
    const onDrop = vi.fn()
    const onDropNext = vi.fn()
    const { rerender } = render(<DropZone onBrowse={vi.fn()} onDrop={onDrop} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    rerender(<DropZone onBrowse={vi.fn()} onDrop={onDropNext} />)
    emit({ payload: { type: 'drop', paths: ['/a.jpg'], position: { x: 0, y: 0 } } })
    expect(onDrop).not.toHaveBeenCalled()
    expect(onDropNext).toHaveBeenCalledWith(['/a.jpg'])
  })

  it('ignores enter/over/leave for onDrop', async () => {
    const onDrop = vi.fn()
    render(<DropZone onBrowse={vi.fn()} onDrop={onDrop} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    emit({
      payload: { type: 'enter', paths: ['/a.jpg'], position: { x: 0, y: 0 } },
    })
    emit({
      payload: { type: 'over', paths: ['/a.jpg'], position: { x: 0, y: 0 } },
    })
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
    expect(zone.className).toContain('border-dashed')
    expect(zone.className).toContain('border-input')
    emit({
      payload: { type: 'enter', paths: ['/a.jpg'], position: { x: 0, y: 0 } },
    })
    expect(zone.className).toContain('border-dashed')
    expect(zone.className).toContain('border-primary')
    expect(zone.className).toContain('bg-primary/5')
    emit({ payload: { type: 'leave' } })
    expect(zone.className).toContain('border-input')
    expect(zone.className).toContain('bg-muted/30')
    expect(zone.className).not.toContain('border-primary')
    expect(zone.className).not.toContain('bg-primary/5')
  })

  it('empty variant renders heading, browse button, and 10 format pills with per-category tints', () => {
    render(<DropZone onBrowse={vi.fn()} onDrop={vi.fn()} />)
    expect(screen.getByText('Drag and drop files here')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Browse your files' })).toBeInTheDocument()
    expect(screen.getByText('…or click anywhere in this area')).toBeInTheDocument()
    for (const ext of ['JPEG', 'PNG', 'WebP', 'HEIC', 'MP4', 'MOV', 'PDF', 'DOCX', 'XLSX', 'PPTX']) {
      const pill = screen.getByText(ext)
      expect(pill).toBeInTheDocument()
      expect(pill.querySelector('svg')).not.toBeNull()
    }
    expect(screen.getByText('JPEG').className).toContain('text-blue-600')
    expect(screen.getByText('HEIC').className).toContain('text-blue-600')
    expect(screen.getByText('MP4').className).toContain('text-violet-600')
    expect(screen.getByText('MOV').className).toContain('text-violet-600')
    expect(screen.getByText('PDF').className).toContain('text-destructive')
    expect(screen.getByText('DOCX').className).toContain('text-amber-600')
    expect(screen.getByText('XLSX').className).toContain('text-amber-600')
    const surface = screen.getByRole('button', { name: /drop files here or press/i })
    expect(surface).toHaveAttribute('tabindex', '0')
  })

  it('surface click, Enter, and Space each call onBrowse; browse button does not double-fire', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={vi.fn()} />)
    const surface = screen.getByRole('button', { name: /drop files/i })
    await user.click(surface)
    expect(onBrowse).toHaveBeenCalledTimes(1)
    surface.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onBrowse).toHaveBeenCalledTimes(3)
    await user.click(screen.getByRole('button', { name: 'Browse your files' }))
    expect(onBrowse).toHaveBeenCalledTimes(4)
  })

  it('drag enter/over shows Release to add files and N files detected; drag leave restores rest state', async () => {
    render(<DropZone onBrowse={vi.fn()} onDrop={vi.fn()} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    emit({
      payload: {
        type: 'enter',
        paths: ['/a.jpg', '/b.png', '/c.mp4'],
        position: { x: 0, y: 0 },
      },
    })
    expect(screen.getByText('Release to add files')).toBeInTheDocument()
    expect(screen.getByText('3 files detected')).toBeInTheDocument()
    expect(screen.queryByText('Drag and drop files here')).not.toBeInTheDocument()
    emit({ payload: { type: 'over', position: { x: 0, y: 0 } } })
    expect(screen.getByText('3 files detected')).toBeInTheDocument()
    emit({ payload: { type: 'leave' } })
    expect(screen.getByText('Drag and drop files here')).toBeInTheDocument()
    expect(screen.queryByText('Release to add files')).not.toBeInTheDocument()
    expect(screen.queryByText('3 files detected')).not.toBeInTheDocument()
  })

  it('enter without paths falls back to neutral Files detected copy', async () => {
    render(<DropZone onBrowse={vi.fn()} onDrop={vi.fn()} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    emit({ payload: { type: 'enter', position: { x: 0, y: 0 } } })
    expect(screen.getByText('Release to add files')).toBeInTheDocument()
    expect(screen.getByText('Files detected')).toBeInTheDocument()
    emit({ payload: { type: 'leave' } })
    expect(screen.queryByText('Files detected')).not.toBeInTheDocument()
  })

  it('drop event restores rest state without leave', async () => {
    const onDrop = vi.fn()
    render(<DropZone onBrowse={vi.fn()} onDrop={onDrop} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    emit({
      payload: { type: 'enter', paths: ['/a.jpg'], position: { x: 0, y: 0 } },
    })
    expect(screen.getByText('Release to add files')).toBeInTheDocument()
    emit({
      payload: { type: 'drop', paths: ['/a.jpg'], position: { x: 0, y: 0 } },
    })
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Drag and drop files here')).toBeInTheDocument()
    expect(screen.queryByText('Release to add files')).not.toBeInTheDocument()
    expect(screen.queryByText('1 files detected')).not.toBeInTheDocument()
    const zone = screen.getByRole('button', { name: /drop files here or press/i })
    expect(zone.className).toContain('border-input')
    expect(zone.className).toContain('bg-muted/30')
    expect(zone.className).not.toContain('border-primary')
    expect(zone.className).not.toContain('bg-primary/5')
    emit({ payload: { type: 'enter', position: { x: 0, y: 0 } } })
    expect(screen.getByText('Files detected')).toBeInTheDocument()
  })

  it('compact variant renders hero bar with mono formats line and no pills; compact Browse click calls onBrowse', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} compact />)
    expect(screen.getByText('Drop more files here')).toBeInTheDocument()
    expect(screen.getByText('or')).toBeInTheDocument()
    expect(screen.getByText(ALL_FORMATS)).toBeInTheDocument()
    expect(screen.queryByText('JPEG')).not.toBeInTheDocument()
    expect(screen.queryByText('MP4')).not.toBeInTheDocument()
    const surface = screen.getByRole('button', { name: /drop here or press/i })
    expect(surface).toHaveAttribute('tabindex', '0')
    await user.click(screen.getByRole('button', { name: 'Browse' }))
    expect(onBrowse).toHaveBeenCalledTimes(1)
    expect(onDrop).not.toHaveBeenCalled()
    await user.click(surface)
    expect(onBrowse).toHaveBeenCalledTimes(2)
  })

  it('compact variant reacts to drag hover the same way', async () => {
    render(<DropZone onBrowse={vi.fn()} onDrop={vi.fn()} compact />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    emit({
      payload: {
        type: 'enter',
        paths: ['/a.jpg', '/b.mov'],
        position: { x: 0, y: 0 },
      },
    })
    expect(screen.getByText('Release to add files')).toBeInTheDocument()
    expect(screen.getByText('2 files detected')).toBeInTheDocument()
    expect(screen.queryByText('Drop more files here')).not.toBeInTheDocument()
    const surface = screen.getByRole('button', { name: /drop here or press/i })
    expect(surface.className).toContain('bg-primary/5')
    expect(surface.className).not.toContain('border-primary/35')
    emit({ payload: { type: 'leave' } })
    const surfaceAfterLeave = screen.getByRole('button', { name: /drop here or press/i })
    expect(surfaceAfterLeave.className).toContain('border-primary/35')
    expect(surfaceAfterLeave.className).not.toContain('bg-primary/5')
    expect(screen.getByText('Drop more files here')).toBeInTheDocument()
    expect(screen.getByText('or')).toBeInTheDocument()
    expect(screen.getByText(ALL_FORMATS)).toBeInTheDocument()
    expect(screen.queryByText('Release to add files')).not.toBeInTheDocument()
    expect(screen.queryByText('2 files detected')).not.toBeInTheDocument()
  })

  it('card click outside the button fires onBrowse exactly once', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} />)
    await user.click(screen.getByText('Drag and drop files here'))
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

  it('stops Enter/Space keydown on the inner browse button from reaching the card', () => {
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    const onKeyDown = vi.fn()
    render(
      <div onKeyDown={onKeyDown}>
        <DropZone onBrowse={onBrowse} onDrop={onDrop} />
      </div>
    )
    const btn = screen.getByRole('button', { name: 'Browse your files' })
    fireEvent.keyDown(btn, { key: 'Enter' })
    fireEvent.keyDown(btn, { key: ' ' })
    expect(onKeyDown).not.toHaveBeenCalled()
    expect(onBrowse).not.toHaveBeenCalled()
  })

  it('lets non-Enter/Space keys bubble past the inner browse button', () => {
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    const onKeyDown = vi.fn()
    render(
      <div onKeyDown={onKeyDown}>
        <DropZone onBrowse={onBrowse} onDrop={onDrop} />
      </div>
    )
    const btn = screen.getByRole('button', { name: 'Browse your files' })
    fireEvent.keyDown(btn, { key: 'a' })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(btn, { key: 'b', metaKey: true })
    expect(onKeyDown).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(btn, { key: 'Enter' })
    fireEvent.keyDown(btn, { key: ' ' })
    expect(onKeyDown).toHaveBeenCalledTimes(2)
    expect(onBrowse).not.toHaveBeenCalled()
  })
})
