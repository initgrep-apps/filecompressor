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

import { useCallback, useEffect, useRef, useState } from "react"
import {
  RiEqualizerLine,
  RiFlashlightLine,
  RiSettings3Line,
  RiShieldCheckLine,
  RiTimeLine,
} from "@remixicon/react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { NumberStepper } from "@/components/NumberStepper"
import { useSettings } from "@/hooks/useSettings"
import { CATEGORY_TONES } from "@/lib/tokens"
import { cn } from "@/lib/utils"
import type {
  Category,
  CategoryTarget,
  MaxConcurrent,
  QualityFloors,
  Settings,
} from "@/types"

const SAVE_DEBOUNCE_MS = 400
const MAX_FLUSH_WRITES = 3
const SAVE_ERROR = "Could not save settings"
const RESET_ERROR = "Could not reset settings"
const SAVE_ERROR_ID = "settings-save"
const RESET_ERROR_ID = "settings-reset"

const SECTIONS = [
  { value: "general", label: "General", icon: RiSettings3Line },
  { value: "targets", label: "Targets", icon: RiEqualizerLine },
  { value: "floors", label: "Quality floors", icon: RiShieldCheckLine },
  { value: "performance", label: "Performance", icon: RiFlashlightLine },
  { value: "history", label: "History", icon: RiTimeLine },
] as const

type SectionId = (typeof SECTIONS)[number]["value"]

const CATEGORIES = [
  { key: "image", label: "Images", badge: "Image", formats: "JPEG, PNG, WebP, HEIC" },
  { key: "video", label: "Videos", badge: "Video", formats: "MP4, MOV" },
  { key: "pdf", label: "PDF", badge: "PDF", formats: "PDF documents" },
  { key: "document", label: "Documents", badge: "Document", formats: "DOCX, XLSX, PPTX" },
] as const

function targetFor(settings: Settings, key: Category): CategoryTarget {
  return settings.categoryTargets[key] ?? { size: 0, unit: "KB" }
}

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface SectionProps {
  draft: Settings
  onChange: (next: Settings) => void
}

function GeneralSection({
  draft,
  onChoose,
}: Pick<SectionProps, "draft"> & { onChoose: () => void }) {
  return (
    <FieldSet>
      <FieldLegend>General</FieldLegend>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="output-folder">Output folder</FieldLabel>
          <FieldDescription>
            Compressed copies are written here. Originals are never modified.
          </FieldDescription>
          <div className="flex items-center gap-2">
            <Input
              id="output-folder"
              readOnly
              value={draft.outputFolder}
              className="flex-1"
            />
            <Button variant="outline" onClick={onChoose}>
              Choose…
            </Button>
          </div>
        </Field>
        <Field>
          <FieldLabel>Category targets</FieldLabel>
          <FieldDescription>
            One size ceiling per category. Each file is compressed toward this
            target.
          </FieldDescription>
          <ul className="flex flex-col gap-1.5 text-sm">
            {CATEGORIES.map((category) => {
              const target = targetFor(draft, category.key)
              return (
                <li
                  key={category.key}
                  className="flex items-center justify-between gap-4"
                >
                  <span>{category.label}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {target.size} {target.unit}
                  </span>
                </li>
              )
            })}
          </ul>
        </Field>
      </FieldGroup>
    </FieldSet>
  )
}

function TargetsSection({ draft, onChange }: SectionProps) {
  const setTarget = (key: Category, patch: Partial<CategoryTarget>) => {
    const current = targetFor(draft, key)
    onChange({
      ...draft,
      categoryTargets: {
        ...draft.categoryTargets,
        [key]: { ...current, ...patch },
      },
    })
  }

  return (
    <FieldSet>
      <FieldLegend>Targets</FieldLegend>
      <FieldGroup>
        {CATEGORIES.map((category) => {
          const target = targetFor(draft, category.key)
          const tone = CATEGORY_TONES[category.key]
          return (
            <Field key={category.key} orientation="horizontal">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <Badge
                  variant="secondary"
                  className={cn(tone.tint, tone.border, tone.text)}
                >
                  {category.badge}
                </Badge>
                <FieldContent>
                  <FieldLabel htmlFor={`${category.key}-size`}>
                    {category.label}
                  </FieldLabel>
                  <FieldDescription>{category.formats}</FieldDescription>
                </FieldContent>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <NumberStepper
                  id={`${category.key}-size`}
                  value={target.size}
                  onValueChange={(size) => setTarget(category.key, { size })}
                  min={0}
                  ariaLabel={`${category.label} target size`}
                  className="w-32"
                />
                <Select
                  value={target.unit}
                  onValueChange={(unit) => {
                    if (unit !== null) setTarget(category.key, { unit })
                  }}
                >
                  <SelectTrigger
                    aria-label={`${category.label} target unit`}
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
            </Field>
          )
        })}
      </FieldGroup>
    </FieldSet>
  )
}

