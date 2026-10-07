import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { Settings } from '@/types'

import { CATEGORY_TONES } from '@/lib/tokens'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

import { SettingsView } from '@/views/SettingsView'
import { SidebarProvider } from '@/components/ui/sidebar'
import { CapturingResizeObserver, resetCapturedResizeObservers } from '@/test-setup'

const renderSettings = () =>
  render(
    <SidebarProvider>
      <SettingsView />
    </SidebarProvider>
  )

const baseSettings: Settings = {
  outputFolder: '/Users/test/Documents/Compressed',
  categoryTargets: {
    image: { size: 200, unit: 'KB' },
    video: { size: 10, unit: 'MB' },
    pdf: { size: 2, unit: 'MB' },
    document: { size: 1, unit: 'MB' },
  },
  qualityFloors: {
    image: { minQuality: 30 },
    video: { minCrf: 28, minResolution: '480p' },
    pdf: { minDpi: 72, minJpegQuality: 15 },
    document: { minMediaQuality: 40 },
  },
  performance: { maxConcurrent: 'auto' },
  history: { retentionDays: 90 },
}

const resetDefaults: Settings = {
  ...baseSettings,
  outputFolder: '/defaults/Compressed',
}

const loadView = async () => {
  renderSettings()
  await screen.findByLabelText('Images target size')
}

async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  triggerLabel: string,
  option: string,
) {
  await user.click(screen.getByLabelText(triggerLabel))
  await user.click(await screen.findByRole('option', { name: option }))
}

beforeEach(() => {
  vi.mocked(invoke).mockReset()
  vi.mocked(open).mockReset()
  vi.mocked(invoke).mockResolvedValue(structuredClone(baseSettings))
})

