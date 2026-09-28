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

import { useState, useEffect } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion'
import type { Settings, CategoryTarget } from '@/types'

const categories = [
  { key: 'image', label: 'Images', badge: 'Image', formats: 'JPEG, PNG, WebP, HEIC' },
  { key: 'video', label: 'Videos', badge: 'Video', formats: 'MP4, MOV' },
  { key: 'pdf', label: 'PDF', badge: 'PDF', formats: 'PDF documents' },
  { key: 'document', label: 'Documents', badge: 'Document', formats: 'DOCX, XLSX, PPTX' },
] as const

export function SettingsView() {
  const { settings, loading, error, saveSettings, resetSettings, browseFolder } = useSettings()
  const [draft, setDraft] = useState<Settings | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (settings) setDraft(settings)
  }, [settings])

  if (loading || !draft) {
    return (
      <div className="p-6 text-sm text-muted-foreground">{error ?? 'Loading settings…'}</div>
    )
  }

  const updateTarget = (key: string, field: keyof CategoryTarget, value: string | number) => {
    setDraft((prev) => {
      if (!prev) return prev
      const target = prev.categoryTargets[key] ?? { size: 0, unit: 'KB' }
      return {
        ...prev,
        categoryTargets: {
          ...prev.categoryTargets,
          [key]: { ...target, [field]: value },
        },
      }
    })
  }

  const updateFloor = (path: string, value: string | number) => {
    setDraft((prev) => {
      if (!prev) return prev
      const keys = path.split('.')
      const floors = { ...prev.qualityFloors }
      if (keys.length === 2) {
        const [category, field] = keys
        if (category === 'image') {
          floors.image = { ...floors.image, [field]: value }
        } else if (category === 'video') {
          floors.video = { ...floors.video, [field]: value }
        } else if (category === 'pdf') {
          floors.pdf = { ...floors.pdf, [field]: value }
        } else if (category === 'document') {
          floors.document = { ...floors.document, [field]: value }
        }
      }
      return { ...prev, qualityFloors: floors }
    })
  }

  const handleBrowse = async () => {
    const folder = await browseFolder()
    if (folder) {
      setDraft((prev) => (prev ? { ...prev, outputFolder: folder } : prev))
    }
  }

  const handleSave = async () => {
    if (!draft || isSaving) return
    setIsSaving(true)
    try {
      await saveSettings(draft)
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = () => {
    setDraft(settings)
  }

  const handleReset = async () => {
    const defaults = await resetSettings()
    if (defaults) setDraft(defaults)
  }

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(settings)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold">Settings</h1>
          <button
            type="button"
            onClick={handleReset}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            Reset to defaults
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">Output Folder</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Compressed files are saved here. Originals are never modified.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex h-9 flex-1 items-center gap-2 rounded-md border border-input bg-background/50 px-3 text-sm text-muted-foreground">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0"
                aria-hidden="true"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span className="truncate">{draft.outputFolder}</span>
            </div>
            <Button variant="outline" size="sm" onClick={handleBrowse}>
              Browse
            </Button>
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-medium">Category Targets</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Maximum file size per category. Applied to all files in that category.
            </p>
          </div>
          {categories.map((cat) => {
            const target = draft.categoryTargets[cat.key] ?? { size: 0, unit: 'KB' }
            return (
              <div key={cat.key} className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2.5">
                  <Badge variant="secondary">{cat.badge}</Badge>
                  <span className="text-sm">{cat.label}</span>
                  <span className="text-xs text-muted-foreground">{cat.formats}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    aria-label={`${cat.label} target size`}
                    value={target.size}
                    onChange={(e) => updateTarget(cat.key, 'size', parseInt(e.target.value) || 0)}
                    className="w-16 rounded-md text-right tabular-nums"
                  />
                  <select
                    aria-label={`${cat.label} target unit`}
                    value={target.unit}
                    onChange={(e) => updateTarget(cat.key, 'unit', e.target.value)}
                    className="h-9 rounded-md border border-input bg-background/50 px-2 text-sm text-muted-foreground"
                  >
                    <option value="KB">KB</option>
                    <option value="MB">MB</option>
                  </select>
                </div>
              </div>
            )
          })}
        </div>

        <Separator />

        <Accordion>
          <AccordionItem value="quality-floors">
            <AccordionTrigger className="text-sm font-medium">
              Quality Floors <span className="ml-2 text-xs font-normal text-muted-foreground">advanced</span>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pt-2">
              <p className="text-xs text-muted-foreground">
                Engine stops compressing below these values and reports &quot;best effort&quot;.
              </p>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Images minimum quality</span>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      aria-label="Images minimum quality"
                      value={draft.qualityFloors.image.minQuality}
                      onChange={(e) =>
                        updateFloor('image.minQuality', parseInt(e.target.value) || 0)
                      }
                      className="w-16 rounded-md text-right tabular-nums"
                    />
                    <span className="w-4 text-xs text-muted-foreground">%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Videos minimum CRF</span>
                  <Input
                    type="number"
                    min={0}
                    max={51}
                    aria-label="Videos minimum CRF"
                    value={draft.qualityFloors.video.minCrf}
                    onChange={(e) => updateFloor('video.minCrf', parseInt(e.target.value) || 0)}
                    className="w-16 rounded-md text-right tabular-nums"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Videos minimum resolution</span>
                  <select
                    aria-label="Videos minimum resolution"
                    value={draft.qualityFloors.video.minResolution}
                    onChange={(e) => updateFloor('video.minResolution', e.target.value)}
                    className="h-9 rounded-md border border-input bg-background/50 px-2.5 text-sm"
                  >
                    <option value="480p">480p</option>
                    <option value="720p">720p</option>
                    <option value="1080p">1080p</option>
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">PDF minimum DPI</span>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={0}
                      aria-label="PDF minimum DPI"
                      value={draft.qualityFloors.pdf.minDpi}
                      onChange={(e) => updateFloor('pdf.minDpi', parseInt(e.target.value) || 0)}
                      className="w-16 rounded-md text-right tabular-nums"
                    />
                    <span className="w-6 text-xs text-muted-foreground">dpi</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">PDF minimum JPEG quality</span>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      aria-label="PDF minimum JPEG quality"
                      value={draft.qualityFloors.pdf.minJpegQuality}
                      onChange={(e) =>
                        updateFloor('pdf.minJpegQuality', parseInt(e.target.value) || 0)
                      }
                      className="w-16 rounded-md text-right tabular-nums"
                    />
                    <span className="w-4 text-xs text-muted-foreground">%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Documents media quality</span>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      aria-label="Documents media quality"
                      value={draft.qualityFloors.document.minMediaQuality}
                      onChange={(e) =>
                        updateFloor('document.minMediaQuality', parseInt(e.target.value) || 0)
                      }
                      className="w-16 rounded-md text-right tabular-nums"
                    />
                    <span className="w-4 text-xs text-muted-foreground">%</span>
                  </div>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-t border-destructive/50 bg-destructive/10 px-6 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-card p-4">
        <Button variant="ghost" onClick={handleCancel} disabled={!hasChanges}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!hasChanges || isSaving}>
          Save Changes
        </Button>
      </div>
    </div>
  )
}