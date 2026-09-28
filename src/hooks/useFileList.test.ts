import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

import { useFileList } from '@/hooks/useFileList'

const mockEntry = {
  id: 'u1',
  name: 'a.jpg',
  path: '/t/a.jpg',
  category: 'image' as const,
  targetBytes: 204800,
  originalSize: 10,
  status: 'pending' as const,
  compressedSize: null,
  outputPath: null,
  error: null,
}

beforeEach(() => vi.clearAllMocks())

describe('useFileList', () => {
  it('adds files via IPC', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry])
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.addFiles(['/t/a.jpg']))
    expect(invoke).toHaveBeenCalledWith('add_files', { filePaths: ['/t/a.jpg'] })
    expect(result.current.files).toHaveLength(1)
    expect(result.current.error).toBeNull()
  })

  it('sets error and rethrows when add IPC fails', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useFileList())
    await act(async () => {
      await expect(result.current.addFiles(['/t/a.jpg'])).rejects.toThrow('boom')
    })
    expect(result.current.files).toHaveLength(0)
    expect(result.current.error).toContain('Could not add files')
    expect(result.current.error).toContain('boom')
  })

  it('browseFiles cancel (null) does nothing', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    vi.mocked(open).mockResolvedValueOnce(null)
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.browseFiles())
    expect(invoke).not.toHaveBeenCalled()
    expect(result.current.files).toHaveLength(0)
  })

  it('browseFiles wraps single string path', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    vi.mocked(open).mockResolvedValueOnce('/t/one.jpg')
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry])
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.browseFiles())
    expect(invoke).toHaveBeenCalledWith('add_files', { filePaths: ['/t/one.jpg'] })
  })

  it('browseFiles passes array through', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    vi.mocked(open).mockResolvedValueOnce(['/t/a.jpg', '/t/b.jpg'])
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry])
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.browseFiles())
    expect(invoke).toHaveBeenCalledWith('add_files', { filePaths: ['/t/a.jpg', '/t/b.jpg'] })
  })

  it('browseFiles surfaces picker errors', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    vi.mocked(open).mockRejectedValueOnce(new Error('picker dead'))
    const { result } = renderHook(() => useFileList())
    await act(async () => {
      await expect(result.current.browseFiles()).rejects.toThrow('picker dead')
    })
    expect(result.current.error).toContain('Could not open file picker')
  })

  it('browseFiles surfaces add failure after picker resolves', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    vi.mocked(open).mockResolvedValueOnce('/t/x.jpg')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('add dead'))
    const { result } = renderHook(() => useFileList())
    await act(async () => {
      await expect(result.current.browseFiles()).rejects.toThrow('add dead')
    })
    expect(result.current.error).toContain('Could not open file picker')
    expect(result.current.error).toContain('add dead')
  })

  it('successful retry after failure clears error', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([mockEntry])
    const { result } = renderHook(() => useFileList())
    await act(async () => {
      await expect(result.current.addFiles(['/t/a.jpg'])).rejects.toThrow('boom')
    })
    expect(result.current.error).toContain('Could not add files')
    await act(() => result.current.addFiles(['/t/a.jpg']))
    expect(result.current.error).toBeNull()
    expect(result.current.files).toHaveLength(1)
  })

  it('removeFile filters only after IPC success', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce([mockEntry])
      .mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.addFiles(['/t/a.jpg']))
    await act(() => result.current.removeFile('u1'))
    expect(invoke).toHaveBeenLastCalledWith('remove_file', { fileId: 'u1' })
    expect(result.current.files).toHaveLength(0)
  })

  it('removeFile keeps row when IPC fails', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce([mockEntry])
      .mockRejectedValueOnce(new Error('nope'))
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.addFiles(['/t/a.jpg']))
    await act(async () => {
      await expect(result.current.removeFile('u1')).rejects.toThrow('nope')
    })
    expect(result.current.files).toHaveLength(1)
    expect(result.current.error).toContain('Could not remove file')
  })

  it('clearList empties and clears error', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry]).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.addFiles(['/t/a.jpg']))
    await act(() => result.current.clearList())
    expect(invoke).toHaveBeenLastCalledWith('clear_list')
    expect(result.current.files).toHaveLength(0)
    expect(result.current.error).toBeNull()
  })

  it('clearList failure keeps files', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry]).mockRejectedValueOnce(new Error('x'))
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.addFiles(['/t/a.jpg']))
    await act(async () => {
      await expect(result.current.clearList()).rejects.toThrow('x')
    })
    expect(result.current.files).toHaveLength(1)
    expect(result.current.error).toContain('Could not clear list')
  })

  it('rapid adds do not corrupt ordering', async () => {
    const e2 = { ...mockEntry, id: 'u2', name: 'b.jpg' }
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry]).mockResolvedValueOnce([e2])
    const { result } = renderHook(() => useFileList())
    await act(async () => {
      await Promise.all([result.current.addFiles(['/t/a.jpg']), result.current.addFiles(['/t/b.jpg'])])
    })
    await waitFor(() => expect(result.current.files).toHaveLength(2))
    expect(result.current.files.map((f) => f.id).sort()).toEqual(['u1', 'u2'])
  })
})