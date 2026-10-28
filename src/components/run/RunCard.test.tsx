// Yard — offline batch file compression
// Copyright (C) 2026 Yard Contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RunCard } from '@/components/run/RunCard'
import { Kanban } from '@/components/ui/kanban'
import { formatSize } from '@/lib/sizeFormat'
import type { FileEntry } from '@/types'

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

function WithKanban({ children }: { children: React.ReactNode }) {
  return (
    <Kanban
      value={{ col: [] }}
      onValueChange={() => {}}
      getItemValue={(item: FileEntry) => item.id}
    >
      {children}
    </Kanban>
  )
}

describe('RunCard', () => {
  it('compressing card shows name, clamped/rounded percent, progress bar, and cancel wiring', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <WithKanban>
        <RunCard file={makeFile({ status: 'compressing' })} percent={45} onCancel={onCancel} />
      </WithKanban>
    )
    expect(screen.getByText('IMG_5647.MOV')).toBeInTheDocument()
    expect(screen.getByText('45%')).toBeInTheDocument()
    expect(screen.getByTestId('run-card-percent')).toHaveTextContent('45%')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45')
    expect(screen.getByText(`${formatSize(1_100_000)} → …`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel IMG_5647.MOV' }))
    expect(onCancel).toHaveBeenCalledWith('f1')

    rerender(
      <WithKanban>
        <RunCard file={makeFile({ status: 'compressing' })} percent={NaN as number} onCancel={onCancel} />
      </WithKanban>
    )
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByTestId('run-card-percent')).toHaveTextContent('0%')

    rerender(
      <WithKanban>
        <RunCard file={makeFile({ status: 'compressing' })} percent={-20} onCancel={onCancel} />
      </WithKanban>
    )
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')

    rerender(
      <WithKanban>
        <RunCard file={makeFile({ status: 'compressing' })} percent={150} onCancel={onCancel} />
      </WithKanban>
    )
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByTestId('run-card-percent')).toHaveTextContent('100%')
  })

  it('done card shows sizes, -% chip, strategy label, and Reveal bound to onReveal(outputPath)', () => {
    const onReveal = vi.fn()
    render(
      <WithKanban>
        <RunCard
          file={makeFile({ status: 'done', category: 'pdf', strategyUsed: 'gs dpi=300,jpegq=85' })}
          onReveal={onReveal}
        />
      </WithKanban>
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

  it('best_effort card shows amber Best effort prefix and error text', () => {
    render(
      <WithKanban>
        <RunCard
          file={makeFile({
            status: 'best_effort',
            category: 'document',
            strategyUsed: 'quality=60,best-effort',
            error: 'Encoder error: unsupported color profile',
          })}
        />
      </WithKanban>
    )
    expect(screen.getByText('Best effort')).toBeInTheDocument()
    const chip = screen.getByTestId('run-chip')
    expect(chip.textContent).toBe('-36%')
    expect(chip.className).toContain('text-amber-600')
    expect(chip.className).toContain('bg-amber-500/10')
    const errorEl = screen.getByText('Encoder error: unsupported color profile')
    expect(errorEl.className).toContain('line-clamp-2')
    expect(errorEl.className).toContain('text-destructive')
  })

  it('best_effort card still shows the Best effort note when strategyUsed is null', () => {
    render(
      <WithKanban>
        <RunCard file={makeFile({ status: 'best_effort', strategyUsed: null })} />
      </WithKanban>
    )
    expect(screen.getByText('Best effort')).toBeInTheDocument()
  })

  it('already_under_target card shows muted ≤ target chip, Already under target line, and Reveal', () => {
    render(
      <WithKanban>
        <RunCard
          file={makeFile({
            status: 'already_under_target',
            strategyUsed: 'already-under-target',
            compressedSize: null,
            targetBytes: 1_572_864,
          })}
          onReveal={vi.fn()}
        />
      </WithKanban>
    )
    expect(screen.getByText('≤ target')).toBeInTheDocument()
    expect(screen.getByText('Already under 1.5 MB')).toBeInTheDocument()
    expect(screen.getByText(`${formatSize(1_100_000)}`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reveal IMG_5647.MOV' })).toBeInTheDocument()
    expect(screen.queryByText('-36%')).not.toBeInTheDocument()
    const chip = screen.getByTestId('run-chip')
    expect(chip.className).toContain('bg-muted')
    expect(chip.className).toContain('text-muted-foreground')
    expect(
      document.querySelector('[data-slot="card"]')?.textContent
    ).not.toContain('already-under-target')
  })

  it('failed card shows Failed chip, clamped error with full title, and no Reveal', () => {
    const err = 'Encoder error: unsupported color profile and a very long trailing detail message'
    render(
      <WithKanban>
        <RunCard
          file={makeFile({ status: 'failed', error: err, outputPath: '/out/IMG_5647.MOV' })}
        />
      </WithKanban>
    )
    expect(screen.getByText('Failed')).toBeInTheDocument()
    const errorEl = screen.getByText(err)
    expect(errorEl.className).toContain('line-clamp-2')
    expect(errorEl.className).toContain('text-destructive')
    expect(errorEl.getAttribute('title')).toBe(err)
    expect(screen.queryByRole('button', { name: 'Reveal IMG_5647.MOV' })).not.toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('cancelled card is muted with no Reveal and no buttons', () => {
    render(
      <WithKanban>
        <RunCard file={makeFile({ status: 'cancelled' })} />
      </WithKanban>
    )
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reveal IMG_5647.MOV' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel IMG_5647.MOV' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove IMG_5647.MOV' })).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="card"]')?.className).toContain('opacity-60')
  })

  it('pending card is dashed with remove bound to onRemove(file.id)', () => {
    const onRemove = vi.fn()
    render(
      <WithKanban>
        <RunCard
          file={makeFile({ status: 'pending', compressedSize: null, outputPath: null })}
          onRemove={onRemove}
        />
      </WithKanban>
    )
    expect(screen.getByText('Queued')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove IMG_5647.MOV' })).toBeInTheDocument()
    expect(document.querySelector('[data-slot="card"]')?.className).toContain('border-dashed')
    fireEvent.click(screen.getByRole('button', { name: 'Remove IMG_5647.MOV' }))
    expect(onRemove).toHaveBeenCalledWith('f1')
  })

  it('no Reveal button when outputPath is null', () => {
    render(
      <WithKanban>
        <RunCard file={makeFile({ outputPath: null })} />
      </WithKanban>
    )
    expect(screen.queryByRole('button', { name: 'Reveal IMG_5647.MOV' })).not.toBeInTheDocument()
  })

  it('buttons are not rendered when their handlers are omitted (no dead affordances)', () => {
    render(
      <WithKanban>
        <RunCard file={makeFile({ id: 'f1', status: 'compressing' })} />
        <RunCard file={makeFile({ id: 'f2', name: 'Done.pdf', status: 'done' })} />
        <RunCard file={makeFile({ id: 'f3', name: 'Removed.png', status: 'pending' })} />
      </WithKanban>
    )
    expect(screen.queryByRole('button', { name: 'Cancel IMG_5647.MOV' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reveal Done.pdf' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Removed.png' })).not.toBeInTheDocument()
  })

  it('compressing card has no drag handle and no remove/reveal buttons', () => {
    render(
      <WithKanban>
        <RunCard
          file={makeFile({ status: 'compressing' })}
          onCancel={vi.fn()}
          onReveal={vi.fn()}
          onRemove={vi.fn()}
        />
      </WithKanban>
    )
    expect(document.querySelector('[data-slot="kanban-item-handle"]')).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="kanban-item"]')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove IMG_5647.MOV' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reveal IMG_5647.MOV' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel IMG_5647.MOV' })).toBeInTheDocument()
  })

  it('overlay card renders without action wiring and carries ring overlay classes', () => {
    render(
      <RunCard
        file={makeFile({ status: 'done' })}
        isOverlay
        onReveal={vi.fn()}
        onCancel={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    const card = document.querySelector('[data-slot="card"]')
    expect(card?.className).toContain('ring-primary/20')
    expect(card?.className).toContain('rotate-1')
    expect(card?.className).toContain('ring-2')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="kanban-item"]')).not.toBeInTheDocument()
  })

  it('long name truncates and title attribute equals full name', () => {
    const longName = 'a'.repeat(200) + '.png'
    render(
      <WithKanban>
        <RunCard file={makeFile({ status: 'done', name: longName })} />
      </WithKanban>
    )
    const nameEl = screen.getByText(longName)
    expect(nameEl.className).toContain('truncate')
    expect(nameEl.getAttribute('title')).toBe(longName)
  })
})
