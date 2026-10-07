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

import { useState, useEffect, useRef, type ReactNode } from 'react'
import {
  RiEqualizerLine,
  RiFlashlightLine,
  RiFolderLine,
  RiShieldCheckLine,
  RiTimeLine,
} from '@remixicon/react'
import { useSettings } from '@/hooks/useSettings'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { NumberStepper } from '@/components/NumberStepper'
import { CATEGORY_TONES } from '@/lib/tokens'
import { cn } from '@/lib/utils'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Settings, CategoryTarget, MaxConcurrent, PerformanceSettings } from '@/types'
import { useAutoCollapse } from '@/hooks/useAutoCollapse'

function SettingsScrollArea({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useAutoCollapse(scrollRef)
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
      {children}
    </div>
  )
}

const ICON_TILES = {
  folder: {
    icon: RiFolderLine,
    tint: 'bg-primary/12',
    text: 'text-primary',
  },
  targets: {
    icon: RiEqualizerLine,
    tint: 'bg-blue-500/12',
    text: 'text-blue-600',
  },
  performance: {
    icon: RiFlashlightLine,
    tint: 'bg-violet-500/12',
    text: 'text-violet-600',
  },
  floors: {
    icon: RiShieldCheckLine,
    tint: 'bg-destructive/15',
    text: 'text-destructive',
  },
  history: {
    icon: RiTimeLine,
    tint: 'bg-amber-500/12',
    text: 'text-amber-600',
  },
} as const

type IconTileKey = keyof typeof ICON_TILES

