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
    expect(screen.getByLabelText('Images target size')).toHaveValue(200)
    expect(screen.getByLabelText('Videos target size')).toHaveValue(10)
    expect(screen.getByLabelText('PDF target size')).toHaveValue(2)
    expect(screen.getByLabelText('Documents target size')).toHaveValue(1)
    expect(screen.getByLabelText('Images target unit')).toHaveValue('KB')
    expect(screen.getByLabelText('Videos target unit')).toHaveValue('MB')
    expect(screen.getByLabelText('PDF target unit')).toHaveValue('MB')
    expect(screen.getByLabelText('Documents target unit')).toHaveValue('MB')
  })

  it('quality floors collapsed by default', async () => {
    await loadView()
    expect(screen.getByText(/Quality Floors/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Images minimum quality')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByText(/Quality Floors/))
    expect(await screen.findByLabelText('Images minimum quality')).toHaveValue(30)
    expect(screen.getByLabelText('Videos minimum CRF')).toHaveValue(28)
    expect(screen.getByLabelText('Videos minimum resolution')).toHaveValue('480p')
    expect(screen.getByLabelText('PDF minimum DPI')).toHaveValue(72)
    expect(screen.getByLabelText('PDF minimum JPEG quality')).toHaveValue(15)
    expect(screen.getByLabelText('Documents media quality')).toHaveValue(40)
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

  it('cancel reverts draft to last saved settings', async () => {
    await loadView()
    const user = userEvent.setup()
    const img = screen.getByLabelText('Images target size')
    await user.type(img, '5')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(img).toHaveValue(200)
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
    expect(screen.getByLabelText('Images target size')).toHaveValue(200)
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

  it('empty target input coerces to 0', async () => {
    await loadView()
    const user = userEvent.setup()
    const img = screen.getByLabelText('Images target size')
    await user.clear(img)
    await waitFor(() => expect(img).toHaveValue(0))
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled()
  })

  it('renders default KB target row for missing category key', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...baseSettings,
      categoryTargets: { image: { size: 200, unit: 'KB' } },
    })
    await loadView()
    expect(screen.getAllByRole('combobox')).toHaveLength(4)
    expect(screen.getByLabelText('Videos target size')).toHaveValue(0)
    expect(screen.getByLabelText('Videos target unit')).toHaveValue('KB')
    expect(screen.getByLabelText('PDF target size')).toHaveValue(0)
    expect(screen.getByLabelText('Documents target size')).toHaveValue(0)
    expect(screen.getByLabelText('Documents target unit')).toHaveValue('KB')
  })

  it('updates nested quality floors', async () => {
    await loadView()
    const user = userEvent.setup()
    await user.click(screen.getByText(/Quality Floors/))
    const minQuality = await screen.findByLabelText('Images minimum quality')
    await user.clear(minQuality)
    await user.type(minQuality, '45')
    const minCrf = screen.getByLabelText('Videos minimum CRF')
    await user.clear(minCrf)
    await user.type(minCrf, '35')
    await user.selectOptions(screen.getByLabelText('Videos minimum resolution'), '720p')
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
})