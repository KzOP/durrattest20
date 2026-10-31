import type { IncomingMessage, ServerResponse } from 'node:http';

type ApiRequest = IncomingMessage & { body?: unknown };
type ApiResponse = ServerResponse & {
  status(code: number): ApiResponse;
  json(body: unknown): void;
};

type FirestoreValue = {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
};

type FirestoreDocument = {
  fields?: Record<string, FirestoreValue>;
};

function stringField(fields: Record<string, FirestoreValue>, name: string) {
  const value = fields[name]?.stringValue;
  return typeof value === 'string' ? value : '';
}

function numberField(fields: Record<string, FirestoreValue>, name: string) {
  const value = fields[name];
  const number = value?.doubleValue ?? Number(value?.integerValue);
  return Number.isFinite(number) ? number : 0;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function parseBody(body: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) as unknown : body;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authorization = req.headers.authorization;
  const idToken = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
  if (!idToken) return res.status(401).json({ error: 'Unauthorized' });

  const apiKey = process.env.VITE_FIREBASE_API_KEY;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!apiKey || !projectId || !botToken || !chatId) {
    return res.status(500).json({ error: 'Server notification settings are incomplete' });
  }

  const body = parseBody(req.body);
  const propertyId = body?.propertyId;
  if (typeof propertyId !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(propertyId)) {
    return res.status(400).json({ error: 'Invalid property ID' });
  }

  try {
    const identityResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    );
    if (!identityResponse.ok) return res.status(401).json({ error: 'Unauthorized' });
    const identity = await identityResponse.json() as { users?: Array<{ localId?: string; disabled?: boolean }> };
    const user = identity.users?.[0];
    const uid = user?.localId;
    if (!uid || user.disabled === true) return res.status(401).json({ error: 'Unauthorized' });

    const firestoreBase = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
    const firestoreHeaders = { Authorization: `Bearer ${idToken}` };
    const employeeResponse = await fetch(
      `${firestoreBase}/employees/${encodeURIComponent(uid)}`,
      { headers: firestoreHeaders },
    );
    if (!employeeResponse.ok) return res.status(403).json({ error: 'Active employee required' });
    const employee = await employeeResponse.json() as FirestoreDocument;
    const employeeFields = employee.fields ?? {};
    const role = stringField(employeeFields, 'role');
    if (employeeFields.active?.booleanValue !== true || !['employee', 'super_admin'].includes(role)) {
      return res.status(403).json({ error: 'Active employee required' });
    }

    const propertyResponse = await fetch(
      `${firestoreBase}/properties/${encodeURIComponent(propertyId)}`,
      { headers: firestoreHeaders },
    );
    if (!propertyResponse.ok) return res.status(404).json({ error: 'Property not found' });
    const property = await propertyResponse.json() as FirestoreDocument;
    const fields = property.fields ?? {};
    if (stringField(fields, 'created_by_staff_id') !== uid) {
      return res.status(403).json({ error: 'Property owner required' });
    }

    const title = stringField(fields, 'title') || 'عقار جديد';
    const propertyType = stringField(fields, 'property_type') || 'غير محدد';
    const listingType = stringField(fields, 'listing_type') === 'rent' ? 'للإيجار' : 'للبيع';
    const price = `${new Intl.NumberFormat('ar-SA').format(numberField(fields, 'price'))} ر.س`;
    const city = stringField(fields, 'city');
    const district = stringField(fields, 'district');
    const serialNumber = numberField(fields, 'serial_number');
    const message = [
      '<b>🏡 إعلان عقاري جديد</b>',
      `<b>${escapeHtml(title)}</b>`,
      `النوع: ${escapeHtml(propertyType)} — ${listingType}`,
      `السعر: ${price}`,
      city || district ? `الموقع: ${escapeHtml([city, district].filter(Boolean).join(' — '))}` : '',
      serialNumber ? `رقم الإعلان: ${new Intl.NumberFormat('ar-SA').format(serialNumber)}` : '',
    ].filter(Boolean).join('\n');

    const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const telegramResult = await telegramResponse.json() as { ok?: boolean };
    if (!telegramResponse.ok || telegramResult.ok !== true) {
      return res.status(502).json({ error: 'Telegram rejected the message' });
    }

    return res.status(200).json({ sent: true });
  } catch {
    return res.status(502).json({ error: 'Notification service unavailable' });
  }
}