describe('SettingsView', () => {
  it('shows loading state while settings load', () => {
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {}))
    renderSettings()
    expect(screen.getByText('Loading settings…')).toBeInTheDocument()
  })

  it('renders output folder, 4 category rows with badge + formats hint, unit selectors', async () => {
    await loadView()
    expect(screen.getByText('/Users/test/Documents/Compressed')).toBeInTheDocument()
    expect(screen.getByText('Image')).toBeInTheDocument()
    expect(screen.getByText('Images')).toBeInTheDocument()
    expect(screen.getAllByText('PDF')).toHaveLength(2)
    expect(screen.getByText('Document')).toBeInTheDocument()
    expect(screen.getByText('Documents')).toBeInTheDocument()
    expect(screen.getByText('JPEG, PNG, WebP, HEIC')).toBeInTheDocument()
    expect(screen.getByText('MP4, MOV')).toBeInTheDocument()
    expect(screen.getByText('PDF documents')).toBeInTheDocument()
    expect(screen.getByText('DOCX, XLSX, PPTX')).toBeInTheDocument()
    expect(screen.getAllByRole('combobox')).toHaveLength(5)
    expect(screen.getByLabelText('Images target size')).toHaveDisplayValue('200')
    expect(screen.getByLabelText('Videos target size')).toHaveDisplayValue('10')
    expect(screen.getByLabelText('PDF target size')).toHaveDisplayValue('2')
    expect(screen.getByLabelText('Documents target size')).toHaveDisplayValue('1')
    expect(screen.getByLabelText('Images target unit')).toHaveTextContent('KB')
    expect(screen.getByLabelText('Videos target unit')).toHaveTextContent('MB')
    expect(screen.getByLabelText('PDF target unit')).toHaveTextContent('MB')
    expect(screen.getByLabelText('Documents target unit')).toHaveTextContent('MB')
  })

  it('quality floors collapsed by default', async () => {
    await loadView()
    expect(screen.getByText(/Quality Floors/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Images minimum quality')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Videos minimum CRF')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Videos minimum resolution')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('PDF minimum DPI')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('PDF minimum JPEG quality')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Documents media quality')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /advanced/i }))
    expect(await screen.findByLabelText('Images minimum quality')).toHaveDisplayValue('30')
    expect(screen.getByLabelText('Videos minimum CRF')).toHaveDisplayValue('28')
    expect(screen.getByLabelText('Videos minimum resolution')).toHaveTextContent('480p')
    expect(screen.getByLabelText('PDF minimum DPI')).toHaveDisplayValue('72')
    expect(screen.getByLabelText('PDF minimum JPEG quality')).toHaveDisplayValue('15')
    expect(screen.getByLabelText('Documents media quality')).toHaveDisplayValue('40')
  })

  it('disables Save and Cancel until draft differs', async () => {
    await loadView()
    const save = screen.getByRole('button', { name: 'Save Changes' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(save).toBeDisabled()
    expect(cancel).toBeDisabled()
    await userEvent.setup().type(screen.getByLabelText('Images target size'), '5')
    expect(save).toBeEnabled()
    expect(cancel).toBeEnabled()
  })

  it('save calls saveSettings with current draft', async () => {
    await loadView()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Images target size'), '5')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('save_settings', expect.anything())
    })
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'save_settings')
    expect(call?.[1]).toEqual({
      settings: {
        ...baseSettings,
        categoryTargets: { ...baseSettings.categoryTargets, image: { size: 2005, unit: 'KB' } },
      },
    })
  })

  it('changing unit updates save payload', async () => {
    await loadView()
    const user = userEvent.setup()
    await pickOption(user, 'Images target unit', 'MB')
    await user.type(screen.getByLabelText('Images target size'), '5')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('save_settings', expect.anything())
    })
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'save_settings')
    const saved = (call?.[1] as { settings: Settings }).settings
    expect(saved.categoryTargets.image).toEqual({ size: 2005, unit: 'MB' })
  })

  it('shows error banner when save fails and keeps draft', async () => {
    vi.mocked(invoke).mockImplementation((command: string) =>
      command === 'save_settings'
        ? Promise.reject(new Error('disk full'))
        : Promise.resolve(structuredClone(baseSettings)),
    )
    await loadView()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Images target size'), '5')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not save settings: disk full',
    )
    const raw = screen.getByLabelText<HTMLInputElement>('Images target size')
    expect(raw.value.replace(/\D/g, '')).toBe('2005')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled()
  })

  it('cancel reverts draft to last saved settings', async () => {
    await loadView()
    const user = userEvent.setup()
    const img = screen.getByLabelText('Images target size')
    await user.type(img, '5')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(img).toHaveDisplayValue('200')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('reset to defaults replaces draft and disables save', async () => {
    vi.mocked(invoke).mockImplementation((command: string) =>
      command === 'reset_settings'
        ? Promise.resolve(structuredClone(resetDefaults))
        : Promise.resolve(structuredClone(baseSettings)),
    )
    await loadView()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Images target size'), '5')
    await user.click(screen.getByText('Reset to defaults'))
    expect(await screen.findByText('/defaults/Compressed')).toBeInTheDocument()
    expect(screen.getByLabelText('Images target size')).toHaveDisplayValue('200')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('reset_settings')
  })

  it('browse updates output folder in draft only', async () => {
    vi.mocked(open).mockResolvedValue('/picked/folder')
    await loadView()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Browse' }))
    expect(await screen.findByText('/picked/folder')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled()
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('save_settings', expect.anything())
  })

  it('browse cancel leaves draft unchanged', async () => {
    vi.mocked(open).mockResolvedValue(null)
    await loadView()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(vi.mocked(open)).toHaveBeenCalled())
    expect(screen.getByText('/Users/test/Documents/Compressed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  })

  it('empty target input reverts to last valid value on blur and keeps Save disabled', async () => {
    await loadView()
    const user = userEvent.setup()
    const img = screen.getByLabelText('Images target size')
    await user.clear(img)
    await user.tab()
    expect(img).toHaveDisplayValue('200')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  })

  it('renders default KB target row for missing category key', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...baseSettings,
      categoryTargets: { image: { size: 200, unit: 'KB' } },
    })
    await loadView()
    expect(screen.getAllByRole('combobox')).toHaveLength(5)
    expect(screen.getByLabelText('Videos target size')).toHaveDisplayValue('0')
    expect(screen.getByLabelText('Videos target unit')).toHaveTextContent('KB')
    expect(screen.getByLabelText('PDF target size')).toHaveDisplayValue('0')
    expect(screen.getByLabelText('Documents target size')).toHaveDisplayValue('0')
    expect(screen.getByLabelText('Documents target unit')).toHaveTextContent('KB')
  })

  it('updates nested quality floors', async () => {
    await loadView()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /advanced/i }))
    const minQuality = await screen.findByLabelText('Images minimum quality')
    await user.clear(minQuality)
    await user.type(minQuality, '45')
    const minCrf = screen.getByLabelText('Videos minimum CRF')
    await user.clear(minCrf)
    await user.type(minCrf, '35')
    await pickOption(user, 'Videos minimum resolution', '720p')
    const minDpi = screen.getByLabelText('PDF minimum DPI')
    await user.clear(minDpi)
    await user.type(minDpi, '96')
    const minJpeg = screen.getByLabelText('PDF minimum JPEG quality')
    await user.clear(minJpeg)
    await user.type(minJpeg, '25')
    const minMedia = screen.getByLabelText('Documents media quality')
    await user.clear(minMedia)
    await user.type(minMedia, '50')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('save_settings', expect.anything())
    })
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'save_settings')
    const saved = (call?.[1] as { settings: Settings }).settings
    expect(saved.qualityFloors).toEqual({
      image: { minQuality: 45 },
      video: { minCrf: 35, minResolution: '720p' },
      pdf: { minDpi: 96, minJpegQuality: 25 },
      document: { minMediaQuality: 50 },
    })
    expect(saved.outputFolder).toBe('/Users/test/Documents/Compressed')
  })

  it('settings footer is sibling of the scroll region (pinned, 4a)', async () => {
    await loadView()
    const footer = screen.getByRole('button', { name: 'Save Changes' }).closest(
      '.shrink-0.border-t',
    )
    const scrollRegion = footer!.previousElementSibling!
    expect(scrollRegion.className).toContain('overflow-y-auto')
    expect(scrollRegion.contains(footer)).toBe(false)
  })

  it('renders five cards with card composition', async () => {
    await loadView()
    expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(5)
    expect(screen.getByText('Output Folder')).toBeInTheDocument()
    expect(screen.getByText('Category Targets')).toBeInTheDocument()
    expect(screen.getByText('Performance')).toBeInTheDocument()
    expect(screen.getByText('Quality Floors')).toBeInTheDocument()
    expect(screen.getByText('History')).toBeInTheDocument()
  })

  it('stepper buttons step ±1 and mark the draft dirty', async () => {
    await loadView()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Increase Images target size' }))
    expect(screen.getByLabelText('Images target size')).toHaveDisplayValue('201')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled()
  })

  it('target size stepper has no upper cap (no 4096 ceiling)', async () => {
    vi.mocked(invoke).mockResolvedValue(structuredClone({
      ...baseSettings,
      categoryTargets: { ...baseSettings.categoryTargets, image: { size: 4096, unit: 'KB' } },
    }))
    await loadView()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Increase Images target size' }))
    expect(screen.getByLabelText('Images target size')).toHaveDisplayValue('4,097')
    expect(screen.getByRole('button', { name: 'Increase Images target size' })).toBeEnabled()
  })

  it('no native number inputs or select elements remain', async () => {
    const { container } = renderSettings()
    await screen.findByLabelText('Images target size')
    expect(
      container.querySelectorAll('input[type="number"]:not([aria-hidden="true"]), select'),
    ).toHaveLength(0)
  })

  it('mismatched persisted select value stays raw and does not dirty the draft', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      structuredClone({
        ...baseSettings,
        qualityFloors: {
          ...baseSettings.qualityFloors,
          video: { ...baseSettings.qualityFloors.video, minResolution: '1280x720' },
        },
      })
    )
    await loadView()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /advanced/i }))
    const trigger = await screen.findByLabelText('Videos minimum resolution')
    expect(trigger).toHaveTextContent('1280x720')
    await user.click(trigger)
    await screen.findByRole('option', { name: '480p' })
    await user.keyboard('{Escape}')
    expect(trigger).toHaveTextContent('1280x720')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  })

  it('performance select renders four options', async () => {
    await loadView()
    const user = userEvent.setup()
    await user.click(screen.getByLabelText('Simultaneous files'))
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Auto',
      '1',
      '2',
      '3',
    ])
  })

  it('changing performance updates draft and enables save', async () => {
    await loadView()
    const user = userEvent.setup()
    await pickOption(user, 'Simultaneous files', '2')
    const save = screen.getByRole('button', { name: 'Save Changes' })
    expect(save).toBeEnabled()
    await user.click(save)
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('save_settings', expect.anything())
    })
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'save_settings')
    const saved = (call?.[1] as { settings: Settings }).settings
    expect(saved.performance.maxConcurrent).toBe('2')
  })

  it('renders history card after quality floors', async () => {
    await loadView()
    const cards = Array.from(document.querySelectorAll('[data-slot="card"]'))
    const titles = cards.map(
      (card) => card.querySelector('[data-slot="card-title"]')?.textContent,
    )
    expect(titles).toEqual([
      'Output Folder',
      'Category Targets',
      'Performance',
      'Quality Floors',
      'History',
    ])
    expect(
      screen.getByText(
        'Sessions older than this are removed automatically. Files on disk are never deleted.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('History retention (days)')).toHaveDisplayValue('90')
    expect(screen.getByText('History retention (days)')).toHaveAttribute('for', 'history-retention-days')
    expect(screen.getByLabelText('History retention (days)')).toHaveAttribute(
      'id',
      'history-retention-days',
    )
  })

  it('saves a changed history retention value', async () => {
    const user = userEvent.setup()
    await loadView()
    const input = screen.getByLabelText('History retention (days)')
    expect(input).toHaveDisplayValue('90')
    await user.clear(input)
    await user.type(input, '30')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('save_settings', expect.anything())
    })
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'save_settings')
    expect(call?.[1]).toEqual({
      settings: { ...baseSettings, history: { retentionDays: 30 } },
    })
  })

  it('out of range typed retention clamps to 3650', async () => {
    const user = userEvent.setup()
    await loadView()
    const input = screen.getByLabelText('History retention (days)')
    await user.clear(input)
    await user.type(input, '9999')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('save_settings', expect.anything())
    })
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'save_settings')
    const saved = (call?.[1] as { settings: Settings }).settings
    expect(saved.history.retentionDays).toBe(3650)
  })

  it('out of range typed retention clamps to min', async () => {
    const user = userEvent.setup()
    await loadView()
    const input = screen.getByLabelText('History retention (days)')
    await user.clear(input)
    await user.type(input, '0')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('save_settings', expect.anything())
    })
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'save_settings')
    const saved = (call?.[1] as { settings: Settings }).settings
    expect(saved.history.retentionDays).toBe(1)
  })

  it('decimal typed retention rounds to 31', async () => {
    const user = userEvent.setup()
    await loadView()
    const input = screen.getByLabelText('History retention (days)')
    await user.clear(input)
    await user.type(input, '30.5')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('save_settings', expect.anything())
    })
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'save_settings')
    const saved = (call?.[1] as { settings: Settings }).settings
    expect(saved.history.retentionDays).toBe(31)
  })

  it('clamps history retention through the stepper bounds', async () => {
    const user = userEvent.setup()
    await loadView()
    const input = screen.getByLabelText('History retention (days)')
    const increase = screen.getByRole('button', { name: 'Increase History retention (days)' })
    const decrease = screen.getByRole('button', { name: 'Decrease History retention (days)' })
    await user.click(increase)
    expect(input).toHaveDisplayValue('91')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled()
    await user.clear(input)
    await user.type(input, '1')
    await user.click(decrease)
    expect(input).toHaveDisplayValue('1')
    expect(decrease).toBeDisabled()
    await user.clear(input)
    await user.type(input, '3650')
    await user.click(increase)
    expect(input).toHaveDisplayValue(/^3,?650$/)
    expect(increase).toBeDisabled()
  })

  it('reset to defaults restores history retention 90', async () => {
    const user = userEvent.setup()
    vi.mocked(invoke).mockImplementation((command: string) =>
      command === 'reset_settings'
        ? Promise.resolve(structuredClone(resetDefaults))
        : Promise.resolve(structuredClone(baseSettings)),
    )
    await loadView()
    const input = screen.getByLabelText('History retention (days)')
    await user.clear(input)
    await user.type(input, '30')
    await user.click(screen.getByRole('button', { name: /reset to defaults/i }))
    expect(input).toHaveDisplayValue('90')
    await user.click(screen.getByRole('button', { name: 'Increase Images target size' }))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('save_settings', expect.anything())
    })
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'save_settings')
    const saved = (call?.[1] as { settings: Settings }).settings
    expect(saved.history).toEqual({ retentionDays: 90 })
  })

  it('cancel discards history retention draft', async () => {
    const user = userEvent.setup()
    await loadView()
    const input = screen.getByLabelText('History retention (days)')
    await user.clear(input)
    await user.type(input, '30')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(input).toHaveDisplayValue('90')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('category target rows use tinted badges', async () => {
    await loadView()
    const badge = await screen.findByText('Image')
    const className = badge.className
    const tokens = className.split(/\s+/)
    const tone = CATEGORY_TONES.image
    expect(className).toContain(tone.tint)
    expect(className).toContain(tone.border)
    expect(className).toContain(tone.text)
    expect(tokens).not.toContain('bg-secondary')
    expect(tokens).not.toContain('text-secondary-foreground')
  })

  it.each([
    ['Output Folder', 'bg-primary/12'],
    ['Category Targets', 'bg-blue-500/12'],
    ['Performance', 'bg-violet-500/12'],
    ['Quality Floors', 'bg-destructive/15'],
    ['History', 'bg-amber-500/12'],
  ])('%s header icon carries its tone', async (title, tint) => {
    await loadView()
    const card = Array.from(document.querySelectorAll('[data-slot="card"]')).find(
      (c) => c.querySelector('[data-slot="card-title"]')?.textContent === title,
    )
    expect(card).toBeDefined()
    const iconSquare = card!.querySelector('[data-slot="card-icon"]')
    expect(iconSquare?.className).toContain(tint)
    expect(iconSquare?.querySelector('svg')).toBeInTheDocument()
  })

  it('auto-collapse observes the settings scroll container, not a clipped wrapper', async () => {
    resetCapturedResizeObservers()
    renderSettings()
    await screen.findByLabelText('Images target size')
    const targets = CapturingResizeObserver.instances.flatMap((o) => o.observed)
    const scroller = targets.find((el) =>
      el.className.includes('overflow-y-auto')
    )
    expect(scroller).toBeDefined()
    const clipped = targets.filter(
      (el) => el !== scroller && el.className.includes('overflow-hidden')
    )
    expect(clipped).toEqual([])
  })
})
