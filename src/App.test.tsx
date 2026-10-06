import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileEntry } from '@/types'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}))

beforeAll(() => {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList
})

import App from '@/App'

const headerEl = () => document.querySelector('main')!.querySelector('header')!

const makeEntry = (n: number): FileEntry => ({
  id: `f${n}`,
  name: `f${n}.jpg`,
  path: `/t/f${n}.jpg`,
  category: 'image',
  targetBytes: 204800,
  originalSize: 1024,
  status: 'pending',
  compressedSize: null,
  outputPath: null,
  error: null,
  strategyUsed: null,
  qualityUsed: null,
})

const menuItemFor = (label: string) => {
  const btn = Array.from(
    document.querySelectorAll('[data-slot="sidebar-menu-button"]')
  ).find((b) => b.textContent?.trim() === label)!
  return btn.closest('[data-slot="sidebar-menu-item"]') as HTMLElement
}

const stubFiveFiles = () => {
  vi.mocked(invoke).mockImplementation((cmd: unknown) =>
    cmd === 'add_files'
      ? Promise.resolve([1, 2, 3, 4, 5].map(makeEntry))
      : Promise.resolve(undefined)
  )
  vi.mocked(open).mockResolvedValueOnce([
    '/t/f1.jpg',
    '/t/f2.jpg',
    '/t/f3.jpg',
    '/t/f4.jpg',
    '/t/f5.jpg',
  ])
}

const emptyHistory = {
  sessions: [],
  page: 0,
  pageSize: 50,
  totalSessions: 0,
  totalFiles: 0,
  summary: { sessions: 0, files: 0, savedBytes: 0, failedFiles: 0 },
  outputFolders: [],
  skippedLines: 0,
}

describe('App shell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockImplementation((cmd: unknown) =>
      cmd === 'get_history' ? Promise.resolve(emptyHistory) : Promise.resolve(undefined)
    )
  })

  it('breadcrumb reflects the active view and updates on navigation', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(within(headerEl()).getByText('Optimizer')).toBeInTheDocument()
    expect(within(headerEl()).getByText('Compress')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(within(headerEl()).getByText('Settings')).toBeInTheDocument()
    expect(within(headerEl()).queryByText('Compress')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'History' }))
    expect(within(headerEl()).getByText('History')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    expect(within(headerEl()).getByText('Compress')).toBeInTheDocument()
  })

  it('sidebar is flush (no floating variant)', () => {
    render(<App />)
    const sidebar = document.querySelector('[data-slot="sidebar"]')
    expect(sidebar).not.toBeNull()
    expect(sidebar!.getAttribute('data-variant')).not.toBe('floating')
  })

  it('content wrapper constrains view height (min-h-0 chain)', () => {
    render(<App />)
    const wrapper = screen.getByTestId('view-container')
    expect(wrapper.className).toContain('min-h-0')
    expect(wrapper.className).toContain('overflow-hidden')
  })

  it('shell wrapper caps the viewport height (4a/4c: h-svh + overflow-hidden)', () => {
    render(<App />)
    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]')
    expect(wrapper).not.toBeNull()
    expect(wrapper!.classList.contains('h-svh')).toBe(true)
    expect(wrapper!.classList.contains('overflow-hidden')).toBe(true)
  })

  it('breadcrumb stays correct while the sidebar is collapsed to icon', async () => {
    const user = userEvent.setup()
    render(<App />)
    const trigger = document.querySelector(
      'button[data-slot="sidebar-trigger"]'
    ) as HTMLElement
    await user.click(trigger)
    expect(within(headerEl()).getByText('Compress')).toBeInTheDocument()
  })

  it('0 files show no Compress badge; 5 files show badge 5', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(
      menuItemFor('Compress').querySelector('[data-slot="sidebar-menu-badge"]')
    ).toBeNull()

    stubFiveFiles()
    await user.click(screen.getByRole('button', { name: /drop files/i }))
    const badge = await screen.findByText('5')
    expect(badge.getAttribute('data-slot')).toBe('sidebar-menu-badge')
    expect(menuItemFor('Compress').contains(badge)).toBe(true)
  })

  it('badge count updates when files are added or removed', async () => {
    const user = userEvent.setup()
    stubFiveFiles()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /drop files/i }))
    expect(await screen.findByText('5')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove f1.jpg' }))
    expect(await screen.findByText('4')).toBeInTheDocument()
    for (const n of [2, 3, 4, 5]) {
      await user.click(screen.getByRole('button', { name: `Remove f${n}.jpg` }))
    }
    expect(
      document.querySelector('[data-slot="sidebar-menu-badge"]')
    ).toBeNull()
    expect(
      menuItemFor('Compress').querySelector('[data-slot="sidebar-menu-badge"]')
    ).toBeNull()
  })

  it('History nav item shows no badge', () => {
    render(<App />)
    expect(
      menuItemFor('History').querySelector('[data-slot="sidebar-menu-badge"]')
    ).toBeNull()
  })

  it('clicking History still switches views (nav regression)', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'History' }))
    expect(within(headerEl()).getByText('History')).toBeInTheDocument()
  })

  it('file list survives navigating to Settings and back (Bug 2a)', async () => {
    const user = userEvent.setup()
    vi.mocked(open).mockResolvedValueOnce('/t/a.jpg')
    vi.mocked(invoke).mockResolvedValueOnce([{ ...makeEntry(1), name: 'a.jpg', path: '/t/a.jpg' }])
    render(<App />)
    await user.click(screen.getByRole('button', { name: /drop files/i }))
    expect(await screen.findByText('a.jpg')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    expect(await screen.findByText('a.jpg')).toBeInTheDocument()
  })

  it('per-view headings are removed from the main region', async () => {
    const user = userEvent.setup()
    render(<App />)
    const main = document.querySelector('main')!
    expect(
      within(main).queryByRole('heading', { name: 'Compress Files' })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(
      within(main).queryByRole('heading', { name: 'Settings' })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'History' }))
    expect(
      within(main).queryByRole('heading', { name: 'History' })
    ).not.toBeInTheDocument()
  })
})
