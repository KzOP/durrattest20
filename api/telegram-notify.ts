import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateStaff, bearerToken, firestoreDocumentsUrl } from '../server/staff-auth';

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

type RentPeriod = 'monthly' | 'annual' | 'two_installments';

const PRODUCTION_APP_URL = 'https://durrattest18.vercel.app';
const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_TEXT_LIMIT = 4096;

const rentPeriodPriceText: Record<RentPeriod, string> = {
  monthly: 'شهرياً',
  annual: 'سنوياً',
  two_installments: 'للدفعة الواحدة',
};

const rentPeriodLabelText: Record<RentPeriod, string> = {
  monthly: 'إيجار شهري',
  annual: 'إيجار سنوي',
  two_installments: 'إيجار على دفعتين',
};

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
  const rawArea = limitText(firstTextField(fields, ['area']), 30);
  if (!rawArea) return '';

  const numericArea = Number(rawArea);
  if (Number.isFinite(numericArea) && numericArea <= 0) return '';

  const alreadyHasUnit = /(?:م²|م2|متر|sqm|sq\.?\s*m|ft²|ft2|sq\.?\s*ft)/i.test(rawArea);
  return `${formatNumericText(rawArea)}${alreadyHasUnit ? '' : ' م²'}`;
}

function normalizedLabel(value: string) {
  return value.trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');
}

function isRentLabel(value: string) {
  return /(?:^|[^a-z])(?:rent|rental|lease)(?:$|[^a-z])|(?:ايجار|استئجار|شهري|شهر|سنوي|سنة)|(?:^|[^a-z])(?:monthly|month|annual|yearly|year)(?:$|[^a-z])/i.test(normalizedLabel(value));
}

function isSaleLabel(value: string) {
  return /(?:^|[^a-z])(?:sale|sell)(?:$|[^a-z])|بيع/i.test(normalizedLabel(value));
}

function rentPeriodFromFields(fields: Record<string, FirestoreValue>): RentPeriod {
  const value = stringField(fields, 'rent_period');
  if (value === 'monthly' || value === 'annual' || value === 'two_installments') return value;
  return 'annual';
}

function isRentListing(fields: Record<string, FirestoreValue>) {
  const listingFields = ['listing_type', 'listingType', 'subType', 'offerType', 'offer_type'];
  const values = listingFields.map((name) => stringField(fields, name).trim()).filter(Boolean);
  const recognized = values.find((value) => isRentLabel(value) || isSaleLabel(value));
  if (recognized) return isRentLabel(recognized);
  return values.some((value) => /(?:^|[^a-z])(?:monthly|month|annual|yearly|year)(?:$|[^a-z])|شهري|شهر|سنوي|سنة/i.test(normalizedLabel(value)));
}

function isApartmentType(propertyType: string) {
  const normalizedType = propertyType.toLowerCase();
  return normalizedType.includes('apartment') || propertyType.includes('شقة') || propertyType.includes('شقق');
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
  if (!value || value.length > 2048) return false;
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
    const candidate = nestedFields[key];
    const directCandidate = candidate?.stringValue?.trim() ?? '';
    if (directCandidate && isHttpsUrl(directCandidate)) return directCandidate;
    const nestedCandidate = imageUrlFromValue(candidate);
    if (nestedCandidate) return nestedCandidate;
  }
  return '';
}

function firstImageUrl(fields: Record<string, FirestoreValue>) {
  for (const name of ['imageUrl', 'image_url', 'imageURL', 'images', 'photos', 'imageUrls', 'photo']) {
    const value = fields[name];
    const candidates = value?.arrayValue?.values ?? (value ? [value] : []);
    for (const candidate of candidates) {
      const imageUrl = imageUrlFromValue(candidate);
      if (imageUrl) return imageUrl;
    }
  }
  return '';
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

async function sendTelegram(botToken: string, method: 'sendPhoto' | 'sendMessage', payload: Record<string, unknown>) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean };
    return response.ok && result.ok === true;
  } catch {
    return false;
  }
}

