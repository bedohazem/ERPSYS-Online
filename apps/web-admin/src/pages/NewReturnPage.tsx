import { useMemo, useState } from 'react'

const API_BASE_URL = 'http://localhost:3000'

type Sale = {
  id: string
  company_id: string
  branch_id: string
  branch_name: string
  stock_location_id: string
  stock_location_name: string
  customer_id: string | null
  customer_name: string | null
  sale_number: string
  source: string
  subtotal: string
  discount_total: string
  tax_total: string
  total: string
  paid_total: string
  change_total: string
  status: string
  created_at: string
  items_count: number
}

type SaleItem = {
  id: string
  sale_id: string
  variant_id: string
  sku_snapshot: string
  barcode_snapshot: string | null
  product_name_snapshot: string
  size_snapshot: string | null
  color_snapshot: string | null
  quantity: string
  unit_price: string
  discount_amount: string
  tax_amount: string
  line_total: string
  created_at: string
}

type SalePayment = {
  id: string
  sale_id: string
  method: string
  amount: string
  reference: string | null
  created_at: string
}

type SaleDetails = {
  sale: Sale & {
    cashier_id: string | null
    cashier_name: string | null
    idempotency_key: string
  }
  items: SaleItem[]
  payments: SalePayment[]
}

type CreatedReturn = {
  return: {
    id: string
    return_number: string
    original_sale_id: string | null
    subtotal: string
    refund_total: string
    status: string
  }
  items: Array<{
    id: string
    original_sale_item_id: string | null
    variant_id: string
    quantity: string
    unit_price: string
    refund_amount: string
  }>
  refunds: Array<{
    id: string
    method: string
    amount: string
    reference: string | null
  }>
}

type SelectedReturnItem = {
  saleItem: SaleItem
  quantity: number
}

type ApiResponse<T> = {
  data: T
}

type NewReturnPageProps = {
  companyId: string
  branchId: string
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  const data = await response.json()

  if (!response.ok) {
    throw new Error(data?.error || 'Request failed')
  }

  return data as T
}

function createReturnNumber() {
  return `RET-WEB-${Date.now()}`
}

