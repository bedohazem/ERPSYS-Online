import { useEffect, useMemo, useState } from 'react'
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

// ======================================================
// تنسيق أسعار المنتجات والأصناف.
// ======================================================
const catalogCurrencyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

function formatCatalogCurrency(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? catalogCurrencyFormatter.format(numericValue)
    : '-'
}

// ======================================================
// ترجمة أنواع المنتجات المعرفة في قاعدة البيانات.
// ======================================================
function translateProductType(productType: string) {
  const typeLabels: Record<string, string> = {
    general: 'منتج عام',
    fashion: 'ملابس وأزياء',
  }

  return typeLabels[productType] || productType
}

function getProductTypeClass(productType: string) {
  return productType === 'fashion'
    ? 'catalog-type-badge catalog-type-fashion'
    : 'catalog-type-badge catalog-type-general'
}

// ======================================================
// ترجمة حالات المنتجات والأصناف.
// ======================================================
function translateCatalogStatus(status: string) {
  const statusLabels: Record<string, string> = {
    active: 'نشط',
    inactive: 'غير نشط',
    draft: 'مسودة',
  }

  return statusLabels[status] || status
}

function getCatalogStatusClass(status: string) {
  if (status === 'active') {
    return 'status-badge status-badge-success'
  }

  if (status === 'inactive') {
    return 'status-badge status-badge-danger'
  }

  if (status === 'draft') {
    return 'status-badge status-badge-warning'
  }

  return 'status-badge'
}

function ProductsPage({ companyId }: ProductsPageProps) {
  const [products, setProducts] = useState<Product[]>([])
  const [variants, setVariants] = useState<Variant[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // ======================================================
  // مؤشرات مختصرة محسوبة من المنتجات والأصناف المحملة.
  // ======================================================
  const catalogSummary = useMemo(() => {
    return {
      productsCount: products.length,
      variantsCount: variants.length,

      activeProductsCount: products.filter(
        (product) => product.status === 'active',
      ).length,

      activeVariantsCount: variants.filter(
        (variant) => variant.status === 'active',
      ).length,
    }
  }, [products, variants])

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
    <>
      {/* ==================================================
        عنوان الصفحة
    ================================================== */}
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>المنتجات والأصناف</h2>

            <p className="muted">
              إدارة المنتجات العامة والأصناف الفعلية القابلة للبيع والتخزين.
            </p>
          </div>

          {canViewProducts ? (
            <div className="section-actions">
              <span className="record-count-badge">{products.length} منتج</span>

              <span className="record-count-badge">{variants.length} صنف</span>

              <button
                type="button"
                className="primary-button small-button"
                disabled={!companyId.trim() || loading}
                onClick={loadProductsData}
              >
                {loading ? 'جاري التحديث...' : 'تحديث البيانات'}
              </button>
            </div>
          ) : null}
        </div>

        {error ? <p className="error-message">{error}</p> : null}
      </section>

      {/* ==================================================
        مؤشرات الكتالوج
    ================================================== */}
      <section className="mini-cards-grid catalog-summary-grid">
        <article className="mini-card catalog-summary-card">
          <span>إجمالي المنتجات</span>

          <strong>{catalogSummary.productsCount}</strong>
        </article>

        <article className="mini-card catalog-summary-card">
          <span>إجمالي الأصناف</span>

          <strong>{catalogSummary.variantsCount}</strong>
        </article>

        <article className="mini-card catalog-summary-card">
          <span>المنتجات النشطة</span>

          <strong>{catalogSummary.activeProductsCount}</strong>
        </article>

        <article className="mini-card catalog-summary-card">
          <span>الأصناف النشطة</span>

          <strong>{catalogSummary.activeVariantsCount}</strong>
        </article>
      </section>

      {/* ==================================================
        المنتجات العامة
    ================================================== */}
      <section className="panel">
        <div className="section-header catalog-table-header">
          <div>
            <h2>المنتجات العامة</h2>

            <p className="muted">
              تعريف المنتج الأساسي قبل تقسيمه إلى مقاسات وألوان.
            </p>
          </div>

          <span className="record-count-badge">{products.length} منتج</span>
        </div>

        {products.length === 0 ? (
          <p className="muted">
            {loading
              ? 'جاري تحميل المنتجات...'
              : 'لا توجد منتجات مسجلة حاليًا.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>اسم المنتج</th>
                  <th>النوع</th>
                  <th>التصنيف</th>
                  <th>العلامة التجارية</th>
                  <th>Base SKU</th>
                  <th>سعر البيع</th>
                  <th>التكلفة</th>
                  <th>عدد الأصناف</th>
                  <th>الحالة</th>
                </tr>
              </thead>

              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <strong className="catalog-product-name">
                        {product.name}
                      </strong>
                    </td>

                    <td>
                      <span
                        className={getProductTypeClass(product.product_type)}
                      >
                        {translateProductType(product.product_type)}
                      </span>
                    </td>

                    <td>{product.category_name || '-'}</td>
                    <td>{product.brand_name || '-'}</td>

                    <td>
                      {product.base_sku ? (
                        <span className="catalog-code">{product.base_sku}</span>
                      ) : (
                        '-'
                      )}
                    </td>

                    <td className="money-cell">
                      {formatCatalogCurrency(product.base_price)}
                    </td>

                    <td className="money-cell">
                      {formatCatalogCurrency(product.cost_price)}
                    </td>

                    <td>
                      <strong className="catalog-count-value">
                        {product.variants_count}
                      </strong>
                    </td>

                    <td>
                      <span className={getCatalogStatusClass(product.status)}>
                        {translateCatalogStatus(product.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ==================================================
        الأصناف الفعلية
    ================================================== */}
      <section className="panel">
        <div className="section-header catalog-table-header">
          <div>
            <h2>الأصناف الفعلية</h2>

            <p className="muted">كل SKU مستقل بمقاسه ولونه وباركوده وسعره.</p>
          </div>

          <span className="record-count-badge">{variants.length} صنف</span>
        </div>

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
                  <th>كود الموديل</th>
                  <th>Barcode</th>
                  <th>المقاس</th>
                  <th>اللون</th>
                  <th>الموسم / المجموعة</th>
                  <th>سعر البيع</th>
                  <th>التكلفة</th>
                  <th>الحالة</th>
                </tr>
              </thead>

              <tbody>
                {variants.map((variant) => (
                  <tr key={variant.id}>
                    <td>
                      <strong className="catalog-product-name">
                        {variant.product_name}
                      </strong>
                    </td>

                    <td>
                      <span className="catalog-code">{variant.sku}</span>
                    </td>

                    <td>
                      {variant.style_code ? (
                        <span className="catalog-code">
                          {variant.style_code}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>

                    <td>
                      {variant.primary_barcode ? (
                        <span className="catalog-code">
                          {variant.primary_barcode}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>

                    <td>{variant.size_name || '-'}</td>
                    <td>{variant.color_name || '-'}</td>

                    <td>
                      <div className="catalog-meta-stack">
                        <span>{variant.season_name || '-'}</span>

                        {variant.collection_name ? (
                          <small>{variant.collection_name}</small>
                        ) : null}
                      </div>
                    </td>

                    <td className="money-cell">
                      {formatCatalogCurrency(variant.selling_price)}
                    </td>

                    <td className="money-cell">
                      {formatCatalogCurrency(variant.cost_price)}
                    </td>

                    <td>
                      <span className={getCatalogStatusClass(variant.status)}>
                        {translateCatalogStatus(variant.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

export default ProductsPage
