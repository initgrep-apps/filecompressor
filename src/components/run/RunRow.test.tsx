import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RunRow } from '@/components/run/RunRow'
import { formatSize } from '@/lib/sizeFormat'
import { setupMotionStubs } from '@/test/motionStubs'
import type { FileEntry } from '@/types'

beforeAll(() => {
  setupMotionStubs()
})

function makeFile(patch: Partial<FileEntry> = {}): FileEntry {
  return {
    id: 'f1',
    name: 'IMG_5647.MOV',
    path: '/tmp/IMG_5647.MOV',
    category: 'video',
    targetBytes: 8_388_608,
    originalSize: 1_100_000,
    status: 'done',
    compressedSize: 700_000,
    outputPath: '/out/IMG_5647.MOV',
    error: null,
    strategyUsed: 'crf=24',
    qualityUsed: null,
    ...patch,
  }
}

describe('RunRow', () => {
  it('compressing row shows name, percent, progress bar, and cancel button bound to onCancel(file.id)', () => {
    const onCancel = vi.fn()
    render(<RunRow file={makeFile({ status: 'compressing' })} percent={84} onCancel={onCancel} />)
    expect(screen.getByText('IMG_5647.MOV')).toBeInTheDocument()
    expect(screen.getByText('84%')).toBeInTheDocument()
    expect(screen.getByText(`${formatSize(1_100_000)} → …`)).toBeInTheDocument()
    expect(screen.getByTestId('run-progress-fill')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel IMG_5647.MOV' }))
    expect(onCancel).toHaveBeenCalledWith('f1')
  })

  it('done row shows sizes, -% chip, strategy label, and Reveal bound to onReveal(outputPath)', () => {
    const onReveal = vi.fn()
    render(
      <RunRow
        file={makeFile({ status: 'done', category: 'pdf', strategyUsed: 'gs dpi=300,jpegq=85' })}
        onReveal={onReveal}
      />
    )
    expect(screen.getByText('Ghostscript · Lossy')).toBeInTheDocument()
    expect(screen.getByText(`${formatSize(1_100_000)} → ${formatSize(700_000)}`)).toBeInTheDocument()
    expect(screen.getByText('-36%')).toBeInTheDocument()
    const chip = screen.getByTestId('run-chip')
    expect(chip.className).toContain('text-primary')
    expect(chip.className).toContain('bg-primary/10')
    expect(screen.queryByText(/dpi=/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal IMG_5647.MOV' }))
    expect(onReveal).toHaveBeenCalledWith('/out/IMG_5647.MOV')
  })

  it('best_effort row shows amber Best effort prefix and error text when present', () => {
    render(
      <RunRow
        file={makeFile({
          status: 'best_effort',
          category: 'document',
          strategyUsed: 'quality=60,best-effort',
          error: 'Encoder error: unsupported color profile',
        })}
      />
    )
    expect(screen.getByText('Best effort')).toBeInTheDocument()
    const chip = screen.getByTestId('run-chip')
    expect(chip.textContent).toBe('-36%')
    expect(chip.className).toContain('text-amber-600')
    expect(chip.className).toContain('bg-amber-500/10')
    expect(screen.getByText('Encoder error: unsupported color profile')).toBeInTheDocument()
  })

  it('best_effort row still shows the Best effort note when strategyUsed is null', () => {
    render(<RunRow file={makeFile({ status: 'best_effort', strategyUsed: null })} />)
    expect(screen.getByText('Best effort')).toBeInTheDocument()
  })

  it('already_under_target row shows ≤ target chip, Already under target line, and Reveal', () => {
    render(
      <RunRow
        file={makeFile({
          status: 'already_under_target',
          strategyUsed: 'already-under-target',
          compressedSize: null,
          targetBytes: 1_572_864,
        })}
        onReveal={vi.fn()}
      />
    )
    expect(screen.getByText('≤ target')).toBeInTheDocument()
    expect(screen.getByText('Already under 1.5 MB')).toBeInTheDocument()
    expect(screen.getByText(`${formatSize(1_100_000)}`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reveal IMG_5647.MOV' })).toBeInTheDocument()
    expect(screen.queryByText('-36%')).not.toBeInTheDocument()
    expect(
      document.querySelector('[data-testid="run-row-already_under_target"]')?.textContent
    ).not.toContain('already-under-target')
  })

  it('failed row shows Failed chip, wrapped error with full title, and no Reveal', () => {
    const err = 'Encoder error: unsupported color profile and a very long trailing detail message'
    render(
      <RunRow
        file={makeFile({ status: 'failed', error: err, outputPath: '/out/IMG_5647.MOV' })}
      />
    )
    expect(screen.getByText('Failed')).toBeInTheDocument()
    const errorEl = screen.getByText(err)
    expect(errorEl.className).toContain('line-clamp-2')
    expect(errorEl.getAttribute('title')).toBe(err)
    expect(screen.queryByRole('button', { name: 'Reveal IMG_5647.MOV' })).not.toBeInTheDocument()
  })

  it('cancelled row is muted with no Reveal', () => {
    render(<RunRow file={makeFile({ status: 'cancelled' })} />)
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reveal IMG_5647.MOV' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('pending row is dashed with remove bound to onRemove(file.id)', () => {
    const onRemove = vi.fn()
    render(
      <RunRow file={makeFile({ status: 'pending', compressedSize: null, outputPath: null })} onRemove={onRemove} />
    )
    expect(screen.getByText('Queued')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove IMG_5647.MOV' })).toBeInTheDocument()
    expect(screen.getByTestId('run-row-pending').className).toContain('border-dashed')
    fireEvent.click(screen.getByRole('button', { name: 'Remove IMG_5647.MOV' }))
    expect(onRemove).toHaveBeenCalledWith('f1')
  })

  it('aria labels match Cancel {name} / Reveal {name} / Remove {name}', () => {
    render(
      <>
        <RunRow file={makeFile({ id: 'f1', status: 'compressing' })} onCancel={vi.fn()} />
        <RunRow file={makeFile({ id: 'f2', name: 'Done.pdf', status: 'done' })} onReveal={vi.fn()} />
        <RunRow file={makeFile({ id: 'f3', name: 'Removed.png', status: 'pending' })} onRemove={vi.fn()} />
      </>
    )
    expect(screen.getByRole('button', { name: 'Cancel IMG_5647.MOV' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reveal Done.pdf' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Removed.png' })).toBeInTheDocument()
  })

  it('outputPath absent on a done row → no Reveal rendered', () => {
    render(<RunRow file={makeFile({ outputPath: null })} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('progress bar width tracks percent ?? 0 and the label rounds', () => {
    const { unmount } = render(
      <RunRow file={makeFile({ status: 'compressing' })} percent={62.4} />
    )
    expect(screen.getByTestId('run-progress-fill').style.width).toBe('62.4%')
    expect(screen.getByText('62%')).toBeInTheDocument()
    unmount()
    render(<RunRow file={makeFile({ status: 'compressing' })} />)
    expect(screen.getByTestId('run-progress-fill').style.width).toBe('0%')
  })

  it('progress bar clamps NaN, negative, and overflowing percents', () => {
    const { rerender } = render(<RunRow file={makeFile({ status: 'compressing' })} percent={NaN as number} />)
    expect(screen.getByTestId('run-progress-fill').style.width).toBe('0%')
    expect(screen.getByText('0%')).toBeInTheDocument()
    rerender(<RunRow file={makeFile({ status: 'compressing' })} percent={-20} />)
    expect(screen.getByTestId('run-progress-fill').style.width).toBe('0%')
    rerender(<RunRow file={makeFile({ status: 'compressing' })} percent={150} />)
    expect(screen.getByTestId('run-progress-fill').style.width).toBe('100%')
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('buttons are not rendered when their handlers are omitted (no dead affordances)', () => {
    render(
      <>
        <RunRow file={makeFile({ id: 'f1', status: 'compressing' })} />
        <RunRow file={makeFile({ id: 'f2', name: 'Done.pdf', status: 'done' })} />
        <RunRow file={makeFile({ id: 'f3', name: 'Removed.png', status: 'pending' })} />
      </>
    )
    expect(screen.queryByRole('button', { name: 'Cancel IMG_5647.MOV' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reveal Done.pdf' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Removed.png' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('done row with zero original size shows no chip; oversized result clamps to -0%', () => {
    const { rerender } = render(
      <RunRow file={makeFile({ status: 'done', originalSize: 0, compressedSize: 0 })} onReveal={vi.fn()} />
    )
    expect(screen.queryByTestId('run-chip')).not.toBeInTheDocument()
    rerender(
      <RunRow file={makeFile({ status: 'done', compressedSize: null })} onReveal={vi.fn()} />
    )
    expect(screen.queryByTestId('run-chip')).not.toBeInTheDocument()
    rerender(<RunRow file={makeFile({ status: 'done', compressedSize: 2_000_000 })} onReveal={vi.fn()} />)
    expect(screen.getByTestId('run-chip').textContent).toBe('-0%')
  })

  it('long name truncates and title attribute equals full name', () => {
    const longName = 'a'.repeat(200) + '.png'
    render(<RunRow file={makeFile({ status: 'done', name: longName })} />)
    const nameEl = screen.getByText(longName)
    expect(nameEl.className).toContain('truncate')
    expect(nameEl.getAttribute('title')).toBe(longName)
  })

  it('long error text clamps and title attribute equals full error', () => {
    const longError = 'E'.repeat(300)
    render(<RunRow file={makeFile({ status: 'failed', error: longError })} />)
    const errorEl = screen.getByText(longError)
    expect(errorEl.className).toContain('line-clamp-2')
    expect(errorEl.getAttribute('title')).toBe(longError)
  })
})

describe('RunRow card fidelity', () => {
  const GRADIENT_FILL = 'bg-[linear-gradient(90deg,var(--color-cyan-400),var(--color-primary))]'
  const DONE_ACCENT = 'shadow-[inset_3px_0_0_var(--primary)]'

  it('compressing card shows gradient progress fill', () => {
    render(<RunRow file={makeFile({ status: 'compressing', category: 'image' })} percent={42} />)
    expect(screen.getByTestId('run-progress-fill').className).toContain(GRADIENT_FILL)
  })

  it('done card carries green inset accent bar', () => {
    render(<RunRow file={makeFile({ status: 'done' })} />)
    expect(screen.getByTestId('run-row-done').className).toContain(DONE_ACCENT)
  })

  it('compressing card shows lane tint and primary border', () => {
    render(<RunRow file={makeFile({ status: 'compressing', category: 'image' })} percent={42} />)
    const card = screen.getByTestId('run-row-compressing')
    expect(card.className).toContain('blue')
    expect(card.className).toContain('border-primary/30')
  })

  it('failed card keeps red accent', () => {
    render(<RunRow file={makeFile({ status: 'failed', error: 'boom' })} />)
    expect(screen.getByTestId('run-row-failed').className).toContain('destructive')
  })
})