function createIdempotencyKey() {
  return `web-admin-return-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function NewReturnPage({ companyId, branchId }: NewReturnPageProps) {
  const [sales, setSales] = useState<Sale[]>([])
  const [selectedSaleDetails, setSelectedSaleDetails] =
    useState<SaleDetails | null>(null)

  const [saleSearchText, setSaleSearchText] = useState('')
  const [returnNumber, setReturnNumber] = useState(createReturnNumber())
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey())
  const [reason, setReason] = useState('')
  const [refundMethod, setRefundMethod] = useState('cash')

  const [returnQuantities, setReturnQuantities] = useState<
    Record<string, number>
  >({})

  const [lastSavedReturn, setLastSavedReturn] = useState<CreatedReturn | null>(
    null,
  )

  const [loadingSales, setLoadingSales] = useState(false)
  const [loadingSaleDetails, setLoadingSaleDetails] = useState(false)
  const [savingReturn, setSavingReturn] = useState(false)
  const [error, setError] = useState('')

  const filteredSales = useMemo(() => {
    const searchValue = saleSearchText.trim().toLowerCase()

    if (!searchValue) {
      return sales
    }

    return sales.filter((sale) => {
      const saleNumber = sale.sale_number.toLowerCase()
      const customerName = (sale.customer_name || '').toLowerCase()

      return (
        saleNumber.includes(searchValue) || customerName.includes(searchValue)
      )
    })
  }, [sales, saleSearchText])

  const selectedReturnItems = useMemo<SelectedReturnItem[]>(() => {
    if (!selectedSaleDetails) {
      return []
    }

    return selectedSaleDetails.items
      .map((saleItem) => ({
        saleItem,
        quantity: returnQuantities[saleItem.id] || 0,
      }))
      .filter((item) => item.quantity > 0)
  }, [selectedSaleDetails, returnQuantities])

  const refundTotal = useMemo(() => {
    return selectedReturnItems.reduce((total, item) => {
      return total + item.quantity * Number(item.saleItem.unit_price)
    }, 0)
  }, [selectedReturnItems])

  async function loadSales() {
    setLoadingSales(true)
    setError('')
    setLastSavedReturn(null)

    try {
      const selectedCompanyId = companyId.trim()
      const selectedBranchId = branchId.trim()

      if (!selectedCompanyId) {
        throw new Error('companyId is required')
      }

      const salesUrl =
        `${API_BASE_URL}/api/sales` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        (selectedBranchId
          ? `&branchId=${encodeURIComponent(selectedBranchId)}`
          : '') +
        '&limit=100'

      const salesResponse = await fetchJson<ApiResponse<Sale[]>>(salesUrl)

      setSales(salesResponse.data)
      setSelectedSaleDetails(null)
      setReturnQuantities({})
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown sales error',
      )
    } finally {
      setLoadingSales(false)
    }
  }

  async function loadSaleDetails(saleId: string) {
    setLoadingSaleDetails(true)
    setError('')
    setLastSavedReturn(null)

    try {
      const selectedCompanyId = companyId.trim()

      if (!selectedCompanyId) {
        throw new Error('companyId is required')
      }

      const saleDetailsUrl =
        `${API_BASE_URL}/api/sales/${encodeURIComponent(saleId)}` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}`

      const saleDetailsResponse =
        await fetchJson<ApiResponse<SaleDetails>>(saleDetailsUrl)

      setSelectedSaleDetails(saleDetailsResponse.data)
      setReturnQuantities({})
      setReason('')
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown sale details error',
      )
    } finally {
      setLoadingSaleDetails(false)
    }
  }

  function updateReturnQuantity(
    saleItemId: string,
    soldQuantityValue: string,
    inputValue: string,
  ) {
    const soldQuantity = Number(soldQuantityValue)
    const requestedQuantity = Number(inputValue)

    let nextQuantity = Number.isFinite(requestedQuantity)
      ? requestedQuantity
      : 0

    if (nextQuantity < 0) {
      nextQuantity = 0
    }

    if (nextQuantity > soldQuantity) {
      nextQuantity = soldQuantity
    }

    setReturnQuantities((currentQuantities) => ({
      ...currentQuantities,
      [saleItemId]: nextQuantity,
    }))
  }

  function returnFullItemQuantity(saleItem: SaleItem) {
    setReturnQuantities((currentQuantities) => ({
      ...currentQuantities,
      [saleItem.id]: Number(saleItem.quantity),
    }))
  }

  function clearItemQuantity(saleItemId: string) {
    setReturnQuantities((currentQuantities) => ({
      ...currentQuantities,
      [saleItemId]: 0,
    }))
  }

  function clearSelectedSale() {
    setSelectedSaleDetails(null)
    setReturnQuantities({})
    setReason('')
    setError('')
  }

  async function saveReturn() {
    setSavingReturn(true)
    setError('')
    setLastSavedReturn(null)

    try {
      const selectedCompanyId = companyId.trim()
      const selectedReturnNumber = returnNumber.trim()

      if (!selectedCompanyId) {
        throw new Error('companyId is required')
      }

      if (!selectedSaleDetails) {
        throw new Error('اختر الفاتورة الأصلية أولًا')
      }

      if (!selectedReturnNumber) {
        throw new Error('returnNumber is required')
      }

      if (selectedReturnItems.length === 0) {
        throw new Error('حدد كمية مرتجعة لصنف واحد على الأقل')
      }

      if (refundTotal <= 0) {
        throw new Error('إجمالي المبلغ المرتجع يجب أن يكون أكبر من صفر')
      }

      const originalSale = selectedSaleDetails.sale
      const selectedReason = reason.trim()

      const returnBody = {
        companyId: selectedCompanyId,
        branchId: originalSale.branch_id,
        stockLocationId: originalSale.stock_location_id,
        customerId: originalSale.customer_id,
        originalSaleId: originalSale.id,
        returnNumber: selectedReturnNumber,
        source: 'web_admin',
        idempotencyKey,
        reason: selectedReason || null,
        items: selectedReturnItems.map((selectedItem) => {
          const unitPrice = Number(selectedItem.saleItem.unit_price)

          return {
            originalSaleItemId: selectedItem.saleItem.id,
            variantId: selectedItem.saleItem.variant_id,
            quantity: selectedItem.quantity,
            unitPrice,
            refundAmount: selectedItem.quantity * unitPrice,
            reason: selectedReason || null,
          }
        }),
        refunds: [
          {
            method: refundMethod,
            amount: refundTotal,
            reference: null,
          },
        ],
      }

      const returnResponse = await fetchJson<ApiResponse<CreatedReturn>>(
        `${API_BASE_URL}/api/returns`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(returnBody),
        },
      )

      setLastSavedReturn(returnResponse.data)
      setSelectedSaleDetails(null)
      setReturnQuantities({})
      setReason('')
      setRefundMethod('cash')
      setReturnNumber(createReturnNumber())
      setIdempotencyKey(createIdempotencyKey())
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown save return error',
      )
    } finally {
      setSavingReturn(false)
    }
  }

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>مرتجع جديد</h2>
            <p className="muted">
              اختر الفاتورة الأصلية، ثم حدد الأصناف والكميات المراد إرجاعها.
            </p>
          </div>

          <button
            className="primary-button small-button"
            disabled={!companyId.trim() || loadingSales}
            onClick={loadSales}
          >
            {loadingSales ? 'جاري تحميل الفواتير...' : 'تحميل الفواتير'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {lastSavedReturn ? (
          <p className="success-message">
            تم حفظ المرتجع {lastSavedReturn.return.return_number} بنجاح، وتم رد
            مبلغ {lastSavedReturn.return.refund_total} وزيادة المخزون.
          </p>
        ) : null}

        <div className="form-grid">
          <label>
            رقم المرتجع
            <input
              value={returnNumber}
              onChange={(event) => setReturnNumber(event.target.value)}
            />
          </label>

          <label>
            بحث داخل الفواتير المحملة
            <input
              value={saleSearchText}
              onChange={(event) => setSaleSearchText(event.target.value)}
              placeholder="رقم الفاتورة أو اسم العميل"
            />
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>اختيار الفاتورة الأصلية</h2>
            <p className="muted">
              يتم عرض أحدث الفواتير الخاصة بالشركة والفرع المحددين.
            </p>
          </div>
        </div>

        {sales.length === 0 ? (
          <p className="muted">
            اضغط تحميل الفواتير، ثم اختر الفاتورة المطلوب عمل مرتجع منها.
          </p>
        ) : filteredSales.length === 0 ? (
          <p className="muted">لا توجد فاتورة مطابقة لعملية البحث.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>رقم الفاتورة</th>
                  <th>العميل</th>
                  <th>الفرع</th>
                  <th>المخزن</th>
                  <th>الإجمالي</th>
                  <th>الأصناف</th>
                  <th>الحالة</th>
                  <th>اختيار</th>
                </tr>
              </thead>

              <tbody>
                {filteredSales.map((sale) => (
                  <tr key={sale.id}>
                    <td>{sale.sale_number}</td>
                    <td>{sale.customer_name || 'بيع عام'}</td>
                    <td>{sale.branch_name}</td>
                    <td>{sale.stock_location_name}</td>
                    <td>{sale.total}</td>
                    <td>{sale.items_count}</td>
                    <td>{sale.status}</td>
                    <td>
                      <button
                        className="table-button"
                        disabled={loadingSaleDetails}
                        onClick={() => loadSaleDetails(sale.id)}
                      >
                        {loadingSaleDetails
                          ? 'جاري الفتح...'
                          : 'اختيار الفاتورة'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedSaleDetails ? (
        <>
          <section className="panel">
            <div className="section-header">
              <div>
                <h2>بيانات الفاتورة المختارة</h2>
                <p className="muted">
                  فاتورة رقم {selectedSaleDetails.sale.sale_number}
                </p>
              </div>

              <button
                className="table-button danger-button"
                disabled={savingReturn}
                onClick={clearSelectedSale}
              >
                إلغاء اختيار الفاتورة
              </button>
            </div>

            <section className="mini-cards-grid">
              <article className="mini-card">
                <span>العميل</span>
                <strong>
                  {selectedSaleDetails.sale.customer_name || 'بيع عام'}
                </strong>
              </article>

              <article className="mini-card">
                <span>الفرع</span>
                <strong>{selectedSaleDetails.sale.branch_name}</strong>
              </article>

              <article className="mini-card">
                <span>المخزن</span>
                <strong>{selectedSaleDetails.sale.stock_location_name}</strong>
              </article>

              <article className="mini-card">
                <span>إجمالي الفاتورة</span>
                <strong>{selectedSaleDetails.sale.total}</strong>
              </article>

              <article className="mini-card">
                <span>إجمالي المرتجع الحالي</span>
                <strong>{refundTotal}</strong>
              </article>
            </section>

            <div className="form-grid">
              <label>
                سبب المرتجع
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="مثال: تغيير مقاس أو عيب في الصنف"
                />
              </label>

              <label>
                طريقة رد المبلغ
                <select
                  value={refundMethod}
                  onChange={(event) => setRefundMethod(event.target.value)}
                >
                  <option value="cash">نقدي</option>
                  <option value="card">بطاقة</option>
                  <option value="bank_transfer">تحويل بنكي</option>
                  <option value="wallet">محفظة إلكترونية</option>
                </select>
              </label>
            </div>
          </section>

          <section className="panel">
            <div className="section-header">
              <div>
                <h2>أصناف الفاتورة</h2>
                <p className="muted">اكتب الكمية المراد إرجاعها أمام كل صنف.</p>
              </div>

              <button
                className="primary-button small-button"
                disabled={selectedReturnItems.length === 0 || savingReturn}
                onClick={saveReturn}
              >
                {savingReturn
                  ? 'جاري حفظ المرتجع...'
                  : `حفظ المرتجع بقيمة ${refundTotal}`}
              </button>
            </div>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>SKU</th>
                    <th>Barcode</th>
                    <th>المقاس</th>
                    <th>اللون</th>
                    <th>الكمية المباعة</th>
                    <th>السعر</th>
                    <th>الكمية المرتجعة</th>
                    <th>قيمة المرتجع</th>
                    <th>إجراءات</th>
                  </tr>
                </thead>

                <tbody>
                  {selectedSaleDetails.items.map((saleItem) => {
                    const returnQuantity = returnQuantities[saleItem.id] || 0

                    const itemRefundTotal =
                      returnQuantity * Number(saleItem.unit_price)

                    return (
                      <tr key={saleItem.id}>
                        <td>{saleItem.product_name_snapshot}</td>
                        <td>{saleItem.sku_snapshot}</td>
                        <td>{saleItem.barcode_snapshot || '-'}</td>
                        <td>{saleItem.size_snapshot || '-'}</td>
                        <td>{saleItem.color_snapshot || '-'}</td>
                        <td>{saleItem.quantity}</td>
                        <td>{saleItem.unit_price}</td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            max={Number(saleItem.quantity)}
                            step="1"
                            value={returnQuantity}
                            onChange={(event) =>
                              updateReturnQuantity(
                                saleItem.id,
                                saleItem.quantity,
                                event.target.value,
                              )
                            }
                          />
                        </td>
                        <td>{itemRefundTotal}</td>
                        <td>
                          <button
                            className="table-button"
                            disabled={savingReturn}
                            onClick={() => returnFullItemQuantity(saleItem)}
                          >
                            إرجاع الكل
                          </button>{' '}
                          <button
                            className="table-button danger-button"
                            disabled={savingReturn}
                            onClick={() => clearItemQuantity(saleItem.id)}
                          >
                            مسح
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </>
  )
}

export default NewReturnPage
