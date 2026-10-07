// File Size Optimizer — offline batch file compression
// Copyright (C) 2026 File Size Optimizer Contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { HistoryFile, HistoryResponse, HistorySession } from '@/types'

const registry = new Map<string, Set<(e: { payload: unknown }) => void>>()
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    if (!registry.has(event)) registry.set(event, new Set())
    registry.get(event)!.add(handler)
    return Promise.resolve(() => {
      registry.get(event)?.delete(handler)
    })
  }),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { HistoryView } from '@/views/HistoryView'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { CATEGORY_TONES, STATUS_TONES } from '@/lib/tokens'
import { SidebarProvider } from '@/components/ui/sidebar'
import { CapturingResizeObserver, resetCapturedResizeObservers } from '@/test-setup'

const invokeMock = vi.mocked(invoke)

const emptyResponse: HistoryResponse = {
  sessions: [],
  page: 0,
  pageSize: 50,
  totalSessions: 0,
  totalFiles: 0,
  summary: { sessions: 0, files: 0, savedBytes: 0, failedFiles: 0 },
  outputFolders: [],
  skippedLines: 0,
}

function doneFile(overrides: Partial<HistoryFile> = {}): HistoryFile {
  return {
    name: 'a.jpg',
    path: '/in/a.jpg',
    outputPath: '/out/a.jpg',
    category: 'image',
    targetBytes: 204_800,
    originalSize: 1024,
    compressedSize: 512,
    status: 'done',
    qualityUsed: 70,
    strategyUsed: 'quality=70',
    error: null,
    durationMs: 120,
    completedAt: 1,
    ...overrides,
  }
}

function failedFile(overrides: Partial<HistoryFile> = {}): HistoryFile {
  return {
    name: 'broken.pdf',
    path: '/in/broken.pdf',
    outputPath: null,
    category: 'pdf',
    targetBytes: 2_097_152,
    originalSize: 10,
    compressedSize: null,
    status: 'failed',
    qualityUsed: null,
    strategyUsed: null,
    error: 'Cannot read file: locked',
    durationMs: 3,
    completedAt: 2,
    ...overrides,
  }
}

function session(overrides: Partial<HistorySession> = {}): HistorySession {
  const startedAt = overrides.startedAt ?? Date.now()
  return {
    sessionId: 's1',
    startedAt,
    endedAt: startedAt + 45_000,
    outputFolder: '/out',
    fileCount: 2,
    files: [doneFile(), failedFile()],
    outcome: {
      done: 1,
      bestEffort: 0,
      failed: 1,
      cancelled: 0,
      unsupported: 0,
      alreadyUnderTarget: 0,
    },
    totalSavedBytes: 512,
    cancelled: false,
    interrupted: false,
    matchedFiles: null,
    ...overrides,
  }
}

function responseWith(
  sessions: HistorySession[],
  overrides: Partial<HistoryResponse> = {}
): HistoryResponse {
  const totalFiles = sessions.reduce((acc, s) => acc + s.files.length, 0)
  const failedFiles = sessions.reduce(
    (acc, s) => acc + s.files.filter((f) => f.status === 'failed').length,
    0
  )
  const savedBytes = sessions.reduce(
    (acc, s) => acc + s.files.reduce((a, f) => a + (f.compressedSize ?? 0), 0),
    0
  )
  return {
    ...emptyResponse,
    sessions,
    totalSessions: sessions.length,
    totalFiles,
    summary: {
      sessions: sessions.length,
      files: totalFiles,
      savedBytes,
      failedFiles,
    },
    outputFolders: [...new Set(sessions.map((s) => s.outputFolder))],
    ...overrides,
  }
}

const renderView = () =>
  render(
    <SidebarProvider>
      <HistoryView />
    </SidebarProvider>
  )