function CardIcon({ tile }: { tile: IconTileKey }) {
  const { icon: Icon, tint, text } = ICON_TILES[tile]
  return (
    <span
      data-slot="card-icon"
      className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', tint, text)}
    >
      <Icon size={16} aria-hidden="true" />
    </span>
  )
}

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

  const updatePerformance = (field: keyof PerformanceSettings, value: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      return { ...prev, performance: { ...prev.performance, [field]: value as MaxConcurrent } }
    })
  }

  const updateHistoryRetention = (value: number) => {
    setDraft((prev) => {
      if (!prev) return prev
      return { ...prev, history: { ...prev.history, retentionDays: value } }
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
      <SettingsScrollArea>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Preferences</h2>
          <button
            type="button"
            onClick={handleReset}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            Reset to defaults
          </button>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <CardIcon tile="folder" />
              <div className="min-w-0">
                <CardTitle className="text-sm">Output Folder</CardTitle>
                <CardDescription>
                  Compressed files are saved here. Originals are never modified.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="flex h-9 flex-1 items-center gap-2 rounded-md border border-input bg-background/50 px-3 text-sm text-muted-foreground">
                <RiFolderLine size={14} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{draft.outputFolder}</span>
              </div>
              <Button variant="outline" size="sm" onClick={handleBrowse}>
                Browse
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <CardIcon tile="targets" />
              <div className="min-w-0">
                <CardTitle className="text-sm">Category Targets</CardTitle>
                <CardDescription>
                  Maximum file size per category. Applied to all files in that category.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              {categories.map((cat) => {
                const target = draft.categoryTargets[cat.key] ?? { size: 0, unit: 'KB' }
                return (
                  <Field key={cat.key}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <Badge
                          variant="secondary"
                          className={cn(
                            CATEGORY_TONES[cat.key].tint,
                            CATEGORY_TONES[cat.key].border,
                            CATEGORY_TONES[cat.key].text,
                          )}
                        >
                          {cat.badge}
                        </Badge>
                        <FieldLabel htmlFor={`${cat.key}-size`} className="text-sm">
                          {cat.label}
                        </FieldLabel>
                        <span className="text-xs text-muted-foreground">{cat.formats}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <NumberStepper
                          id={`${cat.key}-size`}
                          value={target.size}
                          onValueChange={(n) => updateTarget(cat.key, 'size', n)}
                          min={0}
                          ariaLabel={`${cat.label} target size`}
                          className="w-32"
                        />
                        <Select
                          value={target.unit}
                          onValueChange={(v) => { if (v !== null) updateTarget(cat.key, 'unit', v) }}
                        >
                          <SelectTrigger
                            aria-label={`${cat.label} target unit`}
                            className="w-20"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="KB">KB</SelectItem>
                            <SelectItem value="MB">MB</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </Field>
                )
              })}
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <CardIcon tile="performance" />
              <div className="min-w-0">
                <CardTitle className="text-sm">Performance</CardTitle>
                <CardDescription>
                  How many files compress at once. Auto adapts to your machine (CPU cores).
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel className="text-sm">Simultaneous files</FieldLabel>
                <Select
                  value={draft.performance.maxConcurrent}
                  onValueChange={(v) => { if (v !== null) updatePerformance('maxConcurrent', v) }}
                >
                  <SelectTrigger aria-label="Simultaneous files" className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="2">2</SelectItem>
                    <SelectItem value="3">3</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <CardIcon tile="floors" />
              <div className="min-w-0">
                <CardTitle className="text-sm">Quality Floors</CardTitle>
                <CardDescription>
                  Engine stops compressing below these values and reports best effort.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem value="quality-floors">
                <AccordionTrigger className="text-sm font-medium">
                  Advanced
                </AccordionTrigger>
                <AccordionContent className="space-y-3 pt-2">
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="image-min-quality" className="text-sm">
                        Images minimum quality
                      </FieldLabel>
                      <div className="flex items-center gap-1.5">
                        <NumberStepper
                          id="image-min-quality"
                          value={draft.qualityFloors.image.minQuality}
                          onValueChange={(n) => updateFloor('image.minQuality', n)}
                          min={0}
                          max={100}
                          ariaLabel="Images minimum quality"
                          className="w-32"
                        />
                        <span className="w-4 text-xs text-muted-foreground">%</span>
                      </div>
                    </div>
                    <FieldDescription>Minimum JPEG/PNG quality percentage.</FieldDescription>
                  </Field>
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="video-min-crf" className="text-sm">
                        Videos minimum CRF
                      </FieldLabel>
                      <NumberStepper
                        id="video-min-crf"
                        value={draft.qualityFloors.video.minCrf}
                        onValueChange={(n) => updateFloor('video.minCrf', n)}
                        min={0}
                        max={51}
                        ariaLabel="Videos minimum CRF"
                        className="w-32"
                      />
                    </div>
                    <FieldDescription>Higher CRF = lower quality floor.</FieldDescription>
                  </Field>
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel className="text-sm">Videos minimum resolution</FieldLabel>
                      <Select
                        value={draft.qualityFloors.video.minResolution}
                        onValueChange={(v) => { if (v !== null) updateFloor('video.minResolution', v) }}
                      >
                        <SelectTrigger
                          aria-label="Videos minimum resolution"
                          className="w-24"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="480p">480p</SelectItem>
                          <SelectItem value="720p">720p</SelectItem>
                          <SelectItem value="1080p">1080p</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </Field>
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="pdf-min-dpi" className="text-sm">
                        PDF minimum DPI
                      </FieldLabel>
                      <div className="flex items-center gap-1.5">
                        <NumberStepper
                          id="pdf-min-dpi"
                          value={draft.qualityFloors.pdf.minDpi}
                          onValueChange={(n) => updateFloor('pdf.minDpi', n)}
                          min={0}
                          max={600}
                          ariaLabel="PDF minimum DPI"
                          className="w-32"
                        />
                        <span className="w-6 text-xs text-muted-foreground">dpi</span>
                      </div>
                    </div>
                  </Field>
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="pdf-min-jpeg-quality" className="text-sm">
                        PDF minimum JPEG quality
                      </FieldLabel>
                      <div className="flex items-center gap-1.5">
                        <NumberStepper
                          id="pdf-min-jpeg-quality"
                          value={draft.qualityFloors.pdf.minJpegQuality}
                          onValueChange={(n) => updateFloor('pdf.minJpegQuality', n)}
                          min={0}
                          max={100}
                          ariaLabel="PDF minimum JPEG quality"
                          className="w-32"
                        />
                        <span className="w-4 text-xs text-muted-foreground">%</span>
                      </div>
                    </div>
                  </Field>
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="document-min-media-quality" className="text-sm">
                        Documents media quality
                      </FieldLabel>
                      <div className="flex items-center gap-1.5">
                        <NumberStepper
                          id="document-min-media-quality"
                          value={draft.qualityFloors.document.minMediaQuality}
                          onValueChange={(n) => updateFloor('document.minMediaQuality', n)}
                          min={0}
                          max={100}
                          ariaLabel="Documents media quality"
                          className="w-32"
                        />
                        <span className="w-4 text-xs text-muted-foreground">%</span>
                      </div>
                    </div>
                  </Field>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <CardIcon tile="history" />
              <div className="min-w-0">
                <CardTitle className="text-sm">History</CardTitle>
                <CardDescription>
                  Sessions older than this are removed automatically. Files on disk are never deleted.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor="history-retention-days" className="text-sm">
                  History retention (days)
                </FieldLabel>
                <NumberStepper
                  id="history-retention-days"
                  value={draft.history.retentionDays}
                  onValueChange={updateHistoryRetention}
                  min={1}
                  max={3650}
                  ariaLabel="History retention (days)"
                  className="w-32"
                />
              </div>
            </Field>
          </CardContent>
        </Card>
      </SettingsScrollArea>

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