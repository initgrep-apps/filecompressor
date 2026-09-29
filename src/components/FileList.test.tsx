import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileEntry } from '@/types'
import { FileList } from '@/components/FileList'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))

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

  it('renders progress bar from progressByFile while compressing', () => {
    render(
      <FileList
        files={[entry({ status: 'compressing' })]}
        onRemove={vi.fn()}
        progress={{ f1: 45 }}
      />
    )
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '45')
  })

  it('progress bar defaults to zero when no progress entry', () => {
    render(<FileList files={[entry({ status: 'compressing' })]} onRemove={vi.fn()} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  it('compressing row shows cancel instead of remove', () => {
    const onCancel = vi.fn()
    render(
      <FileList files={[entry({ status: 'compressing' })]} onRemove={vi.fn()} onCancel={onCancel} />
    )
    expect(screen.queryByRole('button', { name: /remove a\.jpg/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel a\.jpg/i })).toBeInTheDocument()
  })

  it('per-file cancel button calls onCancel with id', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(
      <FileList files={[entry({ status: 'compressing' })]} onRemove={vi.fn()} onCancel={onCancel} />
    )
    await user.click(screen.getByRole('button', { name: /cancel a\.jpg/i }))
    expect(onCancel).toHaveBeenCalledWith('f1')
  })

  it('done row renders before-after sizes and percent reduction', () => {
    render(
      <FileList
        files={[
          entry({
            status: 'done',
            originalSize: 1258291,
            compressedSize: 184320,
            outputPath: '/o/a.jpg',
          }),
        ]}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('1.2 MB → 180 KB · 85% smaller')).toBeInTheDocument()
  })

  it('best effort row renders sizes in destructive red', () => {
    render(
      <FileList
        files={[
          entry({
            status: 'best_effort',
            originalSize: 1258291,
            compressedSize: 900 * 1024,
            outputPath: '/o/a.jpg',
          }),
        ]}
        onRemove={vi.fn()}
      />
    )
    const line = screen.getByText(/smaller$/)
    expect(line.className).toContain('text-destructive')
    expect(screen.getByText('Best effort')).toBeInTheDocument()
  })

  it('already under target row renders status and result line', () => {
    render(
      <FileList
        files={[entry({ status: 'already_under_target', originalSize: 512, compressedSize: 512, outputPath: '/o/a.jpg' })]}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('Already under target')).toBeInTheDocument()
    expect(screen.getByText('512 B → 512 B · 0% smaller')).toBeInTheDocument()
  })

  it('reveal button calls onReveal with output path', async () => {
    const user = userEvent.setup()
    const onReveal = vi.fn()
    render(
      <FileList
        files={[entry({ status: 'done', compressedSize: 500, outputPath: '/o/a.jpg' })]}
        onRemove={vi.fn()}
        onReveal={onReveal}
      />
    )
    await user.click(screen.getByRole('button', { name: /reveal a\.jpg/i }))
    expect(onReveal).toHaveBeenCalledWith('/o/a.jpg')
  })

  it('failed row renders destructive error text', () => {
    render(
      <FileList
        files={[entry({ status: 'failed', error: 'Cannot read file: locked' })]}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('Failed')).toBeInTheDocument()
    const errText = screen.getByText('Cannot read file: locked')
    expect(errText.className).toContain('text-destructive')
  })

  it('remove button disabled for pending rows while compressing', () => {
    render(<FileList files={[entry()]} onRemove={vi.fn()} removeDisabled />)
    expect(screen.getByRole('button', { name: /remove a\.jpg/i })).toBeDisabled()
  })

  it('remove button stays enabled for done rows while compressing', () => {
    render(
      <FileList
        files={[entry({ status: 'done', compressedSize: 500, outputPath: '/o/a.jpg' })]}
        onRemove={vi.fn()}
        removeDisabled
      />
    )
    expect(screen.getByRole('button', { name: /remove a\.jpg/i })).toBeEnabled()
  })

  it('reveal button hidden when no onReveal handler passed', () => {
    render(
      <FileList
        files={[entry({ status: 'done', compressedSize: 500, outputPath: '/o/a.jpg' })]}
        onRemove={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /reveal a\.jpg/i })).not.toBeInTheDocument()
    expect(screen.getByText('1 KB → 500 B · 51% smaller')).toBeInTheDocument()
  })
})
