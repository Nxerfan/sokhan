'use client'

import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Plus, Trash2, Package, Upload } from 'lucide-react'
import { toast } from 'sonner'

type Product = { id: string; name: string; description: string; price: number; availability: string; externalSource: string }

export function ProductsPanel() {
  const locale = useLocale()
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [description, setDescription] = useState('')
  const [availability, setAvailability] = useState('in_stock')

  async function load() {
    const res = await fetch('/api/products')
    const data = await res.json()
    setProducts(data.products ?? [])
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  async function createProduct(e: React.FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, price: Number(price) || 0, description, availability }),
    })
    if (!res.ok) { toast.error('Failed'); return }
    toast.success(locale === 'fa' ? 'ذخیره شد' : 'Saved')
    setName(''); setPrice(''); setDescription(''); setAvailability('in_stock'); setShowForm(false)
    load()
  }

  async function deleteProduct(id: string) {
    await fetch(`/api/products?id=${id}`, { method: 'DELETE' })
    toast.success(locale === 'fa' ? 'حذف شد' : 'Deleted')
    load()
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight flex items-center gap-2">
          <Package className="h-5 w-5" />
          {locale === 'fa' ? 'کاتالوگ محصولات' : 'Product Catalog'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {locale === 'fa' ? 'محصولات برای پاسخگویی هوشمند به سوالات بازدیدکنندگان.' : 'Products for AI-powered Q&A about availability and pricing.'}
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="font-display text-base">{locale === 'fa' ? 'محصولات' : 'Products'}</CardTitle>
            <Button onClick={() => setShowForm(!showForm)} className="gap-2">
              <Plus className="h-4 w-4" />
              {locale === 'fa' ? 'افزودن' : 'Add'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {showForm && (
            <form onSubmit={createProduct} className="space-y-3 border-b border-border p-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>{locale === 'fa' ? 'نام محصول' : 'Product name'}</Label>
                  <Input value={name} onChange={e => setName(e.target.value)} required dir="auto" />
                </div>
                <div className="space-y-2">
                  <Label>{locale === 'fa' ? 'قیمت (تومان)' : 'Price (Toman)'}</Label>
                  <Input type="number" value={price} onChange={e => setPrice(e.target.value)} dir="ltr" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{locale === 'fa' ? 'توضیحات' : 'Description'}</Label>
                <Textarea value={description} onChange={e => setDescription(e.target.value)} dir="auto" rows={2} />
              </div>
              <Button type="submit" className="gap-2">{locale === 'fa' ? 'ذخیره' : 'Save'}</Button>
            </form>
          )}
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">{locale === 'fa' ? 'در حال بارگذاری...' : 'Loading...'}</div>
          ) : products.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center">
              <Package className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{locale === 'fa' ? 'هنوز محصولی ثبت نشده است' : 'No products yet'}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {products.map(p => (
                <li key={p.id} className="flex items-start justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{p.name}</span>
                      <Badge variant="outline" className="h-4 px-1 text-[9px]">
                        {p.externalSource === 'woocommerce' ? 'WooCommerce' : p.externalSource === 'csv' ? 'CSV' : locale === 'fa' ? 'دستی' : 'Manual'}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground truncate">
                      {p.price.toLocaleString()} {locale === 'fa' ? 'تومان' : 'Toman'} · {p.availability}
                    </p>
                    {p.description && <p className="mt-0.5 text-xs text-muted-foreground/70 truncate">{p.description}</p>}
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => deleteProduct(p.id)}>
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