function pagedResponse(sessions: HistorySession[], totalSessions: number) {
  invokeMock.mockImplementation((_cmd: unknown, args: unknown) =>
    Promise.resolve({
      ...responseWith(sessions),
      totalSessions,
      page: (args as { page: number }).page,
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  registry.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('HistoryView', () => {
  it('renders empty state when history is empty', async () => {
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    expect(await screen.findByText('No history yet')).toBeInTheDocument()
  })

  it('renders history empty state', async () => {
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    const emptyHeader = (await screen.findByText('No history yet')).closest(
      '[data-slot="empty"]'
    )
    expect(emptyHeader).not.toBeNull()
    expect(
      within(emptyHeader as HTMLElement).getByText(
        'Compressed files and their results will appear here.'
      )
    ).toBeInTheDocument()
  })

  it('shows loading skeleton rows', () => {
    invokeMock.mockImplementation(() => new Promise(() => {}))
    const { container } = renderView()
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3)
  })

  it('load error card retries', async () => {
    const user = userEvent.setup()
    invokeMock
      .mockRejectedValueOnce(new Error('disk error'))
      .mockResolvedValue(emptyResponse)
    renderView()
    expect(await screen.findByText(/Could not load history/)).toBeInTheDocument()
    expect(screen.getByText(/disk error/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(await screen.findByText('No history yet')).toBeInTheDocument()
    expect(screen.queryByText(/Could not load history/)).not.toBeInTheDocument()
  })

  it('renders a session row with outcome chips and metrics', async () => {
    invokeMock.mockResolvedValue(responseWith([session({ sessionId: 's1' })]))
    renderView()
    expect(await screen.findByText(/files? ·/)).toBeInTheDocument()
    const toggles = screen.getAllByRole('button', { name: 'Toggle session details' })
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText(/Failed 1/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open output folder' })).toBeEnabled()
  })

  it('groups sessions by day headers', async () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    invokeMock.mockResolvedValue(
      responseWith([
        session({ sessionId: 's1' }),
        session({ sessionId: 's2', startedAt: yesterday.getTime() }),
      ])
    )
    renderView()
    await screen.findByText('Today')
    expect(screen.getByText('Yesterday')).toBeInTheDocument()
  })

  it('expands on keyboard and shows the file table with inline errors', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(
      responseWith([session({ sessionId: 's1', files: [failedFile()] })])
    )
    renderView()
    const toggle = (
      await screen.findAllByRole('button', { name: 'Toggle session details' })
    )[0]
    toggle.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Cannot read file: locked')).toBeInTheDocument()
  })

  it('disclosure space toggles and collapse works', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(responseWith([session({ sessionId: 's1' })]))
    renderView()
    const toggle = (
      await screen.findAllByRole('button', { name: 'Toggle session details' })
    )[0]
    const panelId = toggle.getAttribute('aria-controls')
    expect(panelId).not.toBeNull()
    toggle.focus()
    await user.keyboard('{ }')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(panelId!)).not.toBeNull()
    await user.keyboard('{ }')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows Interrupted chip for interrupted sessions', async () => {
    invokeMock.mockResolvedValue(
      responseWith([session({ interrupted: true, endedAt: null })])
    )
    renderView()
    expect(await screen.findByText('Interrupted')).toBeInTheDocument()
    const metrics = await screen.findByText(/files? ·/)
    expect(metrics.textContent).toContain('saved · —')
  })

  it('shows Cancelled chip for cancelled sessions', async () => {
    invokeMock.mockResolvedValue(responseWith([session({ cancelled: true })]))
    renderView()
    expect(
      await screen.findByText('Cancelled', { selector: 'span[data-slot="badge"]' })
    ).toBeInTheDocument()
  })

  it('search input debounces into a filtered query', async () => {
    vi.useFakeTimers()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const input = screen.getByRole('textbox', { name: /search/i })
    await act(async () => {
      fireEvent.change(input, { target: { value: 'photo' } })
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ filters: { search: 'photo' }, page: 0 })
    )
  })

  it('esc clears search', async () => {
    vi.useFakeTimers()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const input = screen.getByRole('textbox', { name: /search/i })
    await act(async () => {
      fireEvent.change(input, { target: { value: 'photo' } })
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ filters: { search: 'photo' }, page: 0 })
    )
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ filters: {}, page: 0 })
    )
  })

  it('status chips produce payload and aria-pressed', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    const chip = await screen.findByRole('button', { name: 'Failed' })
    await user.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({
        filters: { statuses: ['failed'] },
        page: 0,
      })
    )
    await user.click(screen.getByRole('button', { name: 'Failed' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ filters: {} })
    )
  })

  it('multi chip un-toggle keeps per-group payloads', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    await user.click(await screen.findByRole('button', { name: 'Failed' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ filters: { statuses: ['failed'] }, page: 0 })
    )
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ filters: { statuses: ['failed', 'done'] }, page: 0 })
    )
    await user.click(screen.getByRole('button', { name: 'Failed' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ filters: { statuses: ['done'] }, page: 0 })
    )
    await user.click(screen.getByRole('button', { name: 'PDF' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({
        filters: { statuses: ['done'], categories: ['pdf'] },
        page: 0,
      })
    )
    await user.click(screen.getByRole('button', { name: 'Image' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({
        filters: { statuses: ['done'], categories: ['pdf', 'image'] },
        page: 0,
      })
    )
    await user.click(screen.getByRole('button', { name: 'PDF' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({
        filters: { statuses: ['done'], categories: ['image'] },
        page: 0,
      })
    )
  })

  it('category chip produces payload and pressed state', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    const chip = await screen.findByRole('button', { name: 'PDF' })
    await user.click(chip)
    expect(screen.getByRole('button', { name: 'PDF' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ filters: { categories: ['pdf'] }, page: 0 })
    )
  })

  it('date preset maps to sinceMs payload', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    await user.click(screen.getByLabelText('Date range'))
    await user.click(await screen.findByRole('option', { name: 'Today' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({
        filters: expect.objectContaining({ sinceMs: expect.anything() }),
        page: 0,
      })
    )
    await user.click(screen.getByLabelText('Date range'))
    await user.click(await screen.findByRole('option', { name: 'All time' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ filters: {} })
    )
  })

  it('output folder select produces payload', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(responseWith([session({ sessionId: 's1' })]))
    renderView()
    await screen.findByText(/files? ·/)
    await user.click(screen.getByLabelText('Output folder'))
    await user.click(await screen.findByRole('option', { name: '/out' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({
        filters: { outputFolder: '/out' },
        page: 0,
      })
    )
    await user.click(screen.getByLabelText('Output folder'))
    await user.click(await screen.findByRole('option', { name: 'All folders' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ filters: {} })
    )
  })

  it('clear filters resets all and page', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    await user.click(await screen.findByRole('button', { name: 'Failed' }))
    expect(await screen.findByText('1 active')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: /search/i }), 'x')
    await waitFor(() => expect(screen.getByText('2 active')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.queryByText(/active/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ filters: {}, page: 0 })
    )
  })

  it('filter change resets page from pagination', async () => {
    const user = userEvent.setup()
    pagedResponse([session({ sessionId: 's1' })], 120)
    renderView()
    await screen.findByText(/files? ·/)
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenLastCalledWith(
        'get_history',
        expect.objectContaining({ page: 1 })
      )
    )
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenLastCalledWith(
        'get_history',
        expect.objectContaining({ page: 2 })
      )
    )
    await user.click(screen.getByRole('button', { name: 'Failed' }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ page: 0, filters: { statuses: ['failed'] } })
    )
  })

  it('renders pagination and requests next page', async () => {
    const user = userEvent.setup()
    pagedResponse([session({ sessionId: 's1' })], 120)
    renderView()
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(invokeMock).toHaveBeenLastCalledWith(
      'get_history',
      expect.objectContaining({ page: 1 })
    )
  })

  it('pagination prev next bounds', async () => {
    const user = userEvent.setup()
    pagedResponse([session({ sessionId: 's1' })], 120)
    renderView()
    await screen.findByText(/files? ·/)
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenLastCalledWith(
        'get_history',
        expect.objectContaining({ page: 1 })
      )
    )
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenLastCalledWith(
        'get_history',
        expect.objectContaining({ page: 2 })
      )
    )
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })

  it('summary bar renders response summary', async () => {
    invokeMock.mockResolvedValue({
      ...responseWith([session({ sessionId: 's1' })]),
      summary: { sessions: 5, files: 40, savedBytes: 1_073_741_824, failedFiles: 9 },
    })
    renderView()
    expect(await screen.findByText('5 sessions')).toBeInTheDocument()
    expect(screen.getByText('40 files')).toBeInTheDocument()
    expect(screen.getByText('1.00 GB saved')).toBeInTheDocument()
    expect(screen.getByText('9 failed')).toBeInTheDocument()
  })

  it('summary shows 0 B when no bytes saved', async () => {
    invokeMock.mockResolvedValue({
      ...emptyResponse,
      summary: { sessions: 1, files: 1, savedBytes: 0, failedFiles: 1 },
    })
    renderView()
    expect(await screen.findByText('0 B saved')).toBeInTheDocument()
  })

  it('auto-expands filtered sessions with match count', async () => {
    invokeMock.mockResolvedValue(
      responseWith([
        session({
          sessionId: 's1',
          matchedFiles: 2,
          files: [doneFile(), doneFile({ name: 'b.jpg', path: '/in/b.jpg', outputPath: '/out/b.jpg' })],
          outcome: { done: 1, bestEffort: 0, failed: 1, cancelled: 0, unsupported: 0, alreadyUnderTarget: 0 },
        }),
      ])
    )
    renderView()
    expect(await screen.findByText('2 matches')).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Done 2')).toBeInTheDocument()
    expect(screen.queryByText('Failed 1')).not.toBeInTheDocument()
  })

  it('clamps saved percent at zero when file grew', async () => {
    invokeMock.mockResolvedValue(
      responseWith([
        session({
          sessionId: 's1',
          matchedFiles: 1,
          files: [doneFile({ originalSize: 1024, compressedSize: 2048 })],
        }),
      ])
    )
    renderView()
    expect(await screen.findByText('1 KB → 2 KB · 0%')).toBeInTheDocument()
    expect(screen.queryByText(/· -\d+%/)).not.toBeInTheDocument()
  })

  it('shows plural match count', async () => {
    invokeMock.mockResolvedValue(
      responseWith([
        session({
          sessionId: 's1',
          matchedFiles: 3,
          files: [
            doneFile(),
            doneFile({ name: 'b.jpg', path: '/in/b.jpg', outputPath: '/out/b.jpg' }),
            doneFile({ name: 'c.jpg', path: '/in/c.jpg', outputPath: '/out/c.jpg' }),
          ],
        }),
      ])
    )
    renderView()
    expect(await screen.findByText('3 matches')).toBeInTheDocument()
  })

  it('session level matches stay collapsed and show all files when opened', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(
      responseWith([
        session({
          sessionId: 's1',
          fileCount: 2,
          files: [doneFile(), failedFile({ name: 'b.jpg', path: '/in/b.jpg' })],
        }),
      ])
    )
    renderView()
    const toggle = (
      await screen.findAllByRole('button', { name: 'Toggle session details' })
    )[0]
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(
      await screen.findByRole('table', { name: 'Session files' })
    ).toBeInTheDocument()
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
    expect(screen.getByText('b.jpg')).toBeInTheDocument()
  })

  it('user toggle overrides auto expand', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(
      responseWith([session({ sessionId: 's1', matchedFiles: 1, files: [doneFile()] })])
    )
    renderView()
    expect(await screen.findByRole('table')).toBeInTheDocument()
    const toggle = screen.getAllByRole('button', { name: 'Toggle session details' })[0]
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows no matches state with clear filters', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    await user.click(await screen.findByRole('button', { name: 'Failed' }))
    expect(await screen.findByText('No matches')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByText('No history yet')).toBeInTheDocument()
  })

  it('clear history confirms before invoking', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    await user.click(await screen.findByRole('button', { name: /clear history/i }))
    await user.click(screen.getByRole('button', { name: /delete history/i }))
    expect(invokeMock).toHaveBeenCalledWith('clear_history')
  })

  it('clear history cancel does not invoke', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    await user.click(await screen.findByRole('button', { name: /clear history/i }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(invokeMock).not.toHaveBeenCalledWith('clear_history')
  })

  it('copy output path writes clipboard and toasts', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    invokeMock.mockResolvedValue(
      responseWith([session({ sessionId: 's1', matchedFiles: 1, files: [doneFile()] })])
    )
    renderView()
    await user.click(await screen.findByRole('button', { name: 'Copy output path' }))
    expect(writeText).toHaveBeenCalledWith('/out/a.jpg')
    expect(toast.success).toHaveBeenCalledWith('Path copied')
  })

  it('copy source path writes clipboard and toasts', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    invokeMock.mockResolvedValue(
      responseWith([session({ sessionId: 's1', matchedFiles: 1, files: [doneFile()] })])
    )
    renderView()
    await user.click(await screen.findByRole('button', { name: 'Copy source path' }))
    expect(writeText).toHaveBeenCalledWith('/in/a.jpg')
    expect(toast.success).toHaveBeenCalledWith('Path copied')
  })

  it('open output folder invokes with session folder', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(
      responseWith([
        session({ sessionId: 's1', outputFolder: '/session-out', files: [doneFile()] }),
      ])
    )
    renderView()
    const button = await screen.findByRole('button', { name: 'Open output folder' })
    expect(button).toBeEnabled()
    await user.click(button)
    expect(invokeMock).toHaveBeenCalledWith('open_folder', { path: '/session-out' })
  })

  it('open output folder disabled when session lacks outputs', async () => {
    invokeMock.mockResolvedValue(
      responseWith([session({ sessionId: 's1', files: [failedFile()] })])
    )
    renderView()
    expect(await screen.findByRole('button', { name: 'Open output folder' })).toBeDisabled()
  })

  it('reveal actions invoke with correct paths', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(responseWith([session({ sessionId: 's1', files: [doneFile()] })]))
    renderView()
    const toggle = (
      await screen.findAllByRole('button', { name: 'Toggle session details' })
    )[0]
    await user.click(toggle)
    await user.click(await screen.findByRole('button', { name: 'Reveal output' }))
    expect(invokeMock).toHaveBeenCalledWith('reveal_in_folder', {
      filePath: '/out/a.jpg',
    })
    await user.click(screen.getByRole('button', { name: 'Reveal source' }))
    expect(invokeMock).toHaveBeenCalledWith('reveal_in_folder', {
      filePath: '/in/a.jpg',
    })
  })

  it('reveal failure toasts', async () => {
    const user = userEvent.setup()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    invokeMock
      .mockResolvedValueOnce(
        responseWith([session({ sessionId: 's1', matchedFiles: 1, files: [doneFile()] })])
      )
      .mockRejectedValueOnce(new Error('gone'))
      .mockRejectedValueOnce('locked')
      .mockResolvedValue(emptyResponse)
    renderView()
    await user.click(await screen.findByRole('button', { name: 'Reveal output' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not open folder: gone')
    )
    await user.click(screen.getByRole('button', { name: 'Reveal output' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not open folder: locked')
    )
    errSpy.mockRestore()
  })

  it('open folder failure toasts', async () => {
    const user = userEvent.setup()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    invokeMock.mockImplementation((cmd: unknown) =>
      cmd === 'open_folder'
        ? Promise.reject(new Error('explorer died'))
        : Promise.resolve(
            responseWith([
              session({ sessionId: 's1', outputFolder: '/session-out', files: [doneFile()] }),
            ])
          )
    )
    renderView()
    await user.click(await screen.findByRole('button', { name: 'Open output folder' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not open folder: explorer died')
    )
    errSpy.mockRestore()
  })

  it('actions disabled without output path', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(
      responseWith([session({ sessionId: 's1', files: [failedFile()] })])
    )
    renderView()
    const toggle = (
      await screen.findAllByRole('button', { name: 'Toggle session details' })
    )[0]
    await user.click(toggle)
    expect(
      await screen.findByRole('table', { name: 'Session files' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reveal output' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Copy output path' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reveal source' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Copy source path' })).toBeEnabled()
  })

  it('copy failure toasts', async () => {
    const user = userEvent.setup()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    invokeMock.mockResolvedValue(
      responseWith([session({ sessionId: 's1', matchedFiles: 1, files: [doneFile()] })])
    )
    renderView()
    await user.click(await screen.findByRole('button', { name: 'Copy output path' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy path'))
    errSpy.mockRestore()
  })

  it('shows a notice when lines were skipped', async () => {
    invokeMock.mockResolvedValue({ ...emptyResponse, skippedLines: 3 })
    renderView()
    expect(
      await screen.findByText('Some history entries could not be read.')
    ).toBeInTheDocument()
  })

  describe('tone contract', () => {
    it('done filter chip is tone-matched, not gray', async () => {
      const user = userEvent.setup()
      invokeMock.mockResolvedValue(emptyResponse)
      renderView()
      const chip = await screen.findByRole('button', { name: 'Done' })
      await user.click(chip)
      expect(chip).toHaveAttribute('aria-pressed', 'true')
      expect(chip).toHaveClass(
        STATUS_TONES.done.tint,
        STATUS_TONES.done.border,
        STATUS_TONES.done.text
      )
      expect(chip).not.toHaveClass('bg-secondary')
      expect(chip.className).not.toContain('dark:bg-transparent')
    })

    it('all-zero outcome session renders no accent bar', async () => {
      invokeMock.mockResolvedValue(
        responseWith([
          session({
            files: [],
            matchedFiles: null,
            outcome: {
              done: 0,
              bestEffort: 0,
              failed: 0,
              cancelled: 0,
              unsupported: 0,
              alreadyUnderTarget: 0,
            },
          }),
        ])
      )
      renderView()
      await screen.findAllByRole('button', { name: 'Toggle session details' })
      expect(screen.queryByTestId('session-accent')).not.toBeInTheDocument()
    })

    it('session card shows accent bar colored by dominant outcome', async () => {
      invokeMock.mockResolvedValue(
        responseWith([
          session({
            files: [
              doneFile(),
              doneFile({ name: 'b.jpg', path: '/in/b.jpg', outputPath: '/out/b.jpg' }),
            ],
            outcome: {
              done: 2,
              bestEffort: 0,
              failed: 0,
              cancelled: 0,
              unsupported: 0,
              alreadyUnderTarget: 0,
            },
          }),
        ])
      )
      renderView()
      const accent = await screen.findByTestId('session-accent')
      expect(accent).toHaveClass(STATUS_TONES.done.accent)
      expect(accent).not.toHaveClass(STATUS_TONES.failed.accent)
    })

    it('tie between outcomes resolves by safety precedence', async () => {
      invokeMock.mockResolvedValue(responseWith([session()]))
      renderView()
      const accent = await screen.findByTestId('session-accent')
      expect(accent).toHaveClass(STATUS_TONES.failed.accent)
      expect(accent).not.toHaveClass(STATUS_TONES.done.accent)
    })

    it('best-effort dominant session shows amber accent', async () => {
      invokeMock.mockResolvedValue(
        responseWith([
          session({
            files: [
              doneFile(),
              doneFile({ name: 'b.jpg', path: '/in/b.jpg', outputPath: '/out/b.jpg', status: 'best_effort' }),
              doneFile({ name: 'c.jpg', path: '/in/c.jpg', outputPath: '/out/c.jpg', status: 'best_effort' }),
            ],
            outcome: {
              done: 1,
              bestEffort: 2,
              failed: 0,
              cancelled: 0,
              unsupported: 0,
              alreadyUnderTarget: 0,
            },
          }),
        ])
      )
      renderView()
      const accent = await screen.findByTestId('session-accent')
      expect(accent).toHaveClass(STATUS_TONES.best_effort.accent)
      expect(accent).not.toHaveClass(STATUS_TONES.done.accent)
    })

    it('outcome badges are tinted', async () => {
      invokeMock.mockResolvedValue(responseWith([session()]))
      renderView()
      const failedBadge = (await screen.findByText('Failed 1')).closest(
        '[data-slot="badge"]'
      )
      expect(failedBadge).toHaveClass(
        STATUS_TONES.failed.tint,
        STATUS_TONES.failed.border,
        STATUS_TONES.failed.text
      )
      const doneBadge = screen.getByText('Done 1').closest('[data-slot="badge"]')
      expect(doneBadge).toHaveClass(
        STATUS_TONES.done.tint,
        STATUS_TONES.done.border,
        STATUS_TONES.done.text
      )
    })

    it('category badges tinted in session file table', async () => {
      const user = userEvent.setup()
      invokeMock.mockResolvedValue(responseWith([session()]))
      renderView()
      const toggle = (
        await screen.findAllByRole('button', { name: 'Toggle session details' })
      )[0]
      await user.click(toggle)
      const table = await screen.findByRole('table', { name: 'Session files' })
      const imageBadge = within(table).getByText('Image').closest('[data-slot="badge"]')
      expect(imageBadge).toHaveClass(
        CATEGORY_TONES.image.tint,
        CATEGORY_TONES.image.border,
        CATEGORY_TONES.image.text
      )
      const pdfBadge = within(table).getByText('PDF').closest('[data-slot="badge"]')
      expect(pdfBadge).toHaveClass(
        CATEGORY_TONES.pdf.tint,
        CATEGORY_TONES.pdf.border,
        CATEGORY_TONES.pdf.text
      )
    })
  })

  it('auto-collapse observes the history content card, not the clipped wrapper', async () => {
    invokeMock.mockResolvedValue(emptyResponse)
    resetCapturedResizeObservers()
    renderView()
    await screen.findByText('No history yet')
    const targets = CapturingResizeObserver.instances.flatMap((o) => o.observed)
    const card = targets.find((el) => el.getAttribute('data-slot') === 'card')
    expect(card).toBeDefined()
    const clipped = targets.filter(
      (el) => el !== card && el.className.includes('overflow-hidden')
    )
    expect(clipped).toEqual([])
  })
})
