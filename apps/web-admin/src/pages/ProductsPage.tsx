import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { hasPermission } from '../auth/permissions'
// requestJson مسؤول عن إضافة عنوان السيرفر تلقائيًا.
import { requestJson } from '../lib/http'

type Product = {
  id: string
  name: string
  description: string | null
  product_type: string
  base_sku: string | null
  base_price: string
  cost_price: string
  status: string
  category_name: string | null
  brand_name: string | null
  variants_count: number
}

type Variant = {
  id: string
  product_id: string
  product_name: string
  sku: string
  style_code: string | null
  primary_barcode: string | null
  cost_price: string
  selling_price: string
  status: string
  size_name: string | null
  size_code: string | null
  color_name: string | null
  color_code: string | null
  season_name: string | null
  collection_name: string | null
}

type ProductsPageProps = {
  companyId: string
}

type ApiResponse<T> = {
  data: T
}

function ProductsPage({ companyId }: ProductsPageProps) {
  const [products, setProducts] = useState<Product[]>([])
  const [variants, setVariants] = useState<Variant[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const { user } = useAuth()

  const canViewProducts = hasPermission(user, 'products.view')

  // ======================================================
  // loadProductsData
  // تجيب:
  // 1. المنتجات العامة Products
  // 2. الأصناف الفعلية للبيع Variants
  //
  // Product مثال:
  // Basic T-Shirt
  //
  // Variant مثال:
  // Basic T-Shirt / Black / Medium / Barcode
  // ======================================================
  async function loadProductsData() {
    setLoading(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()

      const productsUrl =
        `/api/catalog/products` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}`

      const variantsUrl =
        `/api/catalog/variants` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}`

      // تشغيل الطلبين بالتوازي لتسريع تحميل الصفحة.
      const [productsResponse, variantsResponse] = await Promise.all([
        requestJson<ApiResponse<Product[]>>(productsUrl),
        requestJson<ApiResponse<Variant[]>>(variantsUrl),
      ])

      setProducts(productsResponse.data)
      setVariants(variantsResponse.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown products error',
      )
    } finally {
      setLoading(false)
    }
  }

  // ======================================================
  // تحميل المنتجات والأصناف تلقائيًا عند فتح الصفحة.
  // ======================================================
  useEffect(() => {
    if (!canViewProducts || !companyId.trim()) {
      return
    }

    void loadProductsData()
  }, [canViewProducts, companyId])

  return (
    <section className="panel">
      <div className="section-header">
        <div>
          <h2>المنتجات والأصناف</h2>
          <p className="muted">
            هنا بنعرض المنتج العام والـ Variant الحقيقي اللي بيتباع ويتخزن.
          </p>
        </div>

        {canViewProducts ? (
          <button
            className="primary-button small-button"
            disabled={!companyId.trim() || loading}
            onClick={loadProductsData}
          >
            {loading ? 'جاري التحديث...' : 'تحديث البيانات'}
          </button>
        ) : null}
      </div>

      {error ? <p className="error-message">{error}</p> : null}

      <h3>Products</h3>

      {products.length === 0 ? (
        <p className="muted">
          {loading ? 'جاري تحميل المنتجات...' : 'لا توجد منتجات مسجلة حاليًا.'}
        </p>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>اسم المنتج</th>
                <th>Base SKU</th>
                <th>سعر البيع</th>
                <th>التكلفة</th>
                <th>عدد الـ Variants</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td>{product.name}</td>
                  <td>{product.base_sku || '-'}</td>
                  <td>{product.base_price}</td>
                  <td>{product.cost_price}</td>
                  <td>{product.variants_count}</td>
                  <td>{product.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Variants</h3>

      {variants.length === 0 ? (
        <p className="muted">
          {loading ? 'جاري تحميل الأصناف...' : 'لا توجد أصناف مسجلة حاليًا.'}
        </p>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>الصنف</th>
                <th>SKU</th>
                <th>Barcode</th>
                <th>المقاس</th>
                <th>اللون</th>
                <th>سعر البيع</th>
                <th>التكلفة</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {variants.map((variant) => (
                <tr key={variant.id}>
                  <td>{variant.product_name}</td>
                  <td>{variant.sku}</td>
                  <td>{variant.primary_barcode || '-'}</td>
                  <td>{variant.size_name || '-'}</td>
                  <td>{variant.color_name || '-'}</td>
                  <td>{variant.selling_price}</td>
                  <td>{variant.cost_price}</td>
                  <td>{variant.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default ProductsPage
