import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Category, FileEntry } from '@/types'
import { FileList } from '@/components/FileList'
import { CATEGORY_TONES } from '@/lib/tokens'

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
    strategyUsed: null,
    qualityUsed: null,
    ...overrides,
  }
}

describe('FileList', () => {
  it('renders nothing when empty', () => {
    const { container } = render(<FileList files={[]} onRemove={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('table header is sticky at the top of the scroll region', () => {
    const { container } = render(<FileList files={[entry()]} onRemove={vi.fn()} />)
    const scrollRegion = container.querySelector('[data-slot="file-list-scroll"]')
    const tableContainer = container.querySelector('[data-slot="table-container"]')
    const header = container.querySelector('[data-slot="table-header"]')
    if (!scrollRegion || !tableContainer || !header) {
      throw new Error('file list is missing its scroll region or table header')
    }

    expect(scrollRegion.className).toContain('overflow-y-auto')
    expect(scrollRegion.className).toContain('[&>[data-slot=table-container]]:overflow-visible')
    expect(scrollRegion.className).not.toContain('border')
    expect(scrollRegion.className).not.toContain('rounded')
    expect(header.className).toContain('sticky')
    expect(header.className).toContain('top-0')
    expect(scrollRegion.contains(header)).toBe(true)
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

  const labels: Record<Category, string> = {
    image: 'Image',
    video: 'Video',
    pdf: 'PDF',
    document: 'Document',
    other: 'Other',
  }
  it.each(
    (Object.keys(CATEGORY_TONES) as Category[]).map((category) => [category, labels[category]])
  )('category badges use shared tones — %s', (category, label) => {
    const typed = category as Category
    render(<FileList files={[entry({ category: typed })]} onRemove={vi.fn()} />)
    const className = screen.getByText(label as string).className
    const tokens = className.split(/\s+/)
    const tone = CATEGORY_TONES[typed]
    expect(className).toContain(tone.tint)
    expect(className).toContain(tone.text)
    expect(className).toContain(tone.border)
    expect(tokens).not.toContain('bg-secondary')
    expect(tokens).not.toContain('text-secondary-foreground')
  })

  it('other category stays muted', () => {
    render(<FileList files={[entry({ category: 'other' })]} onRemove={vi.fn()} />)
    const className = screen.getByText('Other').className
    expect(className).toContain('text-muted-foreground')
    const tokens = className.split(/\s+/)
    for (const token of tokens) {
      expect(token).not.toMatch(/^(bg|text|border)-(blue|violet|amber|red)/)
    }
  })

  it('remove button calls onRemove with id and has aria-label', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FileList files={[entry()]} onRemove={onRemove} />)
    const btn = screen.getByRole('button', { name: /remove a\.jpg/i })
    await user.click(btn)
    expect(onRemove).toHaveBeenCalledWith('f1')
  })

  it('compressing rows render remove and no cancel control', () => {
    render(<FileList files={[entry({ status: 'compressing' })]} onRemove={vi.fn()} />)
    expect(screen.getByRole('button', { name: /remove a\.jpg/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel a\.jpg/i })).not.toBeInTheDocument()
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

  it('best effort status renders amber in staging table', () => {
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
    const badge = screen.getByText('Best effort')
    expect(badge.className).toContain('text-amber-600')
    expect(badge.className).not.toContain('text-destructive')
    expect(badge.firstElementChild?.className).toContain('bg-amber-500')
    const line = screen.getByText(/smaller$/)
    expect(line.className).toContain('text-amber-600')
    expect(line.className).not.toContain('text-destructive')
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

  it.each(['done', 'best_effort', 'already_under_target'] as const)(
    'reveal button renders for %s rows',
    (status) => {
      render(
        <FileList
          files={[entry({ status, compressedSize: 500, outputPath: '/o/a.jpg' } as FileEntry)]}
          onRemove={vi.fn()}
          onReveal={vi.fn()}
        />
      )
      expect(screen.getByRole('button', { name: /reveal a\.jpg/i })).toBeInTheDocument()
    }
  )

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
