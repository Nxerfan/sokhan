'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Building2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from './members-panel'

type Department = { id: string; name: string }

export function DepartmentsPanel() {
  const t = useTranslations('settings')
  const tc = useTranslations('common')
  const [depts, setDepts] = useState<Department[]>([])
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    const res = await fetch('/api/departments')
    const data = await res.json()
    setDepts(data.departments ?? [])
    setLoading(false)
  }

  useEffect(() => { // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [])

  async function onAdd(e: React.FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/departments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? 'Failed')
      return
    }
    setName('')
    toast.success(t('saved'))
    load()
  }

  async function onDelete(id: string) {
    const res = await fetch(`/api/departments?id=${id}`, { method: 'DELETE' })
    if (!res.ok) {
      toast.error('Failed')
      return
    }
    toast.success(t('saved'))
    load()
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <PanelHeader title={t('departmentsTitle')} hint={t('departmentsHint')} />

      <Card>
        <CardHeader>
          <CardTitle className="font-display text-base">{t('addDepartment')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onAdd} className="flex gap-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('departmentName')}
              required
            />
            <Button type="submit" className="gap-2">
              <Plus className="h-4 w-4" />
              {t('create')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">{tc('loading')}</div>
          ) : depts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center">
              <Building2 className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{t('noDepartments')}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {depts.map((d) => (
                <li key={d.id} className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <span className="text-sm font-medium">{d.name}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(d.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
