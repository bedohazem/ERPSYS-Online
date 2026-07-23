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

type VariantPriceHistory = {
  id: string

  old_selling_price: string
  new_selling_price: string

  changed_by: string | null
  changed_by_name: string | null

  change_note: string | null

  change_type: 'manual' | 'restore'

  source_history_id: string | null

  changed_at: string
}

type VariantPriceHistoryDetails = {
  variant: {
    id: string
    product_name: string
    sku: string
    selling_price: string
  }

  history: VariantPriceHistory[]
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

const catalogDateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatCatalogDate(value: string) {
  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : catalogDateFormatter.format(parsedDate)
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

  const [success, setSuccess] = useState('')

  const [editingVariantId, setEditingVariantId] = useState<string | null>(null)

  const [editingSellingPrice, setEditingSellingPrice] = useState('')

  const [savingVariantId, setSavingVariantId] = useState<string | null>(null)

  const [selectedHistoryVariant, setSelectedHistoryVariant] =
    useState<Variant | null>(null)

  const [priceHistory, setPriceHistory] = useState<VariantPriceHistory[]>([])

  const [loadingPriceHistory, setLoadingPriceHistory] = useState(false)

  const [restoringHistoryId, setRestoringHistoryId] = useState<string | null>(
    null,
  )

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
  const canManageProducts = hasPermission(user, 'products.manage')

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

  function startEditingPrice(variant: Variant) {
    setEditingVariantId(variant.id)

    setEditingSellingPrice(Number(variant.selling_price).toFixed(2))

    setError('')
    setSuccess('')
  }

  function cancelEditingPrice() {
    setEditingVariantId(null)
    setEditingSellingPrice('')
  }

  async function saveVariantPrice(variant: Variant) {
    if (savingVariantId || !canManageProducts) {
      return
    }

    const sellingPrice = Number(editingSellingPrice)

    if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
      setError('سعر البيع غير صالح.')

      return
    }

    const note = window.prompt('سبب تغيير السعر — اختياري:', '')

    if (note === null) {
      return
    }

    const confirmed = window.confirm(
      `تغيير سعر ${variant.product_name} — ${variant.sku} من ${formatCatalogCurrency(
        variant.selling_price,
      )} إلى ${formatCatalogCurrency(sellingPrice)}؟`,
    )

    if (!confirmed) {
      return
    }

    setSavingVariantId(variant.id)

    setError('')
    setSuccess('')

    try {
      const response = await requestJson<
        ApiResponse<{
          id: string
          selling_price: string
        }> & {
          changed: boolean
        }
      >(
        `/api/catalog/variants/${encodeURIComponent(variant.id)}/price`,

        {
          method: 'PATCH',

          headers: {
            'Content-Type': 'application/json',
          },

          body: JSON.stringify({
            sellingPrice,

            note: note.trim() || null,
          }),
        },
      )

      setVariants((currentVariants) =>
        currentVariants.map((currentVariant) =>
          currentVariant.id === variant.id
            ? {
                ...currentVariant,

                selling_price: response.data.selling_price,
              }
            : currentVariant,
        ),
      )

      if (selectedHistoryVariant?.id === variant.id) {
        setSelectedHistoryVariant({
          ...selectedHistoryVariant,

          selling_price: response.data.selling_price,
        })

        try {
          const details = await fetchVariantPriceHistory(variant.id)

          setPriceHistory(details.history)
        } catch {
          // تعديل السعر نجح بالفعل.
        }
      }

      setEditingVariantId(null)
      setEditingSellingPrice('')

      setSuccess(
        response.changed
          ? `تم تحديث سعر ${variant.product_name} بنجاح.`
          : 'السعر الجديد مطابق للسعر الحالي.',
      )
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تعديل سعر الصنف.',
      )
    } finally {
      setSavingVariantId(null)
    }
  }

  async function fetchVariantPriceHistory(variantId: string) {
    const response = await requestJson<ApiResponse<VariantPriceHistoryDetails>>(
      `/api/catalog/variants/${encodeURIComponent(variantId)}/price-history`,
    )

    return response.data
  }

  async function openPriceHistory(variant: Variant) {
    setSelectedHistoryVariant(variant)

    setPriceHistory([])
    setLoadingPriceHistory(true)

    setError('')
    setSuccess('')

    try {
      const details = await fetchVariantPriceHistory(variant.id)

      setSelectedHistoryVariant({
        ...variant,

        selling_price: details.variant.selling_price,
      })

      setPriceHistory(details.history)
    } catch (currentError) {
      setSelectedHistoryVariant(null)

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل سجل السعر.',
      )
    } finally {
      setLoadingPriceHistory(false)
    }
  }

  function closePriceHistory() {
    setSelectedHistoryVariant(null)
    setPriceHistory([])
  }

  async function restorePreviousPrice(history: VariantPriceHistory) {
    if (!selectedHistoryVariant || !canManageProducts || restoringHistoryId) {
      return
    }

    const note = window.prompt('سبب استرجاع السعر — اختياري:', '')

    if (note === null) {
      return
    }

    const confirmed = window.confirm(
      `استرجاع سعر ${selectedHistoryVariant.product_name} — ${selectedHistoryVariant.sku} من ${formatCatalogCurrency(
        selectedHistoryVariant.selling_price,
      )} إلى ${formatCatalogCurrency(history.old_selling_price)}؟`,
    )

    if (!confirmed) {
      return
    }

    setRestoringHistoryId(history.id)

    setError('')
    setSuccess('')

    try {
      const response = await requestJson<
        ApiResponse<{
          variant_id: string
          selling_price: string

          restored_from_history_id: string

          history: VariantPriceHistory | null
        }> & {
          changed: boolean
        }
      >(
        `/api/catalog/variants/${encodeURIComponent(
          selectedHistoryVariant.id,
        )}/price-history/${encodeURIComponent(history.id)}/restore`,

        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',
          },

          body: JSON.stringify({
            note: note.trim() || null,
          }),
        },
      )

      const updatedPrice = response.data.selling_price

      setVariants((currentVariants) =>
        currentVariants.map((variant) =>
          variant.id === selectedHistoryVariant.id
            ? {
                ...variant,

                selling_price: updatedPrice,
              }
            : variant,
        ),
      )

      setSelectedHistoryVariant((currentVariant) =>
        currentVariant
          ? {
              ...currentVariant,

              selling_price: updatedPrice,
            }
          : null,
      )

      try {
        const details = await fetchVariantPriceHistory(
          selectedHistoryVariant.id,
        )

        setPriceHistory(details.history)
      } catch {
        // السعر تم استرجاعه بالفعل.
        // فشل تحديث الجدول لا يلغي العملية.
      }

      setSuccess(
        response.changed
          ? 'تم استرجاع السعر السابق وتسجيل العملية.'
          : 'السعر المختار هو السعر الحالي بالفعل.',
      )
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر استرجاع السعر السابق.',
      )
    } finally {
      setRestoringHistoryId(null)
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
        {success ? <p className="success-message">{success}</p> : null}
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
                  <th>الإجراء</th>
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
                      {editingVariantId === variant.id ? (
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={editingSellingPrice}
                          disabled={savingVariantId === variant.id}
                          onChange={(event) =>
                            setEditingSellingPrice(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              void saveVariantPrice(variant)
                            }

                            if (event.key === 'Escape') {
                              cancelEditingPrice()
                            }
                          }}
                          autoFocus
                        />
                      ) : (
                        formatCatalogCurrency(variant.selling_price)
                      )}
                    </td>

                    <td className="money-cell">
                      {formatCatalogCurrency(variant.cost_price)}
                    </td>

                    <td>
                      <span className={getCatalogStatusClass(variant.status)}>
                        {translateCatalogStatus(variant.status)}
                      </span>
                    </td>
                    <td>
                      <div className="section-actions">
                        <button
                          type="button"
                          className="table-button"
                          disabled={
                            savingVariantId === variant.id ||
                            restoringHistoryId !== null
                          }
                          onClick={() => void openPriceHistory(variant)}
                        >
                          سجل السعر
                        </button>

                        {canManageProducts ? (
                          editingVariantId === variant.id ? (
                            <>
                              <button
                                type="button"
                                className="table-button primary-button"
                                disabled={savingVariantId === variant.id}
                                onClick={() => void saveVariantPrice(variant)}
                              >
                                {savingVariantId === variant.id
                                  ? 'جاري الحفظ...'
                                  : 'حفظ'}
                              </button>

                              <button
                                type="button"
                                className="table-button"
                                disabled={savingVariantId === variant.id}
                                onClick={cancelEditingPrice}
                              >
                                إلغاء
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="table-button"
                              disabled={
                                savingVariantId !== null ||
                                editingVariantId !== null ||
                                restoringHistoryId !== null
                              }
                              onClick={() => startEditingPrice(variant)}
                            >
                              تعديل السعر
                            </button>
                          )
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedHistoryVariant ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>سجل تغييرات السعر</h2>

              <p className="muted">
                {selectedHistoryVariant.product_name}

                {' — '}

                {selectedHistoryVariant.sku}

                {' • السعر الحالي: '}

                <strong>
                  {formatCatalogCurrency(selectedHistoryVariant.selling_price)}
                </strong>
              </p>
            </div>

            <button
              type="button"
              className="table-button"
              disabled={restoringHistoryId !== null}
              onClick={closePriceHistory}
            >
              إغلاق السجل
            </button>
          </div>

          {loadingPriceHistory ? (
            <p className="muted">جاري تحميل سجل السعر...</p>
          ) : priceHistory.length === 0 ? (
            <p className="muted">لم يتم تغيير سعر هذا الصنف حتى الآن.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>التاريخ</th>
                    <th>السعر القديم</th>
                    <th>السعر الجديد</th>
                    <th>نوع العملية</th>
                    <th>المستخدم</th>
                    <th>الملاحظة</th>
                    <th>الاسترجاع</th>
                  </tr>
                </thead>

                <tbody>
                  {priceHistory.map((history) => {
                    const isCurrentPrice =
                      Number(history.old_selling_price) ===
                      Number(selectedHistoryVariant.selling_price)

                    return (
                      <tr key={history.id}>
                        <td>{formatCatalogDate(history.changed_at)}</td>

                        <td className="money-cell">
                          {formatCatalogCurrency(history.old_selling_price)}
                        </td>

                        <td className="money-cell">
                          {formatCatalogCurrency(history.new_selling_price)}
                        </td>

                        <td>
                          {history.change_type === 'restore'
                            ? 'استرجاع سعر'
                            : 'تعديل يدوي'}
                        </td>

                        <td>{history.changed_by_name || '-'}</td>

                        <td>{history.change_note || '-'}</td>

                        <td>
                          {canManageProducts ? (
                            isCurrentPrice ? (
                              <span className="muted">السعر الحالي</span>
                            ) : (
                              <button
                                type="button"
                                className="table-button"
                                disabled={restoringHistoryId !== null}
                                onClick={() =>
                                  void restorePreviousPrice(history)
                                }
                              >
                                {restoringHistoryId === history.id
                                  ? 'جاري الاسترجاع...'
                                  : 'استرجاع السعر القديم'}
                              </button>
                            )
                          ) : (
                            <span className="muted">عرض فقط</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  )
}

export default ProductsPage
