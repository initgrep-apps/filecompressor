import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileEntry } from '@/types'
import { FileList } from '@/components/FileList'

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: 'f1',
    name: 'a.jpg',
    path: '/t/a.jpg',
    category: 'image',
    targetBytes: 204800,
    originalSize: 1024,
    status: 'pending',
    compressedSize: null,
    outputPath: null,
    error: null,
    ...overrides,
  }
}

describe('FileList', () => {
  it('renders nothing when empty', () => {
    const { container } = render(<FileList files={[]} onRemove={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows name, size, category badge, target, status', () => {
    render(
      <FileList
        files={[entry({ name: 'photo.jpg', originalSize: 512, category: 'image', targetBytes: 204800 })]}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('photo.jpg')).toBeInTheDocument()
    expect(screen.getByText('512 B')).toBeInTheDocument()
    expect(screen.getByText('Image')).toBeInTheDocument()
    expect(screen.getByText('200 KB')).toBeInTheDocument()
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })

  it('formats sizes across tiers', () => {
    render(
      <FileList
        files={[
          entry({ id: 'a', name: 'a.jpg', originalSize: 500 }),
          entry({ id: 'b', name: 'b.jpg', originalSize: 2048 }),
          entry({ id: 'c', name: 'c.jpg', originalSize: 2097152 }),
          entry({ id: 'd', name: 'd.mp4', originalSize: 5 * 1024 ** 3 }),
        ]}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('500 B')).toBeInTheDocument()
    expect(screen.getByText('2 KB')).toBeInTheDocument()
    expect(screen.getByText('2.0 MB')).toBeInTheDocument()
    expect(screen.getByText('5.00 GB')).toBeInTheDocument()
  })

  it('zero size and zero target render em-dash', () => {
    render(
      <FileList
        files={[entry({ originalSize: 0, category: 'other', targetBytes: 0, status: 'unsupported' })]}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Other')).toBeInTheDocument()
    expect(screen.getByText('Unsupported')).toBeInTheDocument()
  })

  it('unsupported rows are dimmed', () => {
    render(
      <FileList
        files={[entry({ category: 'other', status: 'unsupported' })]}
        onRemove={vi.fn()}
      />
    )
    const row = screen.getByText('a.jpg').closest('tr')
    expect(row?.className).toContain('opacity-40')
  })

  it('remove button calls onRemove with id and has aria-label', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FileList files={[entry()]} onRemove={onRemove} />)
    const btn = screen.getByRole('button', { name: /remove a\.jpg/i })
    await user.click(btn)
    expect(onRemove).toHaveBeenCalledWith('f1')
  })
})
