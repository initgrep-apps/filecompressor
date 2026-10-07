// File Size Optimizer — offline batch file compression
// Copyright (C) 2026 File Size Optimizer Contributors
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

import '@testing-library/jest-dom/vitest'

export class CapturingResizeObserver {
  static instances: CapturingResizeObserver[] = []

  observed: Element[] = []
  callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    CapturingResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.push(target)
  }

  unobserve(target: Element): void {
    this.observed = this.observed.filter((el) => el !== target)
  }

  disconnect(): void {}
}

export function resetCapturedResizeObservers(): void {
  CapturingResizeObserver.instances = []
}

export function capturedObserveTargets(): Element[] {
  return CapturingResizeObserver.instances.flatMap((instance) => instance.observed)
}

globalThis.ResizeObserver =
  CapturingResizeObserver as unknown as typeof ResizeObserver

const matchMediaStub = (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList

if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  window.matchMedia = matchMediaStub
}