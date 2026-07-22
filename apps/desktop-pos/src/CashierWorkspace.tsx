import { useEffect, useMemo, useState } from 'react'

type CartLine = {
  variantId: string
  productName: string
  sku: string
  barcode: string | null
  sizeName: string | null
  colorName: string | null
  unitPrice: number
  availableQuantity: number | null

  catalogSource: 'server' | 'cache'
  quantity: number
}

type CashierWorkspaceProps = {
  configured: boolean
  onSessionChanged: () => void
}

const moneyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  maximumFractionDigits: 2,
})

function formatMoney(value: number) {
  return moneyFormatter.format(value)
}

function CashierWorkspace({
  configured,
  onSessionChanged,
}: CashierWorkspaceProps) {
  const [cashierSession, setCashierSession] =
    useState<DesktopCashierSession | null>(null)

  const [workspace, setWorkspace] = useState<DesktopPosWorkspace | null>(null)

  const [companyCode, setCompanyCode] = useState('')

  const [username, setUsername] = useState('')

  const [password, setPassword] = useState('')

  const [selectedLocationId, setSelectedLocationId] = useState('')

  const [searchQuery, setSearchQuery] = useState('')

  const [searchResults, setSearchResults] = useState<DesktopCatalogItem[]>([])

  const [cart, setCart] = useState<CartLine[]>([])

  const [loadingAction, setLoadingAction] = useState<string | null>(null)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [paymentMethod, setPaymentMethod] =
    useState<DesktopPaymentMethod>('cash')

  const [paidAmount, setPaidAmount] = useState('')

  const [paymentReference, setPaymentReference] = useState('')

  const selectedLocation =
    workspace?.stockLocations.find(
      (location) => location.id === selectedLocationId,
    ) ?? null

  const cartTotal = useMemo(
    () =>
      cart.reduce((total, item) => total + item.quantity * item.unitPrice, 0),
    [cart],
  )

  const cartQuantity = useMemo(
    () => cart.reduce((total, item) => total + item.quantity, 0),
    [cart],
  )

  const paidAmountNumber = Number(paidAmount)

  const changeAmount = Number.isFinite(paidAmountNumber)
    ? Math.max(paidAmountNumber - cartTotal, 0)
    : 0

  const canSavePendingSale =
    cart.length > 0 &&
    Boolean(selectedLocationId) &&
    Number.isFinite(paidAmountNumber) &&
    paidAmountNumber >= cartTotal &&
    loadingAction === null

  async function openWorkspace() {
    setLoadingAction('workspace')
    setError('')

    try {
      const nextWorkspace = await window.desktopPos.loadWorkspace()

      setWorkspace(nextWorkspace)

      setSelectedLocationId((currentLocationId) => {
        const currentExists = nextWorkspace.stockLocations.some(
          (location) => location.id === currentLocationId,
        )

        return currentExists
          ? currentLocationId
          : nextWorkspace.stockLocations[0]?.id || ''
      })
    } catch (currentError) {
      setWorkspace(null)

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل مساحة عمل POS.',
      )
    } finally {
      setLoadingAction(null)
    }
  }

  async function loadInitialSession() {
    const session = await window.desktopPos.cashierSession()

    setCashierSession(session)

    if (session) {
      setCompanyCode(session.user.companyCode)

      await openWorkspace()
    }
  }

  async function login() {
    setLoadingAction('login')
    setError('')
    setSuccess('')

    try {
      const session = await window.desktopPos.cashierLogin({
        companyCode,
        username,
        password,
      })

      setCashierSession(session)
      setPassword('')

      setSuccess(`مرحبًا ${session.user.fullName}.`)

      onSessionChanged()

      await openWorkspace()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تسجيل دخول الكاشير.',
      )
    } finally {
      setLoadingAction(null)
    }
  }

  async function logout() {
    const confirmed = window.confirm('تسجيل خروج الكاشير الحالي؟')

    if (!confirmed) {
      return
    }

    setLoadingAction('logout')
    setError('')
    setSuccess('')

    try {
      await window.desktopPos.cashierLogout()

      setCashierSession(null)
      setWorkspace(null)
      setSelectedLocationId('')
      setSearchResults([])
      setCart([])
      setUsername('')
      setPassword('')

      onSessionChanged()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تسجيل خروج الكاشير.',
      )
    } finally {
      setLoadingAction(null)
    }
  }

  async function searchCatalog() {
    if (!selectedLocationId || !searchQuery.trim()) {
      return
    }

    setLoadingAction('search')
    setError('')
    setSuccess('')

    try {
      const items = await window.desktopPos.searchCatalog({
        stockLocationId: selectedLocationId,

        query: searchQuery,
      })

      setSearchResults(items)

      if (items.length === 0) {
        setError('لا توجد أصناف مطابقة للبحث.')
      }
    } catch (currentError) {
      setSearchResults([])

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر البحث عن الأصناف.',
      )
    } finally {
      setLoadingAction(null)
    }
  }

  async function lookupExactItem() {
    if (!selectedLocationId || !searchQuery.trim()) {
      return
    }

    setLoadingAction('lookup')
    setError('')
    setSuccess('')

    try {
      const item = await window.desktopPos.lookupCatalogItem({
        stockLocationId: selectedLocationId,

        query: searchQuery,
      })

      addToCart(item)
      setSearchResults([item])
      setSearchQuery('')
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر العثور على الصنف.',
      )
    } finally {
      setLoadingAction(null)
    }
  }

  function addToCart(item: DesktopCatalogItem) {
    const unitPrice = Number(item.selling_price)

    const availableQuantity =
      item.available_quantity === null ? null : Number(item.available_quantity)

    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      setError('سعر الصنف غير صالح.')

      return
    }

    setCart((currentCart) => {
      const existingLine = currentCart.find(
        (line) => line.variantId === item.variant_id,
      )

      if (existingLine) {
        return currentCart.map((line) =>
          line.variantId === item.variant_id
            ? {
                ...line,
                quantity: line.quantity + 1,
              }
            : line,
        )
      }

      return [
        ...currentCart,
        {
          variantId: item.variant_id,

          productName: item.product_name,

          sku: item.sku,

          barcode: item.primary_barcode,

          sizeName: item.size_name,

          colorName: item.color_name,

          unitPrice,

          availableQuantity:
            availableQuantity !== null && Number.isFinite(availableQuantity)
              ? availableQuantity
              : null,

          catalogSource: item.catalog_source,

          quantity: 1,
        },
      ]
    })

    setSuccess(`تمت إضافة ${item.product_name} إلى السلة.`)
  }

  function updateQuantity(variantId: string, quantity: number) {
    const normalizedQuantity = Math.min(Math.max(Math.trunc(quantity), 1), 9999)

    setCart((currentCart) =>
      currentCart.map((line) =>
        line.variantId === variantId
          ? {
              ...line,
              quantity: normalizedQuantity,
            }
          : line,
      ),
    )
  }

  function removeFromCart(variantId: string) {
    setCart((currentCart) =>
      currentCart.filter((line) => line.variantId !== variantId),
    )
  }

  async function savePendingSale() {
    if (!selectedLocationId || cart.length === 0) {
      return
    }

    setLoadingAction('save-sale')
    setError('')
    setSuccess('')

    try {
      const result = await window.desktopPos.createPendingSale({
        stockLocationId: selectedLocationId,

        items: cart.map((line) => ({
          variantId: line.variantId,

          quantity: line.quantity,

          unitPrice: line.unitPrice,
        })),

        paymentMethod,

        paidAmount: paidAmountNumber,

        paymentReference: paymentReference.trim() || null,
      })

      setCart([])
      setSearchResults([])
      setSearchQuery('')

      setPaymentMethod('cash')
      setPaidAmount('')
      setPaymentReference('')

      setSuccess(
        `تم حفظ الفاتورة ${result.saleNumber} محليًا. الباقي: ${formatMoney(
          result.changeAmount,
        )}`,
      )

      // يحدث عداد Pending Sales
      // والقائمة الموجودة في App.
      onSessionChanged()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر حفظ الفاتورة محليًا.',
      )
    } finally {
      setLoadingAction(null)
    }
  }

  function changeStockLocation(nextLocationId: string) {
    if (cart.length > 0 && nextLocationId !== selectedLocationId) {
      const confirmed = window.confirm(
        'تغيير مكان البيع سيمسح السلة الحالية. متابعة؟',
      )

      if (!confirmed) {
        return
      }

      setCart([])
      setSearchResults([])
    }

    setSelectedLocationId(nextLocationId)
  }

  useEffect(() => {
    if (!configured) {
      setCashierSession(null)
      setWorkspace(null)
      setCart([])
      return
    }

    void loadInitialSession().catch((currentError) => {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل جلسة الكاشير.',
      )
    })
  }, [configured])

  useEffect(() => {
    if (cart.length === 0) {
      setPaidAmount('')
      setPaymentReference('')
      return
    }

    setPaidAmount((currentValue) => {
      const numericValue = Number(currentValue)

      if (
        !currentValue ||
        !Number.isFinite(numericValue) ||
        numericValue < cartTotal
      ) {
        return cartTotal.toFixed(2)
      }

      return currentValue
    })
  }, [cart.length, cartTotal])

  if (!configured) {
    return (
      <section className="desktop-panel">
        <h2>شاشة البيع</h2>

        <p className="desktop-empty-state">احفظ إعدادات جهاز POS أولًا.</p>
      </section>
    )
  }

  if (!cashierSession) {
    return (
      <section className="desktop-panel">
        <div className="desktop-section-header">
          <div>
            <h2>تسجيل دخول الكاشير</h2>

            <p>
              يجب أن يكون الكاشير تابعًا لنفس فرع جهاز POS ويملك صلاحية إنشاء
              المبيعات.
            </p>
          </div>
        </div>

        {error ? (
          <p className="desktop-message desktop-error">{error}</p>
        ) : null}

        <div className="desktop-form-grid">
          <label>
            كود الشركة
            <input
              value={companyCode}
              disabled={loadingAction !== null}
              onChange={(event) => setCompanyCode(event.target.value)}
              dir="ltr"
            />
          </label>

          <label>
            اسم المستخدم
            <input
              value={username}
              disabled={loadingAction !== null}
              onChange={(event) => setUsername(event.target.value)}
              dir="ltr"
            />
          </label>

          <label>
            كلمة المرور
            <input
              type="password"
              value={password}
              disabled={loadingAction !== null}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void login()
                }
              }}
            />
          </label>
        </div>

        <div className="desktop-actions">
          <button
            type="button"
            className="desktop-primary-button"
            disabled={
              loadingAction !== null ||
              !companyCode.trim() ||
              !username.trim() ||
              !password
            }
            onClick={() => void login()}
          >
            {loadingAction === 'login' ? 'جاري الدخول...' : 'دخول الكاشير'}
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="desktop-panel desktop-sale-workspace">
      <div className="desktop-section-header">
        <div>
          <h2>شاشة البيع</h2>

          <p>
            الكاشير: <strong>{cashierSession.user.fullName}</strong>
            {' • '}
            {cashierSession.user.branchName || '-'}
          </p>
        </div>

        <div className="desktop-actions desktop-inline-actions">
          <button
            type="button"
            disabled={loadingAction !== null}
            onClick={() => void openWorkspace()}
          >
            تحديث البيانات
          </button>

          <button
            type="button"
            className="desktop-danger-button"
            disabled={loadingAction !== null}
            onClick={() => void logout()}
          >
            تسجيل الخروج
          </button>
        </div>
      </div>

      {error ? <p className="desktop-message desktop-error">{error}</p> : null}

      {success ? (
        <p className="desktop-message desktop-success">{success}</p>
      ) : null}

      {!workspace ? (
        <p className="desktop-empty-state">
          {loadingAction === 'workspace'
            ? 'جاري تحميل بيانات الجهاز والفرع...'
            : 'تعذر تحميل مساحة العمل. تأكد من الاتصال ثم اضغط تحديث البيانات.'}
        </p>
      ) : (
        <>
          <div className="desktop-pos-toolbar">
            <label>
              مكان البيع
              <select
                value={selectedLocationId}
                disabled={loadingAction !== null}
                onChange={(event) => changeStockLocation(event.target.value)}
              >
                {workspace.stockLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name} - {location.code}
                  </option>
                ))}
              </select>
            </label>

            <label className="desktop-pos-search-field">
              البحث أو الباركود
              <input
                value={searchQuery}
                disabled={loadingAction !== null || !selectedLocationId}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void lookupExactItem()
                  }
                }}
                placeholder="Barcode / SKU / اسم الصنف"
                autoFocus
              />
            </label>

            <div className="desktop-pos-search-actions">
              <button
                type="button"
                className="desktop-primary-button"
                disabled={
                  loadingAction !== null ||
                  !searchQuery.trim() ||
                  !selectedLocationId
                }
                onClick={() => void lookupExactItem()}
              >
                إضافة مباشر
              </button>

              <button
                type="button"
                disabled={
                  loadingAction !== null ||
                  !searchQuery.trim() ||
                  !selectedLocationId
                }
                onClick={() => void searchCatalog()}
              >
                بحث بالاسم
              </button>
            </div>
          </div>

          <p className="desktop-trusted-note">
            الكتالوج المحلي يحتوي على{' '}
            <strong>{workspace.catalogCache.itemCount}</strong> صنف. يتم حفظ
            الاسم والباركود والسعر فقط، ولا يتم حفظ أو خصم أي كمية مخزون داخل
            SQLite.
          </p>

          {searchResults.length > 0 ? (
            <div className="desktop-catalog-results">
              {searchResults.map((item) => (
                <article key={item.variant_id} className="desktop-catalog-card">
                  <div>
                    <strong>{item.product_name}</strong>

                    <small>SKU: {item.sku}</small>

                    <small>
                      {item.size_name || '-'}
                      {' • '}
                      {item.color_name || '-'}
                    </small>
                  </div>

                  <div>
                    <strong>{formatMoney(Number(item.selling_price))}</strong>

                    <small>
                      {item.catalog_source === 'cache'
                        ? 'كتالوج محلي — المخزون سيُراجع عند المزامنة'
                        : `المتاح حاليًا: ${item.available_quantity ?? '-'}`}
                    </small>
                  </div>

                  <button
                    type="button"
                    className="desktop-primary-button"
                    onClick={() => addToCart(item)}
                  >
                    إضافة
                  </button>
                </article>
              ))}
            </div>
          ) : null}

          <div className="desktop-cart-header">
            <div>
              <h3>سلة الفاتورة</h3>

              <p>مكان البيع: {selectedLocation?.name || '-'}</p>
            </div>

            <div className="desktop-cart-total">
              <span>{cartQuantity} قطعة</span>

              <strong>{formatMoney(cartTotal)}</strong>
            </div>
          </div>

          {cart.length === 0 ? (
            <p className="desktop-empty-state">
              امسح الباركود أو ابحث عن صنف لإضافته إلى السلة.
            </p>
          ) : (
            <div className="desktop-table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>SKU</th>
                    <th>المقاس/اللون</th>
                    <th>السعر</th>
                    <th>الكمية</th>
                    <th>الإجمالي</th>
                    <th>تنبيه المخزون</th>
                    <th>حذف</th>
                  </tr>
                </thead>

                <tbody>
                  {cart.map((line) => {
                    const availableQuantity = line.availableQuantity

                    const stockIsUnknown = availableQuantity === null

                    const exceedsStock =
                      availableQuantity !== null &&
                      line.quantity > availableQuantity

                    return (
                      <tr key={line.variantId}>
                        <td>
                          <strong>{line.productName}</strong>
                        </td>

                        <td>{line.sku}</td>

                        <td>
                          {line.sizeName || '-'}
                          {' / '}
                          {line.colorName || '-'}
                        </td>

                        <td>{formatMoney(line.unitPrice)}</td>

                        <td>
                          <input
                            className="desktop-quantity-input"
                            type="number"
                            min="1"
                            step="1"
                            value={line.quantity}
                            onChange={(event) =>
                              updateQuantity(
                                line.variantId,
                                Number(event.target.value),
                              )
                            }
                          />
                        </td>

                        <td>
                          <strong>
                            {formatMoney(line.quantity * line.unitPrice)}
                          </strong>
                        </td>

                        <td>
                          {stockIsUnknown ? (
                            <span className="desktop-stock-unknown">
                              Offline — يُراجع عند المزامنة
                            </span>
                          ) : exceedsStock ? (
                            <span className="desktop-stock-warning">
                              ستحتاج مراجعة عند المزامنة
                            </span>
                          ) : (
                            <span className="desktop-stock-ok">متاح</span>
                          )}
                        </td>

                        <td>
                          <button
                            type="button"
                            className="desktop-danger-button"
                            onClick={() => removeFromCart(line.variantId)}
                          >
                            حذف
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {cart.length > 0 ? (
            <section className="desktop-payment-panel">
              <div className="desktop-section-header">
                <div>
                  <h3>الدفع وحفظ الفاتورة</h3>

                  <p>
                    الفاتورة تحفظ داخل SQLite كـ Pending Sale، ولا يتم خصم مخزون
                    محلي.
                  </p>
                </div>
              </div>

              <div className="desktop-payment-grid">
                <label>
                  طريقة الدفع
                  <select
                    value={paymentMethod}
                    disabled={loadingAction !== null}
                    onChange={(event) =>
                      setPaymentMethod(
                        event.target.value as DesktopPaymentMethod,
                      )
                    }
                  >
                    <option value="cash">نقدي</option>

                    <option value="card">بطاقة</option>

                    <option value="wallet">محفظة إلكترونية</option>

                    <option value="bank_transfer">تحويل بنكي</option>

                    <option value="other">أخرى</option>
                  </select>
                </label>

                <label>
                  المبلغ المدفوع
                  <input
                    type="number"
                    min={cartTotal}
                    step="0.01"
                    value={paidAmount}
                    disabled={loadingAction !== null}
                    onChange={(event) => setPaidAmount(event.target.value)}
                  />
                </label>

                <label>
                  رقم المرجع
                  <input
                    value={paymentReference}
                    disabled={
                      loadingAction !== null || paymentMethod === 'cash'
                    }
                    onChange={(event) =>
                      setPaymentReference(event.target.value)
                    }
                    placeholder={
                      paymentMethod === 'cash'
                        ? 'غير مطلوب للدفع النقدي'
                        : 'رقم العملية أو المرجع'
                    }
                    dir="ltr"
                  />
                </label>
              </div>

              <div className="desktop-payment-summary">
                <div>
                  <span>إجمالي الفاتورة</span>

                  <strong>{formatMoney(cartTotal)}</strong>
                </div>

                <div>
                  <span>المدفوع</span>

                  <strong>
                    {Number.isFinite(paidAmountNumber)
                      ? formatMoney(paidAmountNumber)
                      : formatMoney(0)}
                  </strong>
                </div>

                <div>
                  <span>الباقي</span>

                  <strong>{formatMoney(changeAmount)}</strong>
                </div>
              </div>

              {paidAmountNumber < cartTotal ? (
                <p className="desktop-message desktop-error">
                  المبلغ المدفوع أقل من إجمالي الفاتورة.
                </p>
              ) : null}

              <div className="desktop-actions">
                <button
                  type="button"
                  className="desktop-primary-button desktop-save-sale-button"
                  disabled={!canSavePendingSale}
                  onClick={() => void savePendingSale()}
                >
                  {loadingAction === 'save-sale'
                    ? 'جاري حفظ الفاتورة...'
                    : 'حفظ الفاتورة محليًا'}
                </button>

                <button
                  type="button"
                  disabled={loadingAction !== null}
                  onClick={() => setPaidAmount(cartTotal.toFixed(2))}
                >
                  المدفوع يساوي الإجمالي
                </button>

                <button
                  type="button"
                  className="desktop-danger-button"
                  disabled={loadingAction !== null}
                  onClick={() => {
                    const confirmed = window.confirm('مسح السلة الحالية؟')

                    if (confirmed) {
                      setCart([])
                      setSearchResults([])
                      setSearchQuery('')
                    }
                  }}
                >
                  مسح السلة
                </button>
              </div>
            </section>
          ) : null}
        </>
      )}
    </section>
  )
}

export default CashierWorkspace
