import { Check, ChevronDown } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import './select.css'

type Option = { value: string; label: string; disabled?: boolean }
type SelectProps = {
  options: readonly Option[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  variant?: 'field' | 'filter' | 'compact' | 'quiet'
  prefix?: ReactNode
  disabled?: boolean
  name?: string
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

export function selectOptions(labels: Record<string, string>): Option[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }))
}

function positionMenu(button: HTMLElement, menu: HTMLElement) {
  const anchor = button.getBoundingClientRect()
  const viewport = window.visualViewport
  const left = (viewport?.offsetLeft ?? 0) + 8
  const top = (viewport?.offsetTop ?? 0) + 8
  const width = (viewport?.width ?? document.documentElement.clientWidth) - 16
  const bottom = top + (viewport?.height ?? window.innerHeight) - 16
  menu.style.maxWidth = width + 'px'
  menu.style.minWidth = Math.min(width, Math.max(168, anchor.width)) + 'px'
  const above = Math.max(0, anchor.top - top - 5)
  const below = Math.max(0, bottom - anchor.bottom - 5)
  const desiredHeight = Math.min(menu.scrollHeight + 2, 304)
  const opensUp = below < desiredHeight && above > below
  menu.style.maxHeight = Math.min(304, opensUp ? above : below) + 'px'
  menu.style.left = Math.max(left, Math.min(anchor.left, left + width - menu.offsetWidth)) + 'px'
  menu.style.top = (opensUp ? anchor.top - 5 - menu.offsetHeight : anchor.bottom + 5) + 'px'
}

export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  variant = 'field',
  prefix,
  disabled,
  name,
  id,
  'aria-label': label,
  'aria-describedby': description,
}: SelectProps) {
  const uniqueId = useId()
  const listId = uniqueId + '-list'
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [localValue, setLocalValue] = useState(defaultValue)
  const [expanded, setExpanded] = useState(false)
  const [highlight, setHighlight] = useState<string>()
  const search = useRef({ text: '', time: 0 })
  const enabled = options.filter((option) => !option.disabled)
  const selected = options.find((option) => option.value === (value ?? localValue)) ?? enabled[0]
  const open = expanded && !disabled && options.length > 0
  const active =
    enabled.find((option) => option.value === highlight) ??
    (selected?.disabled ? undefined : selected) ??
    enabled[0]
  const activeId = active && listId + '-' + options.indexOf(active)

  function choose(option?: Option) {
    if (option && !option.disabled && option.value !== selected?.value) {
      if (value === undefined) setLocalValue(option.value)
      onValueChange?.(option.value)
    }
    setExpanded(false)
  }

  function show(option = selected) {
    search.current.text = ''
    setHighlight(option?.value)
    setExpanded(true)
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    const key = event.key
    if (key === 'Tab') {
      if (open) choose(active)
      return
    }
    if (key === 'Escape') {
      if (!open) return
      event.stopPropagation()
      setExpanded(false)
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      const direction = key === 'ArrowDown' ? 1 : -1
      if (open && event.altKey && key === 'ArrowUp') choose(active)
      else if (!open) show()
      else {
        const index = active ? enabled.indexOf(active) + direction : 0
        setHighlight(enabled[Math.max(0, Math.min(enabled.length - 1, index))]?.value)
      }
    } else if (key === 'Home' || key === 'End') {
      show(key === 'Home' ? enabled[0] : enabled.at(-1))
    } else if (key === 'Enter' || key === ' ') {
      if (open) choose(active)
      else show()
    } else if (!event.altKey && key.length === 1) {
      const now = performance.now()
      const char = key.toLocaleLowerCase()
      const text = (now - search.current.time < 650 ? search.current.text : '') + char
      search.current = { text, time: now }
      const prefix = [...text].every((c) => c === char) ? char : text
      const from = open ? active : selected
      const start = from ? enabled.indexOf(from) + (prefix.length === 1 ? 1 : 0) : 0
      const match = [...enabled.slice(start), ...enabled.slice(0, start)].find((option) =>
        option.label.toLocaleLowerCase().startsWith(prefix),
      )
      if (match && open) setHighlight(match.value)
      else if (match) choose(match)
    } else return
    event.preventDefault()
  }

  useEffect(() => {
    const form = button.current?.form
    function reset(event: Event) {
      queueMicrotask(() => {
        if (event.defaultPrevented) return
        setLocalValue(defaultValue)
        setExpanded(false)
      })
    }
    form?.addEventListener('reset', reset)
    return () => form?.removeEventListener('reset', reset)
  }, [defaultValue])

  useLayoutEffect(() => {
    const trigger = button.current
    const panel = menu.current
    if (!open || !trigger || !panel) return
    function place(event?: Event) {
      if (event?.target === panel) return
      if (trigger && panel) positionMenu(trigger, panel)
    }
    function outside(event: Event) {
      const target = event.target
      if (target instanceof Node && !trigger?.contains(target) && !panel?.contains(target)) {
        setExpanded(false)
      }
    }
    place()
    const observer = new ResizeObserver(() => place())
    observer.observe(trigger)
    observer.observe(panel)
    const visibility = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) setExpanded(false)
    })
    visibility.observe(trigger)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    return () => {
      observer.disconnect()
      visibility.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
    }
  }, [open])

  useLayoutEffect(() => {
    const panel = menu.current
    const row = activeId && document.getElementById(activeId)
    if (!open || !row || !panel) return
    const bounds = panel.getBoundingClientRect()
    const item = row.getBoundingClientRect()
    if (item.bottom > bounds.bottom - 5) panel.scrollTop += item.bottom - bounds.bottom + 5
    else if (item.top < bounds.top + 5) panel.scrollTop += item.top - bounds.top - 5
  }, [open, activeId])

  return (
    <>
      {name && (
        <input
          type="hidden"
          name={name}
          value={selected?.value ?? ''}
          disabled={disabled || !selected || selected.disabled}
        />
      )}
      <button
        ref={button}
        type="button"
        role="combobox"
        id={id ?? uniqueId}
        aria-label={label}
        aria-describedby={description}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? activeId : undefined}
        disabled={disabled || !options.length}
        className={'wb-select wb-select--' + variant}
        data-filtered={(variant === 'filter' && !!selected?.value) || undefined}
        onClick={() => (open ? setExpanded(false) : show())}
        onKeyDown={onKeyDown}
      >
        {prefix && (
          <span className="wb-select-prefix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <span className="wb-select-value">{selected?.label ?? '—'}</span>
        <ChevronDown aria-hidden="true" className="wb-select-caret" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={listId}
            role="listbox"
            aria-label={label ?? button.current?.labels?.[0]?.textContent ?? undefined}
            className="wb-select-menu"
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                id={listId + '-' + index}
                role="option"
                type="button"
                tabIndex={-1}
                aria-selected={selected === option}
                disabled={option.disabled}
                data-active={active === option || undefined}
                className="wb-select-option"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  choose(option)
                  button.current?.focus({ preventScroll: true })
                }}
              >
                <span>{option.label}</span>
                {selected === option && <Check aria-hidden="true" />}
              </button>
            ))}
          </div>,
          button.current?.closest('dialog') ?? document.body,
        )}
    </>
  )
}
