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
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};

type FirestoreDocument = {
  fields?: Record<string, FirestoreValue>;
};

const PRODUCTION_APP_URL = 'https://durrattest18.vercel.app';

function stringField(fields: Record<string, FirestoreValue>, name: string) {
  const value = fields[name]?.stringValue;
  return typeof value === 'string' ? value : '';
}

function firstTextField(fields: Record<string, FirestoreValue>, names: string[]) {
  for (const name of names) {
    const value = fields[name];
    if (typeof value?.stringValue === 'string' && value.stringValue.trim()) {
      return value.stringValue.trim();
    }
    if (typeof value?.integerValue === 'string') return value.integerValue;
    if (typeof value?.doubleValue === 'number' && Number.isFinite(value.doubleValue)) {
      return String(value.doubleValue);
    }
  }
  return '';
}

function numberField(fields: Record<string, FirestoreValue>, name: string) {
  const value = fields[name];
  const number = value?.doubleValue ?? Number(value?.integerValue);
  return Number.isFinite(number) ? number : 0;
}

function formatNumericText(value: string) {
  const number = Number(value);
  return value.trim() && Number.isFinite(number)
    ? new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 2 }).format(number)
    : value;
}

function areaText(fields: Record<string, FirestoreValue>) {
  const rawArea = firstTextField(fields, ['area']);
  if (!rawArea) return '';

  const numericArea = Number(rawArea);
  if (Number.isFinite(numericArea) && numericArea <= 0) return '';

  const alreadyHasUnit = /(?:م²|م2|متر|sqm|sq\.?\s*m|ft²|ft2|sq\.?\s*ft)/i.test(rawArea);
  return `${formatNumericText(rawArea)}${alreadyHasUnit ? '' : ' م²'}`;
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

function limitText(value: string, maxCharacters: number) {
  return Array.from(value.trim()).slice(0, maxCharacters).join('');
}

function isHttpsUrl(value: string) {
  if (value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function imageUrlFromValue(value?: FirestoreValue): string {
  if (!value) return '';

  const directValue = typeof value.stringValue === 'string' ? value.stringValue.trim() : '';
  if (directValue && isHttpsUrl(directValue)) return directValue;

  const nestedFields = value.mapValue?.fields;
  if (!nestedFields) return '';

  for (const key of ['url', 'imageUrl', 'image_url', 'src', 'downloadURL', 'downloadUrl']) {
    const candidate = nestedFields[key]?.stringValue?.trim() ?? '';
    if (candidate && isHttpsUrl(candidate)) return candidate;
  }
  return '';
}

function firstImageUrl(fields: Record<string, FirestoreValue>) {
  const singleImage = imageUrlFromValue(fields.imageUrl)
    || imageUrlFromValue(fields.image_url);
  if (singleImage) return singleImage;

  const imageList = fields.images?.arrayValue?.values ?? [];
  for (const image of imageList) {
    const candidate = imageUrlFromValue(image);
    if (candidate) return candidate;
  }
  return imageUrlFromValue(fields.images);
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
    const identity = await identityResponse.json() as {
      users?: Array<{ localId?: string; disabled?: boolean }>;
    };
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

    const title = limitText(stringField(fields, 'title') || 'عقار جديد', 140);
    const propertyType = limitText(stringField(fields, 'property_type') || 'غير محدد', 60);
    const listingType = stringField(fields, 'listing_type') === 'rent' ? 'للإيجار' : 'للبيع';
    const price = `${new Intl.NumberFormat('ar-SA').format(numberField(fields, 'price'))} ر.س`;
    const city = limitText(stringField(fields, 'city'), 60);
    const district = limitText(stringField(fields, 'district'), 60);
    const serialNumber = numberField(fields, 'serial_number');
    const area = areaText(fields);
    const detailsUrl = `${PRODUCTION_APP_URL}/?property=${encodeURIComponent(propertyId)}`;
    const normalizedType = propertyType.toLowerCase();
    const isApartment = normalizedType.includes('apartment')
      || propertyType.includes('شقة')
      || propertyType.includes('شقق');

    const apartmentLines = isApartment
      ? [
          ['غرف النوم', ['bedrooms', 'bedroom_count', 'rooms']],
          ['الصالات', ['lounges', 'living_rooms', 'halls']],
          ['المطابخ', ['kitchens', 'kitchen_count']],
          ['دورات المياه', ['bathrooms', 'bathroom_count', 'baths']],
        ].map(([label, keys]) => {
          const value = firstTextField(fields, keys as string[]);
          return value
            ? `${label}: ${escapeHtml(formatNumericText(value))}`
            : '';
        })
      : [];

    const message = [
      '<b>🏡 إعلان عقاري جديد</b>',
      `<b>${escapeHtml(title)}</b>`,
      `النوع: ${escapeHtml(propertyType)} — ${listingType}`,
      `السعر: ${price}`,
      area ? `المساحة: ${escapeHtml(area)}` : '',
      ...apartmentLines,
      city || district
        ? `الموقع: ${escapeHtml([city, district].filter(Boolean).join(' — '))}`
        : '',
      serialNumber
        ? `رقم الإعلان: ${new Intl.NumberFormat('ar-SA').format(serialNumber)}`
        : '',
      `<a href="${escapeHtml(detailsUrl)}">عرض تفاصيل العقار</a>`,
    ].filter(Boolean).join('\n');

    const imageUrl = firstImageUrl(fields);
    const telegramMethod = imageUrl ? 'sendPhoto' : 'sendMessage';
    const telegramPayload = imageUrl
      ? {
          chat_id: chatId,
          photo: imageUrl,
          caption: message,
          parse_mode: 'HTML',
        }
      : {
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        };

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/${telegramMethod}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(telegramPayload),
      },
    );
    const telegramResult = await telegramResponse.json() as { ok?: boolean };
    if (!telegramResponse.ok || telegramResult.ok !== true) {
      return res.status(502).json({ error: 'Telegram rejected the message' });
    }

    return res.status(200).json({ sent: true });
  } catch {
    return res.status(502).json({ error: 'Notification service unavailable' });
  }
}
