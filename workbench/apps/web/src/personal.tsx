import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Check, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import {
  catalogFilters,
  type Personal,
  type Preferences,
  type Preset,
  pageSizes,
  presetLimit,
} from '../../../packages/personal/model'
import { Select } from './select'
import { Dialog, ErrorBox, Field, Form, Loading, Notice, Panel, request, useAccess } from './ui'
import './personal.css'

const endpoint = '/me/preferences'
export function usePersonal() {
  const owner = useAccess().session?.id
  const query = useQuery({
    queryKey: [endpoint, owner],
    enabled: !!owner,
    retry: false,
    queryFn: () => request<Personal>(endpoint),
  })
  return { owner, ...query }
}

function usePersonalWrite(owner: string) {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => request('/me/' + path, body),
    onSuccess: () => cache.invalidateQueries({ queryKey: [endpoint, owner] }),
  })
}

export function PersonalSettings() {
  const personal = usePersonal()
  if (personal.isPending) return <Loading />
  if (!personal.data || !personal.owner)
    return <ErrorBox error={personal.error} retry={() => void personal.refetch()} />
  return <SettingsContent key={personal.owner} owner={personal.owner} data={personal.data} />
}

function SettingsContent({ owner, data }: { owner: string; data: Personal }) {
  const write = usePersonalWrite(owner)
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<Partial<Preferences>>({})
  const [action, setAction] = useState<{ preset: Preset; remove: boolean } | null>(null)
  const [name, setName] = useState('')
  const view = draft.view ?? data.view,
    pageSize = draft.pageSize ?? data.pageSize
  function manage(preset: Preset, remove: boolean) {
    write.reset()
    setNotice('')
    setAction({ preset, remove })
    setName(preset.name)
  }
  return (
    <div className="stack">
      <Panel title="发现页显示">
        <Form
          className="panel-body stack"
          onSubmit={() => {
            setNotice('')
            write.mutate(
              { path: 'preferences', body: { view, pageSize } },
              {
                onSuccess: () => {
                  setNotice('发现页显示设置已保存。')
                  setDraft({})
                },
              },
            )
          }}
        >
          <div className="fields-2">
            <Field label="默认视图">
              <Select
                value={view}
                onValueChange={(v) => setDraft({ ...draft, view: v as Preferences['view'] })}
                options={[
                  { value: 'table', label: '表格视图' },
                  { value: 'grid', label: '网格视图' },
                ]}
              />
            </Field>
            <Field label="默认每页数量">
              <Select
                value={String(pageSize)}
                onValueChange={(v) =>
                  setDraft({ ...draft, pageSize: Number(v) as Preferences['pageSize'] })
                }
                options={pageSizes.map((n) => ({ value: String(n), label: n + ' 条 / 页' }))}
              />
            </Field>
          </div>
          <p className="muted">从导航打开发现商品时使用这些设置。带有视图或分页参数的链接按链接显示。</p>
          <div>
            <button
              className="primary"
              type="submit"
              disabled={write.isPending || (view === data.view && pageSize === data.pageSize)}
            >
              <Check /> 保存显示设置
            </button>
          </div>
          {!action && <ErrorBox error={write.error} />}
        </Form>
      </Panel>
      <Panel
        title="我的选品预设"
        extra={
          <small>
            {data.presets.length} / {presetLimit}
          </small>
        }
      >
        <div className="panel-body stack">
          {data.presets.length ? (
            <ul className="personal-presets">
              {data.presets.map((preset) => (
                <li key={preset.id}>
                  <div>
                    <Bookmark size={15} />
                    <strong>{preset.name}</strong>
                  </div>
                  <div>
                    <button type="button" className="linkbtn" onClick={() => manage(preset, false)}>
                      <Pencil />
                      重命名
                    </button>
                    <button type="button" className="linkbtn" onClick={() => manage(preset, true)}>
                      <Trash2 />
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">还没有预设。在「发现商品」筛好商品，打开「我的预设」即可保存。</p>
          )}
        </div>
      </Panel>
      {notice && <Notice success>{notice}</Notice>}
      {action && (
        <Dialog
          title={action.remove ? '删除个人预设' : '重命名个人预设'}
          onClose={() => {
            if (!write.isPending) setAction(null)
          }}
        >
          <Form
            className="dialog-body stack"
            onSubmit={() => {
              const path = 'presets/' + action.preset.id + (action.remove ? '/delete' : '/rename')
              write.mutate(
                { path, body: action.remove ? {} : { name: name.trim() } },
                {
                  onSuccess: () => {
                    setNotice(action.remove ? '个人预设已删除。' : '个人预设已重命名。')
                    setAction(null)
                  },
                },
              )
            }}
          >
            {action.remove ? (
              <p>删除「{action.preset.name}」？</p>
            ) : (
              <Field label="预设名称">
                <input value={name} required maxLength={40} onChange={(e) => setName(e.target.value)} />
              </Field>
            )}
            <ErrorBox error={write.error} />
            <div className="dialog-actions">
              <button type="button" disabled={write.isPending} onClick={() => setAction(null)}>
                取消
              </button>
              <button
                type="submit"
                className={action.remove ? 'danger' : 'primary'}
                disabled={write.isPending || (!action.remove && !name.trim())}
              >
                {action.remove ? '确认删除' : '保存名称'}
              </button>
            </div>
          </Form>
        </Dialog>
      )}
    </div>
  )
}

export function PresetsDialog({
  params,
  apply,
  close,
}: {
  params: URLSearchParams
  apply: (filters: Preset['filters']) => void
  close: () => void
}) {
  const personal = usePersonal()
  return (
    <Dialog title="我的选品预设" onClose={close}>
      <div className="dialog-body stack">
        {personal.isPending ? (
          <Loading />
        ) : !personal.data || !personal.owner ? (
          <ErrorBox error={personal.error} retry={() => void personal.refetch()} />
        ) : (
          <CatalogPresets
            key={personal.owner}
            owner={personal.owner}
            data={personal.data}
            params={params}
            apply={apply}
          />
        )}
      </div>
    </Dialog>
  )
}

function CatalogPresets({
  owner,
  data,
  params,
  apply,
}: {
  owner: string
  data: Personal
  params: URLSearchParams
  apply: (filters: Preset['filters']) => void
}) {
  const [chosen, setChosen] = useState('')
  const [name, setName] = useState('')
  const [notice, setNotice] = useState('')
  const write = usePersonalWrite(owner)
  const preset = data.presets.find((p) => p.id === chosen)
  const filters = catalogFilters(params)
  return (
    <>
      {data.presets.length ? (
        <div className="stack">
          <Field label="已保存的预设">
            <Select
              value={chosen}
              onValueChange={setChosen}
              options={[
                { value: '', label: '选择一个预设' },
                ...data.presets.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </Field>
          <div>
            <button
              type="button"
              disabled={!preset || write.isPending}
              onClick={() => {
                if (preset) apply(preset.filters)
              }}
            >
              应用预设
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">还没有个人预设。可以将当前筛选和排序保存下来，下次直接使用。</p>
      )}
      <Form
        className="personal-save stack"
        onSubmit={() => {
          setNotice('')
          write.mutate(
            { path: 'presets', body: { name: name.trim(), filters } },
            {
              onSuccess: (result) => {
                setChosen((result as Preset).id)
                setName('')
                setNotice('已保存当前筛选和排序。')
              },
            },
          )
        }}
      >
        <Field
          label="新预设名称"
          hint={'仅自己可见，已使用 ' + data.presets.length + ' / ' + presetLimit + ' 个预设。'}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={40}
            placeholder="例如：家居低价热销"
          />
        </Field>
        <div>
          <button
            type="submit"
            className="primary"
            disabled={!name.trim() || write.isPending || data.presets.length >= presetLimit}
          >
            <Bookmark />
            保存当前条件
          </button>
        </div>
        <ErrorBox error={write.error} />
        {notice && <Notice success>{notice}</Notice>}
      </Form>
    </>
  )
}
