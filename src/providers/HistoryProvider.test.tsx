// Yard — offline batch file compression
// Copyright (C) 2026 Yard Contributors
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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const registry = new Map<string, Set<(e: { payload: unknown }) => void>>()
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    if (!registry.has(event)) registry.set(event, new Set())
    registry.get(event)!.add(handler)
    return Promise.resolve(() => registry.get(event)?.delete(handler))
  }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { HistoryProvider, useHistoryContext } from '@/providers/HistoryProvider'
import { invoke } from '@tauri-apps/api/core'
import type { HistoryFilters, HistoryResponse, HistorySession } from '@/types'

function session(sessionId: string, fileName: string, startedAt: number): HistorySession {
  return {
    sessionId,
    startedAt,
    endedAt: startedAt + 1_000,
    outputFolder: '/out',
    fileCount: 1,
    files: [
      {
        name: fileName,
        path: `/in/${fileName}`,
        outputPath: null,
        category: 'other',
        targetBytes: 100,
        originalSize: 200,
        compressedSize: 100,
        status: 'done',
        qualityUsed: null,
        strategyUsed: null,
        error: null,
        durationMs: 10,
        completedAt: startedAt,
      },
    ],
    outcome: {
      done: 1,
      bestEffort: 0,
      failed: 0,
      cancelled: 0,
      unsupported: 0,
      alreadyUnderTarget: 0,
    },
    totalSavedBytes: 100,
    cancelled: false,
    interrupted: false,
    matchedFiles: null,
  }
}

const sessions = [session('s1', 'alpha.png', 2_000), session('s2', 'beta.png', 1_000)]

const toResponse = (items: HistorySession[]): HistoryResponse => ({
  sessions: items,
  page: 0,
  pageSize: 50,
  totalSessions: items.length,
  totalFiles: items.length,
  summary: {
    sessions: items.length,
    files: items.length,
    savedBytes: 100 * items.length,
    failedFiles: 0,
  },
  outputFolders: ['/out'],
  skippedLines: 0,
})

function mockHistory() {
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const filters = (args as { filters?: HistoryFilters } | undefined)?.filters ?? {}
    const matched = filters.search
      ? sessions.filter((item) => item.files.some((file) => file.name.includes(filters.search!)))
      : sessions
    return toResponse(matched)
  })
}

const searchCalls = () =>
  vi.mocked(invoke).mock.calls.filter(([command, args]) => {
    if (command !== 'get_history') return false
    return (args as { filters?: HistoryFilters }).filters?.search !== undefined
  })

function Probe() {
  const ctx = useHistoryContext()
  return (
    <div>
      <span data-testid="selected">{ctx.selectedSessionId ?? 'none'}</span>
      <span data-testid="expanded">{String(ctx.expanded)}</span>
      <button type="button" onClick={() => ctx.selectSession('s2')}>
        select-second
      </button>
      <button type="button" onClick={() => ctx.setSearchText('  alpha  ')}>
        find-alpha
      </button>
      <button type="button" onClick={() => ctx.setSearchText('missing')}>
        find-missing
      </button>
    </div>
  )
}

const renderProvider = () =>
  render(
    <HistoryProvider>
      <Probe />
    </HistoryProvider>
  )

beforeEach(() => {
  vi.clearAllMocks()
  registry.clear()
})

describe('HistoryProvider', () => {
  it('selects the first session after load', async () => {
    mockHistory()
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('selected')).toHaveTextContent('s1'))
  })

  it('falls back to the first session when the selected one is filtered out', async () => {
    mockHistory()
    const user = userEvent.setup()
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('selected')).toHaveTextContent('s1'))

    await user.click(screen.getByText('select-second'))
    expect(screen.getByTestId('selected')).toHaveTextContent('s2')

    await user.click(screen.getByText('find-alpha'))
    await waitFor(() => expect(screen.getByTestId('selected')).toHaveTextContent('s1'))
  })

  it('clears the selection when no session matches', async () => {
    mockHistory()
    const user = userEvent.setup()
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('selected')).toHaveTextContent('s1'))

    await user.click(screen.getByText('find-missing'))
    await waitFor(() => expect(screen.getByTestId('selected')).toHaveTextContent('none'))
  })

  it('debounces the trimmed search into the filters', async () => {
    mockHistory()
    const user = userEvent.setup()
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('selected')).toHaveTextContent('s1'))

    await user.click(screen.getByText('find-alpha'))
    expect(searchCalls()).toHaveLength(0)

    await waitFor(() => expect(searchCalls()).toHaveLength(1))
    expect(searchCalls()[0][1]).toMatchObject({ filters: { search: 'alpha' }, page: 0 })
  })

  it('starts expanded', async () => {
    mockHistory()
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('expanded')).toHaveTextContent('true'))
  })
})
