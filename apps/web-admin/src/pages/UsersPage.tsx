import { useState } from 'react'
import { requestJson } from '../lib/http'

// ======================================================
// UserRow
//
// يمثل بيانات مستخدم واحد كما ترجع من Backend API.
// الأدوار ترجع كمصفوفة أكواد مثل:
// ['admin', 'cashier']
// ======================================================
type UserRow = {
  id: string
  company_id: string
  branch_id: string | null

  full_name: string
  username: string
  email: string | null

  is_active: boolean

  branch_code: string | null
  branch_name: string | null

  roles: string[]

  created_at: string
  updated_at: string
}

type ApiResponse<T> = {
  data: T
}

function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // ======================================================
  // loadUsers
  //
  // لا نرسل companyId من المتصفح.
  // Backend يأخذ الشركة من Session الموثقة.
  //
  // هذا يمنع المستخدم من محاولة قراءة مستخدمي
  // شركة أخرى عن طريق تعديل Query String.
  // ======================================================
  async function loadUsers() {
    setLoading(true)
    setError('')

    try {
      const response = await requestJson<ApiResponse<UserRow[]>>('/api/users')

      setUsers(response.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'حدث خطأ غير معروف أثناء تحميل المستخدمين',
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="panel">
      <div className="section-header">
        <div>
          <h2>إدارة المستخدمين</h2>

          <p className="muted">
            عرض مستخدمي الشركة والفروع والأدوار المرتبطة بكل مستخدم.
          </p>
        </div>

        <button
          type="button"
          className="primary-button small-button"
          disabled={loading}
          onClick={loadUsers}
        >
          {loading ? 'جاري التحميل...' : 'تحميل المستخدمين'}
        </button>
      </div>

      {error ? <p className="error-message">{error}</p> : null}

      {users.length === 0 ? (
        <p className="muted">لا توجد بيانات مستخدمين معروضة حتى الآن.</p>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>الاسم</th>
                <th>اسم المستخدم</th>
                <th>البريد الإلكتروني</th>
                <th>الفرع</th>
                <th>كود الفرع</th>
                <th>الأدوار</th>
                <th>الحالة</th>
              </tr>
            </thead>

            <tbody>
              {users.map((currentUser) => (
                <tr key={currentUser.id}>
                  <td>{currentUser.full_name}</td>

                  <td>{currentUser.username}</td>

                  <td>{currentUser.email || '-'}</td>

                  <td>{currentUser.branch_name || 'كل الفروع'}</td>

                  <td>{currentUser.branch_code || '-'}</td>

                  <td>
                    {currentUser.roles.length > 0
                      ? currentUser.roles.join(', ')
                      : 'بدون دور'}
                  </td>

                  <td>{currentUser.is_active ? 'نشط' : 'غير نشط'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default UsersPage
