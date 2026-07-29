// assert تحتوي على أدوات التأكد من أن النتيجة الفعلية
// مطابقة للنتيجة التي نتوقعها داخل كل اختبار.
import assert from 'node:assert/strict'

// describe تجمع اختبارات الجزء نفسه تحت اسم واضح.
//
// it تمثل حالة اختبار واحدة مستقلة.
import { describe, it } from 'node:test'

// نستورد الدوال الحقيقية المستخدمة داخل Authentication.
//
// hashPassword:
// تحول كلمة المرور إلى Scrypt Hash آمن قبل تخزينها.
//
// verifyPassword:
// تقارن كلمة المرور المدخلة بالـHash المخزن
// وتعيد true أو false بدون كشف كلمة المرور الأصلية.
import {
  hashPassword,
  verifyPassword,
} from '../../services/api/src/modules/auth/password'

// نجمع كل اختبارات كلمات المرور تحت Suite واحدة.
//
// ظهور اسم Suite في نتيجة الاختبار يجعل معرفة
// الجزء الذي فشل أسهل عند زيادة عدد الاختبارات لاحقًا.
describe('password security', () => {
  // ====================================================
  // اختبار إنشاء Password Hash
  //
  // الهدف:
  // 1. التأكد من استخدام Scrypt بالإعدادات الحالية.
  // 2. التأكد من وجود Salt وDerived Key.
  // 3. التأكد من عدم تخزين كلمة المرور داخل الناتج.
  // ====================================================
  it('hashes a valid password without storing the original value', async () => {
    const password = 'SafePassword-123'

    // ننفذ نفس الدالة المستخدمة عند إنشاء أو تغيير
    // كلمة مرور المستخدم داخل النظام.
    const storedHash = await hashPassword(password)

    // شكل القيمة المتوقع:
    //
    // scrypt$N$r$p$salt$derivedKey
    //
    // الاختبار يثبت أن الإعدادات الحالية هي:
    // N = 16384
    // r = 8
    // p = 1
    //
    // كما يتأكد أن Salt وDerived Key مكتوبان بصيغة Hex.
    assert.match(storedHash, /^scrypt\$16384\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/)

    // كلمة المرور الأصلية يجب ألا تظهر نهائيًا
    // داخل القيمة التي سيتم تخزينها في PostgreSQL.
    assert.equal(storedHash.includes(password), false)
  })

  // ====================================================
  // اختبار الـSalt العشوائي
  //
  // حتى لو استخدم شخصان كلمة المرور نفسها،
  // يجب ألا تكون قيمة الـHash المخزنة متطابقة.
  //
  // اختلاف النتائج يمنع كشف المستخدمين الذين
  // يستعملون كلمات المرور نفسها.
  // ====================================================
  it('uses a unique salt for every generated hash', async () => {
    const firstHash = await hashPassword('SafePassword-123')
    const secondHash = await hashPassword('SafePassword-123')

    // لو كانت القيمتان متساويتين، فهذا يعني أن
    // الـSalt ليس عشوائيًا أو لا يتم استخدامه بصورة صحيحة.
    assert.notEqual(firstHash, secondHash)
  })

  // ====================================================
  // اختبار التحقق من كلمة المرور
  //
  // نختبر المسارين الأساسيين:
  // 1. كلمة المرور الصحيحة يتم قبولها.
  // 2. كلمة المرور الخاطئة يتم رفضها.
  // ====================================================
  it('accepts the correct password and rejects a wrong password', async () => {
    const storedHash = await hashPassword('SafePassword-123')

    // نفس كلمة المرور يجب أن تنجح.
    const correctPasswordResult = await verifyPassword(
      'SafePassword-123',
      storedHash,
    )

    assert.equal(correctPasswordResult, true)

    // كلمة مرور مختلفة يجب ألا تنجح.
    const wrongPasswordResult = await verifyPassword(
      'WrongPassword-123',
      storedHash,
    )

    assert.equal(wrongPasswordResult, false)
  })

  // ====================================================
  // اختبار البيانات التالفة أو القديمة
  //
  // قاعدة البيانات قد تحتوي بالخطأ على قيمة تالفة،
  // أو قد يرسل مهاجم قيمة غير متوقعة.
  //
  // verifyPassword يجب أن تعيد false بأمان
  // بدل إسقاط Login API بخطأ داخلي.
  // ====================================================
  it('rejects malformed stored hashes without throwing', async () => {
    const malformedHashes = [
      // قيمة فارغة.
      '',

      // كلمة مرور عادية وليست Hash.
      'plain-text-password',

      // خوارزمية غير مدعومة.
      'bcrypt$16384$8$1$salt$key',

      // إعداد N غير رقمي.
      'scrypt$invalid$8$1$00$00',

      // Salt وKey ليسا Hex صالحًا.
      'scrypt$16384$8$1$not-hex$not-hex',
    ]

    // نختبر كل قيمة تالفة بصورة مستقلة.
    for (const storedHash of malformedHashes) {
      const result = await verifyPassword('SafePassword-123', storedHash)

      assert.equal(result, false)
    }
  })

  // ====================================================
  // اختبار الحد الأدنى لطول كلمة المرور
  //
  // النظام يشترط 8 أحرف على الأقل.
  // كلمة المرور الأقصر يجب أن تُرفض قبل Hashing.
  // ====================================================
  it('rejects passwords shorter than eight characters', async () => {
    await assert.rejects(() => hashPassword('short'), /at least 8 characters/)
  })

  // ====================================================
  // اختبار الحد الأقصى لطول كلمة المرور
  //
  // النظام يسمح بحد أقصى 128 حرفًا.
  //
  // وجود الحد يمنع إرسال كلمات ضخمة تستهلك موارد
  // Scrypt وتهدد أداء Login API.
  // ====================================================
  it('rejects passwords longer than 128 characters', async () => {
    const oversizedPassword = 'x'.repeat(129)

    await assert.rejects(
      () => hashPassword(oversizedPassword),
      /must not exceed 128 characters/,
    )
  })

  // ====================================================
  // اختبار نوع القيمة وقت التشغيل
  //
  // TypeScript يمنع النوع الخاطئ أثناء التطوير،
  // لكن Backend قد يستقبل JSON غير صالح وقت التشغيل.
  //
  // لذلك يجب أن تحمي الدالة نفسها أيضًا.
  // ====================================================
  it('rejects non-string password values at runtime', async () => {
    const invalidPassword = 123456 as unknown as string

    await assert.rejects(
      () => hashPassword(invalidPassword),
      /Password must be a string/,
    )
  })
})
