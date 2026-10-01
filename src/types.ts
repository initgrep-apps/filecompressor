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

export type Category = 'image' | 'video' | 'pdf' | 'document' | 'other'

export type FileStatus =
  | 'pending'
  | 'compressing'
  | 'done'
  | 'best_effort'
  | 'failed'
  | 'cancelled'
  | 'unsupported'
  | 'already_under_target'

export interface FileEntry {
  id: string
  name: string
  path: string
  category: Category
  targetBytes: number
  originalSize: number
  status: FileStatus
  compressedSize: number | null
  outputPath: string | null
  error: string | null
}

export interface CategoryTarget {
  size: number
  unit: 'KB' | 'MB'
}

export interface QualityFloors {
  image: { minQuality: number }
  video: { minCrf: number; minResolution: string }
  pdf: { minDpi: number; minJpegQuality: number }
  document: { minMediaQuality: number }
}

export type MaxConcurrent = 'auto' | '1' | '2' | '3'

export interface PerformanceSettings {
  maxConcurrent: MaxConcurrent
}

export interface Settings {
  outputFolder: string
  categoryTargets: Record<string, CategoryTarget>
  qualityFloors: QualityFloors
  performance: PerformanceSettings
}