function FloorsSection({ draft, onChange }: SectionProps) {
  const setFloors = (floors: QualityFloors) =>
    onChange({ ...draft, qualityFloors: floors })
  const floors = draft.qualityFloors

  return (
    <FieldSet>
      <FieldLegend>Quality floors</FieldLegend>
      <FieldDescription>
        The engine stops compressing below these values and reports best effort.
      </FieldDescription>
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="image-min-quality">
            Images minimum quality
          </FieldLabel>
          <div className="flex shrink-0 items-center gap-1.5">
            <NumberStepper
              id="image-min-quality"
              value={floors.image.minQuality}
              onValueChange={(minQuality) =>
                setFloors({ ...floors, image: { minQuality } })
              }
              min={0}
              max={100}
              ariaLabel="Images minimum quality"
              className="w-32"
            />
            <span className="w-4 text-xs text-muted-foreground">%</span>
          </div>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="video-min-crf">Videos minimum CRF</FieldLabel>
          <NumberStepper
            id="video-min-crf"
            value={floors.video.minCrf}
            onValueChange={(minCrf) =>
              setFloors({ ...floors, video: { ...floors.video, minCrf } })
            }
            min={0}
            max={51}
            ariaLabel="Videos minimum CRF"
            className="w-32"
          />
        </Field>
        <Field orientation="horizontal">
          <FieldLabel>Videos minimum resolution</FieldLabel>
          <Select
            value={floors.video.minResolution}
            onValueChange={(minResolution) => {
              if (minResolution !== null) {
                setFloors({
                  ...floors,
                  video: { ...floors.video, minResolution },
                })
              }
            }}
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
        </Field>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="pdf-min-dpi">PDF minimum DPI</FieldLabel>
          <div className="flex shrink-0 items-center gap-1.5">
            <NumberStepper
              id="pdf-min-dpi"
              value={floors.pdf.minDpi}
              onValueChange={(minDpi) =>
                setFloors({ ...floors, pdf: { ...floors.pdf, minDpi } })
              }
              min={0}
              max={600}
              ariaLabel="PDF minimum DPI"
              className="w-32"
            />
            <span className="w-6 text-xs text-muted-foreground">dpi</span>
          </div>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="pdf-min-jpeg-quality">
            PDF minimum JPEG quality
          </FieldLabel>
          <div className="flex shrink-0 items-center gap-1.5">
            <NumberStepper
              id="pdf-min-jpeg-quality"
              value={floors.pdf.minJpegQuality}
              onValueChange={(minJpegQuality) =>
                setFloors({
                  ...floors,
                  pdf: { ...floors.pdf, minJpegQuality },
                })
              }
              min={0}
              max={100}
              ariaLabel="PDF minimum JPEG quality"
              className="w-32"
            />
            <span className="w-4 text-xs text-muted-foreground">%</span>
          </div>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="document-min-media-quality">
            Documents media quality
          </FieldLabel>
          <div className="flex shrink-0 items-center gap-1.5">
            <NumberStepper
              id="document-min-media-quality"
              value={floors.document.minMediaQuality}
              onValueChange={(minMediaQuality) =>
                setFloors({
                  ...floors,
                  document: { minMediaQuality },
                })
              }
              min={0}
              max={100}
              ariaLabel="Documents media quality"
              className="w-32"
            />
            <span className="w-4 text-xs text-muted-foreground">%</span>
          </div>
        </Field>
      </FieldGroup>
    </FieldSet>
  )
}

function PerformanceSection({ draft, onChange }: SectionProps) {
  return (
    <FieldSet>
      <FieldLegend>Performance</FieldLegend>
      <FieldDescription>
        How many files compress at once. Auto adapts to your machine (CPU
        cores).
      </FieldDescription>
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel>Simultaneous files</FieldLabel>
          <Select
            value={draft.performance.maxConcurrent}
            onValueChange={(maxConcurrent) => {
              if (maxConcurrent !== null) {
                onChange({
                  ...draft,
                  performance: { maxConcurrent: maxConcurrent as MaxConcurrent },
                })
              }
            }}
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
        </Field>
      </FieldGroup>
    </FieldSet>
  )
}

