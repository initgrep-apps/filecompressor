import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { Settings } from '@/types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

import { SettingsView } from '@/views/SettingsView'

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
}

const resetDefaults: Settings = {
  ...baseSettings,
  outputFolder: '/defaults/Compressed',
}

const loadView = async () => {
  render(<SettingsView />)
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
    render(<SettingsView />)
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
    expect(screen.getAllByRole('combobox')).toHaveLength(4)
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
    expect(screen.getAllByRole('combobox')).toHaveLength(4)
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

  it('renders three cards with card composition', async () => {
    await loadView()
    expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(3)
    expect(screen.getByText('Output Folder')).toBeInTheDocument()
    expect(screen.getByText('Category Targets')).toBeInTheDocument()
    expect(screen.getByText('Quality Floors')).toBeInTheDocument()
  })

  it('stepper buttons step ±1 and mark the draft dirty', async () => {
    await loadView()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Increase Images target size' }))
    expect(screen.getByLabelText('Images target size')).toHaveDisplayValue('201')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled()
  })

  it('no native number inputs or select elements remain', async () => {
    const { container } = render(<SettingsView />)
    await screen.findByLabelText('Images target size')
    expect(
      container.querySelectorAll('input[type="number"]:not([aria-hidden="true"]), select'),
    ).toHaveLength(0)
  })

  it('null onValueChange from a mismatched persisted value does not mutate the draft', async () => {
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
})
