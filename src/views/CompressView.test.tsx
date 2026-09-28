import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

import { CompressView } from '@/views/CompressView'

beforeEach(() => vi.clearAllMocks())

describe('CompressView', () => {
  it('does not render banner on initial render', () => {
    render(<CompressView />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders destructive alert banner when add fails', async () => {
    const user = userEvent.setup()
    vi.mocked(open).mockResolvedValueOnce('/t/x.jpg')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('picker dead'))
    render(<CompressView />)
    await user.click(screen.getByRole('button', { name: /drop files/i }))
    await waitFor(() => {
      const banner = screen.getByRole('alert')
      expect(banner).toHaveTextContent('Could not open file picker')
      expect(banner).toHaveTextContent('picker dead')
    })
    expect(screen.getByRole('alert').className).toContain('destructive')
  })
})