function HistorySection({ draft, onChange }: SectionProps) {
  return (
    <FieldSet>
      <FieldLegend>History</FieldLegend>
      <FieldDescription>
        Sessions older than this are removed automatically. Files on disk are
        never deleted.
      </FieldDescription>
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="history-retention-days">
            History retention (days)
          </FieldLabel>
          <NumberStepper
            id="history-retention-days"
            value={draft.history.retentionDays}
            onValueChange={(retentionDays) =>
              onChange({ ...draft, history: { retentionDays } })
            }
            min={1}
            max={3650}
            ariaLabel="History retention (days)"
            className="w-32"
          />
        </Field>
      </FieldGroup>
    </FieldSet>
  )
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { settings, loading, error, saveSettings, resetSettings, browseFolder } =
    useSettings()
  const [draft, setDraft] = useState<Settings | null>(null)
  const [section, setSection] = useState<SectionId>("general")
  const draftRef = useRef<Settings | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef<Promise<boolean> | null>(null)
  const dirtyRef = useRef(false)
  const seededRef = useRef(false)

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const persist = useCallback(async (): Promise<boolean> => {
    clearTimer()
    for (let writes = 0; writes < MAX_FLUSH_WRITES; writes++) {
      while (inFlightRef.current) await inFlightRef.current
      if (!dirtyRef.current || !draftRef.current) return true

      dirtyRef.current = false
      const request = saveSettings(draftRef.current)
      inFlightRef.current = request
      const saved = await request
      inFlightRef.current = null

      if (!saved) {
        dirtyRef.current = true
        toast.error(SAVE_ERROR, { id: SAVE_ERROR_ID })
        return false
      }
    }
    return !dirtyRef.current
  }, [saveSettings])

  useEffect(() => {
    if (!open) {
      seededRef.current = false
      if (dirtyRef.current) void persist()
      return
    }
    if (!seededRef.current && settings) {
      seededRef.current = true
      clearTimer()
      dirtyRef.current = false
      draftRef.current = settings
      setDraft(settings)
    }
  }, [open, settings, persist])

  useEffect(
    () => () => {
      if (dirtyRef.current) void persist()
    },
    [persist],
  )

  const commit = (next: Settings) => {
    draftRef.current = next
    setDraft(next)
    dirtyRef.current = true
    clearTimer()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void persist()
    }, SAVE_DEBOUNCE_MS)
  }

  const requestClose = async () => {
    const saved = await persist()
    if (saved) onOpenChange(false)
  }

  const handleOpenChange = (next: boolean) => {
    if (next) {
      onOpenChange(true)
      return
    }
    void requestClose()
  }

  const handleChoose = async () => {
    const folder = await browseFolder()
    if (folder && draftRef.current) {
      commit({ ...draftRef.current, outputFolder: folder })
    }
  }

  const handleReset = async () => {
    clearTimer()
    const wasDirty = dirtyRef.current
    dirtyRef.current = false
    while (inFlightRef.current) await inFlightRef.current
    dirtyRef.current = false

    const request = (async (): Promise<boolean> => {
      const defaults = await resetSettings()
      if (!defaults) {
        toast.error(RESET_ERROR, { id: RESET_ERROR_ID })
        return false
      }
      draftRef.current = defaults
      setDraft(defaults)
      dirtyRef.current = false
      return true
    })()
    inFlightRef.current = request
    const reset = await request
    inFlightRef.current = null
    if (!reset) dirtyRef.current = wasDirty
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="h-[540px] max-h-[90%] grid-rows-1 gap-0 overflow-hidden p-0 sm:max-w-[720px]">
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        {loading || !draft ? (
          <div className="p-6 text-sm text-muted-foreground">
            {error ?? "Loading settings…"}
          </div>
        ) : (
          <Tabs
            value={section}
            onValueChange={setSection}
            orientation="vertical"
            className="h-full min-h-0 gap-0"
          >
            <div className="w-[184px] shrink-0 border-r border-border p-2">
              <TabsList
                variant="line"
                aria-label="Settings sections"
                className="h-fit w-full flex-col items-stretch gap-0.5 bg-transparent p-0"
              >
                {SECTIONS.map(({ value, label, icon: Icon }) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    className="justify-start gap-2 px-3"
                  >
                    <Icon data-icon className="size-4" aria-hidden="true" />
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <ScrollArea className="min-h-0 flex-1">
                <TabsContent value="general" className="p-6">
                  <GeneralSection draft={draft} onChoose={handleChoose} />
                </TabsContent>
                <TabsContent value="targets" className="p-6">
                  <TargetsSection draft={draft} onChange={commit} />
                </TabsContent>
                <TabsContent value="floors" className="p-6">
                  <FloorsSection draft={draft} onChange={commit} />
                </TabsContent>
                <TabsContent value="performance" className="p-6">
                  <PerformanceSection draft={draft} onChange={commit} />
                </TabsContent>
                <TabsContent value="history" className="p-6">
                  <HistorySection draft={draft} onChange={commit} />
                </TabsContent>
              </ScrollArea>
              <div className="flex shrink-0 justify-end gap-2 border-t border-border p-4">
                <Button variant="ghost" onClick={handleReset}>
                  Reset defaults
                </Button>
                <Button onClick={() => handleOpenChange(false)}>Done</Button>
              </div>
            </div>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}
