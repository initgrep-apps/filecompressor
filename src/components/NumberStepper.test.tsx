import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NumberStepper } from '@/components/NumberStepper'

const LABEL = 'Images minimum quality'

function Harness({ min, max, initial }: { min: number; max: number; initial: number }) {
  const [value, setValue] = useState(initial)
  return (
    <NumberStepper
      value={value}
      onValueChange={setValue}
      min={min}
      max={max}
      ariaLabel={LABEL}
    />
  )
}

const input = () => screen.getByLabelText(LABEL)
const increase = () => screen.getByRole('button', { name: `Increase ${LABEL}` })
const decrease = () => screen.getByRole('button', { name: `Decrease ${LABEL}` })

describe('NumberStepper', () => {
  it('increments and decrements by 1', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    await user.click(increase())
    expect(input()).toHaveDisplayValue('31')
    await user.click(decrease())
    expect(input()).toHaveDisplayValue('30')
  })

  it('disables buttons at bounds', async () => {
    const { unmount } = render(<Harness min={0} max={100} initial={0} />)
    expect(decrease()).toBeDisabled()
    expect(increase()).toBeEnabled()
    unmount()
    render(<Harness min={0} max={100} initial={100} />)
    expect(increase()).toBeDisabled()
    expect(decrease()).toBeEnabled()
  })

  it('accepts typed values and clamps on blur', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    await user.clear(input())
    await user.type(input(), '999')
    await user.tab()
    expect(input()).toHaveDisplayValue('100')
    const { unmount } = render(<Harness min={-10} max={100} initial={30} />)
    await user.clear(screen.getAllByLabelText(LABEL)[1])
    await user.type(screen.getAllByLabelText(LABEL)[1], '-50')
    await user.tab()
    expect(screen.getAllByLabelText(LABEL)[1]).toHaveDisplayValue('-10')
    unmount()
  })

  it('normalizes invalid typed input to last valid value on blur', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    await user.clear(input())
    await user.tab()
    expect(input()).toHaveDisplayValue('30')
  })

  it('steps with ArrowUp/ArrowDown', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    await user.click(input())
    await user.keyboard('{ArrowUp}')
    expect(input()).toHaveDisplayValue('31')
    await user.keyboard('{ArrowDown}')
    expect(input()).toHaveDisplayValue('30')
  })

  it('null emissions never reach onValueChange', async () => {
    const user = userEvent.setup()
    const spy = vi.fn()
    function SpyHarness() {
      const [value, setValue] = useState(30)
      return (
        <NumberStepper
          value={value}
          onValueChange={(n) => {
            setValue(n)
            spy(n)
          }}
          min={0}
          max={100}
          ariaLabel={LABEL}
        />
      )
    }
    render(<SpyHarness />)
    await user.clear(input())
    await user.tab()
    const calls = spy.mock.calls.flat()
    expect(calls.every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true)
    expect(calls).not.toContain(null)
    expect(input()).toHaveDisplayValue('30')
  })

  it('Enter and Space in the input do not change the value', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    await user.click(input())
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(input()).toHaveDisplayValue('30')
  })
})
