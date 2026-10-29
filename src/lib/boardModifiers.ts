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

import type { Modifier, Modifiers, UniqueIdentifier } from '@dnd-kit/core'
import type { Transform } from '@dnd-kit/utilities'

export function dragAxisModifiers(isLane: (id: UniqueIdentifier) => boolean): Modifiers {
  const axisModifier: Modifier = ({ active, transform }): Transform => {
    if (!active || !transform) return transform
    return isLane(active.id) ? { ...transform, y: 0 } : { ...transform, x: 0 }
  }
  return [axisModifier]
}