function buildMessage(fields: Record<string, FirestoreValue>, propertyId: string) {
  const title = limitText(stringField(fields, 'title') || 'عقار جديد', 140);
  const propertyType = limitText(stringField(fields, 'property_type') || 'غير محدد', 60);
  const isRent = isRentListing(fields);
  const rentPeriod = rentPeriodFromFields(fields);
  const listingLabel = isRent ? rentPeriodLabelText[rentPeriod] : 'للبيع';
  const priceValue = new Intl.NumberFormat('ar-SA').format(numberField(fields, 'price'));
  const priceSuffix = isRent ? ` ${rentPeriodPriceText[rentPeriod]}` : '';
  const city = limitText(stringField(fields, 'city'), 60);
  const district = limitText(stringField(fields, 'district'), 60);
  const serialNumber = numberField(fields, 'serial_number');
  const advertiserName = limitText(
    stringField(fields, 'publisher_name') || stringField(fields, 'created_by_name') || 'غير محدد',
    80,
  );
  const area = areaText(fields);
  const detailsUrl = `${PRODUCTION_APP_URL}/?property=${encodeURIComponent(propertyId)}`;

  const apartmentLines = isApartmentType(propertyType)
    ? [
        ['غرف النوم', ['bedrooms', 'bedroom_count', 'rooms']],
        ['الصالات', ['lounges', 'living_rooms', 'halls']],
        ['المطابخ', ['kitchens', 'kitchen_count']],
        ['دورات المياه', ['bathrooms', 'bathroom_count', 'baths']],
      ].flatMap(([label, keys]) => {
        const value = firstTextField(fields, keys as string[]);
        return value ? [`${label}: ${escapeHtml(formatNumericText(limitText(value, 30)))}`] : [];
      })
    : [];

  return [
    '<b>🏡 إعلان عقاري جديد</b>',
    `<b>${escapeHtml(title)}</b>`,
    `النوع: ${escapeHtml(propertyType)} — ${escapeHtml(listingLabel)}`,
    `السعر: ${escapeHtml(priceValue)} ر.س${escapeHtml(priceSuffix)}`,
    area ? `المساحة: ${escapeHtml(area)}` : '',
    ...apartmentLines,
    city || district
      ? `الموقع: ${escapeHtml([city, district].filter(Boolean).join(' — '))}`
      : '',
    '',
    `المعلن: ${escapeHtml(advertiserName)}`,
    serialNumber
      ? `رقم الإعلان: ${new Intl.NumberFormat('ar-SA').format(serialNumber)}`
      : '',
    `<a href="${escapeHtml(detailsUrl)}">معاينة العقار على الموقع</a>`,
  ].filter(Boolean).join('\n');
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const idToken = bearerToken(req.headers.authorization);
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
    const staff = await authenticateStaff(idToken, apiKey, projectId);
    if (!staff.ok) return res.status(staff.status).json({ error: staff.error });

    const propertyResponse = await fetch(
      `${firestoreDocumentsUrl(projectId)}/properties/${encodeURIComponent(propertyId)}`,
      { headers: { Authorization: `Bearer ${idToken}` } },
    );
    if (!propertyResponse.ok) return res.status(404).json({ error: 'Property not found' });
    const property = await propertyResponse.json() as FirestoreDocument;
    const fields = property.fields ?? {};
    if (stringField(fields, 'created_by_staff_id') !== staff.uid) {
      return res.status(403).json({ error: 'Property owner required' });
    }

    const message = buildMessage(fields, propertyId);
    const imageUrl = firstImageUrl(fields);

    if (imageUrl && message.length <= TELEGRAM_CAPTION_LIMIT) {
      const sentAsPhoto = await sendTelegram(botToken, 'sendPhoto', {
        chat_id: chatId,
        photo: imageUrl,
        caption: message,
        parse_mode: 'HTML',
      });
      if (sentAsPhoto) return res.status(200).json({ sent: true, method: 'sendPhoto' });
    }

    if (message.length > TELEGRAM_TEXT_LIMIT) {
      return res.status(502).json({ error: 'Notification message is too long' });
    }
    const sentAsText = await sendTelegram(botToken, 'sendMessage', {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (!sentAsText) return res.status(502).json({ error: 'Telegram rejected the message' });

    return res.status(200).json({ sent: true, method: 'sendMessage' });
  } catch {
    return res.status(502).json({ error: 'Notification service unavailable' });
  }
}
